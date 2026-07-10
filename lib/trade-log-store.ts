/**
 * Bot activity log (server-only) - every scan, every proposed setup, every
 * order placed or rejected by the risk guard. Capped at 500 entries per user.
 *
 * Pure types live in `lib/trade-log-types.ts` so client components can
 * import them without dragging Node-only modules into the bundle.
 */

import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { getDataDir } from '@/lib/data-dir'
import { ensureSchema, getSql } from '@/lib/db'
import { getRedis } from '@/lib/redis'
import type {
  TradeLog,
  TradeLogEntry,
  TradeLogInput,
} from '@/lib/trade-log-types'

export type { TradeLog, TradeLogEntry, TradeLogInput } from '@/lib/trade-log-types'

const LOG_CAP = 500

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function emailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex')
}

function kvKey(email: string): string {
  return `ms:bot:log:${emailHash(email)}`
}

function filePath(email: string): string {
  return path.join(getDataDir('bot'), `${emailHash(email)}.log.json`)
}

async function readFromKv(email: string): Promise<TradeLog | null> {
  const r = getRedis()
  if (!r) return null
  try {
    return await r.get<TradeLog>(kvKey(email))
  } catch {
    return null
  }
}

async function writeToKv(log: TradeLog): Promise<boolean> {
  const r = getRedis()
  if (!r) return false
  try {
    await r.set(kvKey(log.email), log)
    return true
  } catch {
    return false
  }
}

let logSchemaReady: Promise<boolean> | null = null
async function ensureLogSchema(): Promise<boolean> {
  try {
    if (!(await ensureSchema())) return false
  } catch (err) {
    console.error('trade-log ensureSchema failed:', err)
    return false
  }
  if (!logSchemaReady) {
    logSchemaReady = (async () => {
      const sql = getSql()
      if (!sql) return false
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS ms_bot_log (
            email TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `
        return true
      } catch (err) {
        console.error('trade-log CREATE TABLE failed:', err)
        return false
      }
    })()
  }
  return logSchemaReady
}

async function readFromDb(email: string): Promise<TradeLog | null> {
  const sql = getSql()
  if (!sql) return null
  if (!(await ensureLogSchema())) return null
  try {
    const rows = (await sql`
      SELECT data FROM ms_bot_log WHERE email = ${normalizeEmail(email)} LIMIT 1
    `) as Array<{ data: TradeLog }>
    return rows[0]?.data ?? null
  } catch {
    return null
  }
}

async function writeToDb(log: TradeLog): Promise<boolean> {
  const sql = getSql()
  if (!sql) return false
  if (!(await ensureLogSchema())) return false
  try {
    await sql`
      INSERT INTO ms_bot_log (email, data, updated_at)
      VALUES (${log.email}, ${log}, ${log.updatedAt})
      ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
    `
    return true
  } catch {
    return false
  }
}

async function readFromFile(email: string): Promise<TradeLog | null> {
  try {
    return JSON.parse(await readFile(filePath(email), 'utf-8')) as TradeLog
  } catch {
    return null
  }
}

async function writeToFile(log: TradeLog): Promise<boolean> {
  try {
    await mkdir(getDataDir('bot'), { recursive: true })
    await writeFile(filePath(log.email), JSON.stringify(log, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('trade-log writeToFile failed:', err)
    return false
  }
}

export async function getTradeLog(email: string): Promise<TradeLog> {
  const normalized = normalizeEmail(email)
  const fromKv = await readFromKv(normalized)
  if (fromKv) return fromKv
  const fromDb = await readFromDb(normalized)
  if (fromDb) return fromDb
  const fromFile = await readFromFile(normalized)
  if (fromFile) return fromFile
  return { email: normalized, entries: [], updatedAt: new Date().toISOString() }
}

async function saveTradeLog(log: TradeLog): Promise<void> {
  log.email = normalizeEmail(log.email)
  log.updatedAt = new Date().toISOString()
  if (await writeToKv(log)) return
  if (await writeToDb(log)) return
  await writeToFile(log)
}

export async function appendTradeLog(
  email: string,
  entry: TradeLogInput
): Promise<TradeLogEntry> {
  const log = await getTradeLog(email)
  const full: TradeLogEntry = {
    ...entry,
    id: `l-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
  } as TradeLogEntry
  log.entries = [full, ...log.entries].slice(0, LOG_CAP)
  await saveTradeLog(log)
  return full
}

export async function listTradeLog(
  email: string,
  limit = 50
): Promise<TradeLogEntry[]> {
  const log = await getTradeLog(email)
  return log.entries.slice(0, Math.min(limit, LOG_CAP))
}
