/**
 * Persist armed trade setups per user (KV → DB → file).
 */

import { createHash } from 'crypto'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { getDataDir } from '@/lib/data-dir'
import { ensureSchema, getSql } from '@/lib/db'
import { getRedis } from '@/lib/redis'
import { getPlanLimits, isUnlimited } from '@/lib/plan-limits'
import { getUserData } from '@/lib/user-store'
import type {
  ArmPendingInput,
  PendingSetup,
  PendingSetupBook,
} from '@/lib/pending-setup-types'

const DEFAULT_TTL_HOURS = 24

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function emailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex')
}

function kvKey(email: string): string {
  return `ms:bot:pending:${emailHash(email)}`
}

function filePath(email: string): string {
  return path.join(getDataDir('bot'), `${emailHash(email)}.pending.json`)
}

async function readFromKv(email: string): Promise<PendingSetupBook | null> {
  const r = getRedis()
  if (!r) return null
  try {
    return await r.get<PendingSetupBook>(kvKey(email))
  } catch {
    return null
  }
}

async function writeToKv(book: PendingSetupBook): Promise<boolean> {
  const r = getRedis()
  if (!r) return false
  try {
    await r.set(kvKey(book.email), book)
    return true
  } catch {
    return false
  }
}

let schemaReady: Promise<boolean> | null = null
async function ensurePendingSchema(): Promise<boolean> {
  try {
    if (!(await ensureSchema())) return false
  } catch {
    return false
  }
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getSql()
      if (!sql) return false
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS ms_bot_pending (
            email TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `
        return true
      } catch (err) {
        console.error('pending-setup CREATE TABLE failed:', err)
        schemaReady = null
        return false
      }
    })()
  }
  return schemaReady
}

async function readFromDb(email: string): Promise<PendingSetupBook | null> {
  const sql = getSql()
  if (!sql) return null
  if (!(await ensurePendingSchema())) return null
  try {
    const rows = (await sql`
      SELECT data FROM ms_bot_pending WHERE email = ${normalizeEmail(email)} LIMIT 1
    `) as Array<{ data: PendingSetupBook }>
    return rows[0]?.data ?? null
  } catch {
    return null
  }
}

async function writeToDb(book: PendingSetupBook): Promise<boolean> {
  const sql = getSql()
  if (!sql) return false
  if (!(await ensurePendingSchema())) return false
  try {
    await sql`
      INSERT INTO ms_bot_pending (email, data, updated_at)
      VALUES (${book.email}, ${book}, ${book.updatedAt})
      ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
    `
    return true
  } catch {
    return false
  }
}

async function readFromFile(email: string): Promise<PendingSetupBook | null> {
  try {
    return JSON.parse(await readFile(filePath(email), 'utf-8')) as PendingSetupBook
  } catch {
    return null
  }
}

async function writeToFile(book: PendingSetupBook): Promise<boolean> {
  try {
    await mkdir(getDataDir('bot'), { recursive: true })
    await writeFile(filePath(book.email), JSON.stringify(book, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('pending-setup writeToFile failed:', err)
    return false
  }
}

export async function getPendingBook(email: string): Promise<PendingSetupBook> {
  const normalized = normalizeEmail(email)
  const fromKv = await readFromKv(normalized)
  if (fromKv) return fromKv
  const fromDb = await readFromDb(normalized)
  if (fromDb) return fromDb
  const fromFile = await readFromFile(normalized)
  if (fromFile) return fromFile
  return { email: normalized, setups: [], updatedAt: new Date().toISOString() }
}

async function saveBook(book: PendingSetupBook): Promise<void> {
  book.email = normalizeEmail(book.email)
  book.updatedAt = new Date().toISOString()
  if (await writeToKv(book)) return
  if (await writeToDb(book)) return
  await writeToFile(book)
}

function expireStale(setups: PendingSetup[]): PendingSetup[] {
  const now = Date.now()
  return setups.map((s) => {
    if (s.status !== 'armed') return s
    if (Date.parse(s.expiresAt) > now) return s
    return { ...s, status: 'expired' as const, updatedAt: new Date().toISOString() }
  })
}

export async function listPendingSetups(
  email: string,
  opts: { status?: PendingSetup['status'] | 'active' } = {}
): Promise<PendingSetup[]> {
  const book = await getPendingBook(email)
  let setups = expireStale(book.setups)
  if (opts.status === 'active') {
    setups = setups.filter((s) => s.status === 'armed' || s.status === 'triggered')
  } else if (opts.status) {
    setups = setups.filter((s) => s.status === opts.status)
  }
  return setups.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export async function getPendingSetup(
  email: string,
  id: string
): Promise<PendingSetup | null> {
  const book = await getPendingBook(email)
  return book.setups.find((s) => s.id === id) ?? null
}

/** Arm a setup - replaces any existing armed setup for the same symbol+timeframe. */
export async function armPendingSetup(
  email: string,
  input: ArmPendingInput
): Promise<PendingSetup> {
  const { setup } = input
  if (setup.bias === 'HOLD' || setup.entry == null || setup.stopLoss == null) {
    throw new Error('Cannot arm a HOLD setup or one missing entry/stop')
  }

  const user = await getUserData(email)
  const maxArmed = getPlanLimits(user.plan).pendingSetupsMax
  if (maxArmed === 0) {
    throw new Error('PLAN_UPGRADE_REQUIRED')
  }

  const book = await getPendingBook(email)
  const armedCount = expireStale(book.setups).filter((s) => s.status === 'armed').length
  const replacingSame =
    book.setups.some(
      (s) =>
        s.status === 'armed' &&
        s.symbol === setup.symbol &&
        s.timeframe === setup.timeframe
    )
  if (!isUnlimited(maxArmed) && armedCount >= maxArmed && !replacingSame) {
    throw new Error('PENDING_SETUP_LIMIT')
  }

  const now = new Date()
  const expiresAt = setup.validUntil ?? new Date(now.getTime() + DEFAULT_TTL_HOURS * 3600_000).toISOString()

  const pending: PendingSetup = {
    id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    symbol: setup.symbol,
    symbolLabel: setup.symbolLabel,
    timeframe: setup.timeframe,
    bias: setup.bias,
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    confluenceScore: setup.confluenceScore,
    reasoning: setup.reasoning,
    riskPct: input.riskPct ?? setup.suggestedRiskPct ?? 1,
    brokerId: input.brokerId,
    mode: input.mode ?? 'paper',
    strategyId: input.strategyId ?? null,
    status: 'armed',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt,
    armedPrice: input.armedPrice ?? null,
    lastPrice: input.armedPrice ?? null,
    triggeredAt: null,
    filledAt: null,
    orderId: null,
    cancelReason: null,
  }

  // One armed setup per symbol+timeframe - cancel the old one.
  book.setups = expireStale(book.setups).map((s) => {
    if (
      s.status === 'armed' &&
      s.symbol === pending.symbol &&
      s.timeframe === pending.timeframe
    ) {
      return {
        ...s,
        status: 'cancelled' as const,
        cancelReason: 'Replaced by newer setup',
        updatedAt: now.toISOString(),
      }
    }
    return s
  })

  const historyCap = isUnlimited(maxArmed) ? 50 : Math.max(maxArmed * 3, 10)
  book.setups = [pending, ...book.setups].slice(0, historyCap)
  await saveBook(book)
  return pending
}

export async function cancelPendingSetup(
  email: string,
  id: string,
  reason = 'Cancelled by user'
): Promise<PendingSetup | null> {
  const book = await getPendingBook(email)
  const idx = book.setups.findIndex((s) => s.id === id)
  if (idx < 0) return null
  const s = book.setups[idx]
  if (s.status !== 'armed' && s.status !== 'triggered') return s
  book.setups[idx] = {
    ...s,
    status: 'cancelled',
    cancelReason: reason,
    updatedAt: new Date().toISOString(),
  }
  await saveBook(book)
  return book.setups[idx]
}

export async function patchPendingSetup(
  email: string,
  id: string,
  patch: Partial<PendingSetup>
): Promise<PendingSetup | null> {
  const book = await getPendingBook(email)
  const idx = book.setups.findIndex((s) => s.id === id)
  if (idx < 0) return null
  book.setups[idx] = {
    ...book.setups[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  await saveBook(book)
  return book.setups[idx]
}

/** Emails that have at least one armed/triggered pending setup. */
export async function listEmailsWithActivePending(): Promise<string[]> {
  const emails = new Set<string>()

  const r = getRedis()
  if (r) {
    try {
      let cursor: string | number = 0
      do {
        const res = (await r.scan(cursor, {
          match: 'ms:bot:pending:*',
          count: 200,
        })) as [string | number, string[]]
        const [next, keys] = res
        cursor = next
        if (keys.length > 0) {
          const values = (await r.mget<Array<PendingSetupBook | null>>(...keys)) ?? []
          for (const v of values) {
            if (!v?.email) continue
            if (v.setups.some((s) => s.status === 'armed' || s.status === 'triggered')) {
              emails.add(v.email)
            }
          }
        }
      } while (Number(cursor) !== 0)
      if (emails.size > 0) return [...emails]
    } catch {
      /* fall through */
    }
  }

  const sql = getSql()
  if (sql && (await ensurePendingSchema())) {
    try {
      const rows = (await sql`SELECT email, data FROM ms_bot_pending`) as Array<{
        email: string
        data: PendingSetupBook
      }>
      for (const row of rows) {
        if (row.data?.setups?.some((s) => s.status === 'armed' || s.status === 'triggered')) {
          emails.add(row.email)
        }
      }
      if (emails.size > 0) return [...emails]
    } catch {
      /* fall through */
    }
  }

  try {
    const dir = getDataDir('bot')
    const files = await readdir(dir).catch(() => [] as string[])
    for (const f of files) {
      if (!f.endsWith('.pending.json')) continue
      try {
        const data = JSON.parse(await readFile(path.join(dir, f), 'utf-8')) as PendingSetupBook
        if (data.email && data.setups?.some((s) => s.status === 'armed' || s.status === 'triggered')) {
          emails.add(data.email)
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }

  return [...emails]
}
