/**
 * Per-user auto-trader configuration store (server-only).
 *
 * Holds the list of bot strategies (each = symbol + timeframe + execution rules)
 * and the kill-switch state. Persisted via KV → DB → file (same pattern as
 * `lib/credentials-store.ts`).
 *
 * SAFETY: every strategy defaults to `paper` mode and `enabled=false`. A
 * strategy is only ever executed by the cron scanner when BOTH `enabled` is
 * true AND the kill-switch isn't tripped.
 *
 * NOTE: pure types + constants live in `lib/bot-config-types.ts` so client
 * components can import them without dragging Node-only modules in.
 */

import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { getDataDir } from '@/lib/data-dir'
import { ensureSchema, getSql } from '@/lib/db'
import { getRedis } from '@/lib/redis'
import type {
  BotConfig,
  BotStrategy,
  KillSwitch,
} from '@/lib/bot-config-types'

export {
  STRATEGY_TIMEFRAMES,
  strategyIsRunnable,
  tfCadenceMinutes,
} from '@/lib/bot-config-types'
export type {
  BotConfig,
  BotStrategy,
  KillSwitch,
  StrategyTimeframe,
} from '@/lib/bot-config-types'

const DEFAULT_KILL_SWITCH: KillSwitch = {
  dailyLossPct: 3,
  tripped: false,
  trippedDate: null,
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function emailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex')
}

function kvKey(email: string): string {
  return `ms:bot:cfg:${emailHash(email)}`
}

function filePath(email: string): string {
  return path.join(getDataDir('bot'), `${emailHash(email)}.cfg.json`)
}

async function readFromFile(email: string): Promise<BotConfig | null> {
  try {
    return JSON.parse(await readFile(filePath(email), 'utf-8')) as BotConfig
  } catch {
    return null
  }
}

async function writeToFile(cfg: BotConfig): Promise<boolean> {
  try {
    await mkdir(getDataDir('bot'), { recursive: true })
    await writeFile(filePath(cfg.email), JSON.stringify(cfg, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('bot-config writeToFile failed:', err)
    return false
  }
}

async function readFromKv(email: string): Promise<BotConfig | null> {
  const r = getRedis()
  if (!r) return null
  try {
    return await r.get<BotConfig>(kvKey(email))
  } catch {
    return null
  }
}

async function writeToKv(cfg: BotConfig): Promise<boolean> {
  const r = getRedis()
  if (!r) return false
  try {
    await r.set(kvKey(cfg.email), cfg)
    return true
  } catch {
    return false
  }
}

let botSchemaReady: Promise<boolean> | null = null
async function ensureBotSchema(): Promise<boolean> {
  try {
    if (!(await ensureSchema())) return false
  } catch (err) {
    console.error('bot-config ensureSchema failed:', err)
    return false
  }
  if (!botSchemaReady) {
    botSchemaReady = (async () => {
      const sql = getSql()
      if (!sql) return false
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS ms_bot_config (
            email TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `
        return true
      } catch (err) {
        console.error('bot-config CREATE TABLE failed:', err)
        return false
      }
    })()
  }
  return botSchemaReady
}

async function readFromDb(email: string): Promise<BotConfig | null> {
  const sql = getSql()
  if (!sql) return null
  if (!(await ensureBotSchema())) return null
  try {
    const rows = (await sql`
      SELECT data FROM ms_bot_config WHERE email = ${normalizeEmail(email)} LIMIT 1
    `) as Array<{ data: BotConfig }>
    return rows[0]?.data ?? null
  } catch (err) {
    console.error('bot-config readFromDb failed:', err)
    return null
  }
}

async function writeToDb(cfg: BotConfig): Promise<boolean> {
  const sql = getSql()
  if (!sql) return false
  if (!(await ensureBotSchema())) return false
  try {
    await sql`
      INSERT INTO ms_bot_config (email, data, updated_at)
      VALUES (${cfg.email}, ${cfg}, ${cfg.updatedAt})
      ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
    `
    return true
  } catch (err) {
    console.error('bot-config writeToDb failed:', err)
    return false
  }
}

function defaultConfig(email: string): BotConfig {
  return {
    email: normalizeEmail(email),
    strategies: [],
    killSwitch: { ...DEFAULT_KILL_SWITCH },
    updatedAt: new Date().toISOString(),
  }
}

export async function getBotConfig(email: string): Promise<BotConfig> {
  const normalized = normalizeEmail(email)
  const fromKv = await readFromKv(normalized)
  if (fromKv) return migrate(fromKv)
  const fromDb = await readFromDb(normalized)
  if (fromDb) return migrate(fromDb)
  const fromFile = await readFromFile(normalized)
  if (fromFile) return migrate(fromFile)
  return defaultConfig(normalized)
}

function migrate(cfg: BotConfig): BotConfig {
  return {
    ...cfg,
    killSwitch: { ...DEFAULT_KILL_SWITCH, ...cfg.killSwitch },
    strategies: (cfg.strategies ?? []).map((s) => ({
      ...s,
      confluenceThreshold: clamp01to100(s.confluenceThreshold, 65),
      riskPct: clampRange(s.riskPct, 0.1, 5, 1),
      maxConcurrent: clampRange(s.maxConcurrent, 1, 10, 1),
    })),
  }
}

function clamp01to100(n: unknown, fallback: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(0, Math.min(100, v))
}

function clampRange(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, v))
}

export async function saveBotConfig(cfg: BotConfig): Promise<void> {
  cfg.email = normalizeEmail(cfg.email)
  cfg.updatedAt = new Date().toISOString()
  if (await writeToKv(cfg)) return
  if (await writeToDb(cfg)) return
  await writeToFile(cfg)
}

export async function upsertStrategy(
  email: string,
  patch: Partial<BotStrategy> & { id?: string }
): Promise<BotStrategy> {
  const cfg = await getBotConfig(email)
  const id = patch.id ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const existing = cfg.strategies.find((s) => s.id === id)
  const merged: BotStrategy = {
    id,
    name: patch.name ?? existing?.name ?? `${patch.symbol ?? existing?.symbol ?? 'NEW'} ${patch.timeframe ?? existing?.timeframe ?? '1h'}`,
    symbol: (patch.symbol ?? existing?.symbol ?? '').toUpperCase(),
    timeframe: patch.timeframe ?? existing?.timeframe ?? '1h',
    brokerId: patch.brokerId ?? existing?.brokerId ?? 'alpaca',
    mode: patch.mode ?? existing?.mode ?? 'paper',
    enabled: patch.enabled ?? existing?.enabled ?? false,
    confluenceThreshold: clamp01to100(
      patch.confluenceThreshold ?? existing?.confluenceThreshold,
      65
    ),
    riskPct: clampRange(patch.riskPct ?? existing?.riskPct, 0.1, 5, 1),
    maxConcurrent: clampRange(patch.maxConcurrent ?? existing?.maxConcurrent, 1, 10, 1),
    windowStart: patch.windowStart ?? existing?.windowStart,
    windowEnd: patch.windowEnd ?? existing?.windowEnd,
    lastScanAt: patch.lastScanAt ?? existing?.lastScanAt ?? null,
    lastOrderAt: patch.lastOrderAt ?? existing?.lastOrderAt ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }
  if (!merged.symbol) {
    throw new Error('Strategy must have a symbol')
  }
  if (existing) {
    cfg.strategies = cfg.strategies.map((s) => (s.id === id ? merged : s))
  } else {
    cfg.strategies.push(merged)
  }
  await saveBotConfig(cfg)
  return merged
}

export async function removeStrategy(email: string, id: string): Promise<void> {
  const cfg = await getBotConfig(email)
  cfg.strategies = cfg.strategies.filter((s) => s.id !== id)
  await saveBotConfig(cfg)
}

export async function tripKillSwitch(
  email: string,
  reason: string
): Promise<void> {
  const cfg = await getBotConfig(email)
  cfg.killSwitch = {
    ...cfg.killSwitch,
    tripped: true,
    trippedDate: new Date().toISOString().slice(0, 10),
    reason,
  }
  await saveBotConfig(cfg)
}

export async function resetKillSwitch(email: string): Promise<void> {
  const cfg = await getBotConfig(email)
  cfg.killSwitch = {
    ...cfg.killSwitch,
    tripped: false,
    trippedDate: null,
    reason: null,
  }
  await saveBotConfig(cfg)
}
