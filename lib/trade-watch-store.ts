/**
 * Persist Trade Watch config + alerts per user (KV → DB → file).
 */

import { createHash, randomUUID } from 'crypto'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { getDataDir } from '@/lib/data-dir'
import { ensureSchema, getSql } from '@/lib/db'
import { getRedis } from '@/lib/redis'
import {
  ALERT_CAP,
  ALERT_DEDUPE_MS,
  DEFAULT_TRADE_WATCH_CONFIG,
  type TradeWatchAlert,
  type TradeWatchBook,
  type TradeWatchConfig,
} from '@/lib/trade-watch-types'
import { alertDedupeKey } from '@/lib/trade-watch-engine'
import { displaySymbolLabel, resolveQuoteSymbol } from '@/lib/symbols'
import { formatAlertSetupDetail } from '@/lib/trade-watch-setup'

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function emailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex')
}

function kvKey(email: string): string {
  return `ms:trade-watch:${emailHash(email)}`
}

function filePath(email: string): string {
  return path.join(getDataDir('bot'), `${emailHash(email)}.tradewatch.json`)
}

async function readFromKv(email: string): Promise<TradeWatchBook | null> {
  const r = getRedis()
  if (!r) return null
  try {
    return await r.get<TradeWatchBook>(kvKey(email))
  } catch {
    return null
  }
}

async function writeToKv(book: TradeWatchBook): Promise<boolean> {
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
async function ensureTradeWatchSchema(): Promise<boolean> {
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
          CREATE TABLE IF NOT EXISTS ms_trade_watch (
            email TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `
        return true
      } catch (err) {
        console.error('trade-watch CREATE TABLE failed:', err)
        schemaReady = null
        return false
      }
    })()
  }
  return schemaReady
}

async function readFromDb(email: string): Promise<TradeWatchBook | null> {
  const sql = getSql()
  if (!sql) return null
  if (!(await ensureTradeWatchSchema())) return null
  try {
    const rows = (await sql`
      SELECT data FROM ms_trade_watch WHERE email = ${normalizeEmail(email)} LIMIT 1
    `) as Array<{ data: TradeWatchBook }>
    return rows[0]?.data ?? null
  } catch {
    return null
  }
}

async function writeToDb(book: TradeWatchBook): Promise<boolean> {
  const sql = getSql()
  if (!sql) return false
  if (!(await ensureTradeWatchSchema())) return false
  try {
    await sql`
      INSERT INTO ms_trade_watch (email, data, updated_at)
      VALUES (${book.email}, ${book}, ${book.updatedAt})
      ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
    `
    return true
  } catch {
    return false
  }
}

async function readFromFile(email: string): Promise<TradeWatchBook | null> {
  try {
    return JSON.parse(await readFile(filePath(email), 'utf-8')) as TradeWatchBook
  } catch {
    return null
  }
}

async function writeToFile(book: TradeWatchBook): Promise<boolean> {
  try {
    await mkdir(getDataDir('bot'), { recursive: true })
    await writeFile(filePath(book.email), JSON.stringify(book, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('trade-watch writeToFile failed:', err)
    return false
  }
}

export async function getTradeWatchBook(email: string): Promise<TradeWatchBook> {
  const normalized = normalizeEmail(email)
  const fromKv = await readFromKv(normalized)
  if (fromKv) return fromKv
  const fromDb = await readFromDb(normalized)
  if (fromDb) return fromDb
  const fromFile = await readFromFile(normalized)
  if (fromFile) return fromFile
  return {
    email: normalized,
    config: { ...DEFAULT_TRADE_WATCH_CONFIG, pairStates: {} },
    alerts: [],
    updatedAt: new Date().toISOString(),
  }
}

async function saveBook(book: TradeWatchBook): Promise<void> {
  book.email = normalizeEmail(book.email)
  book.updatedAt = new Date().toISOString()
  if (book.alerts.length > ALERT_CAP) {
    book.alerts = book.alerts
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, ALERT_CAP)
  }
  if (await writeToKv(book)) return
  if (await writeToDb(book)) return
  await writeToFile(book)
}

export async function getTradeWatchConfig(email: string): Promise<TradeWatchConfig> {
  const book = await getTradeWatchBook(email)
  return book.config
}

export async function updateTradeWatchConfig(
  email: string,
  patch: Partial<Omit<TradeWatchConfig, 'pairStates'>>
): Promise<TradeWatchConfig> {
  const book = await getTradeWatchBook(email)
  book.config = {
    ...book.config,
    ...patch,
    pairStates: book.config.pairStates,
  }
  await saveBook(book)
  return book.config
}

export async function savePairStates(
  email: string,
  pairStates: Record<string, import('@/lib/trade-watch-types').PairScanState>
): Promise<void> {
  const book = await getTradeWatchBook(email)
  book.config.pairStates = pairStates
  await saveBook(book)
}

function pruneExpiredAlerts(alerts: TradeWatchAlert[]): TradeWatchAlert[] {
  const now = Date.now()
  return alerts.filter((a) => {
    if (!a.expiresAt) return true
    return Date.parse(a.expiresAt) > now
  })
}

export async function listTradeWatchAlerts(
  email: string,
  opts: { unreadOnly?: boolean; limit?: number } = {}
): Promise<TradeWatchAlert[]> {
  const book = await getTradeWatchBook(email)
  let alerts = pruneExpiredAlerts(book.alerts)
  if (opts.unreadOnly) alerts = alerts.filter((a) => !a.read)
  alerts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  if (opts.limit != null) alerts = alerts.slice(0, opts.limit)
  return alerts
}

export function hasRecentAlert(
  alerts: TradeWatchAlert[],
  symbol: string,
  kind: TradeWatchAlert['kind'],
  windowMs = ALERT_DEDUPE_MS
): boolean {
  const key = alertDedupeKey(symbol, kind)
  const cutoff = Date.now() - windowMs
  return alerts.some(
    (a) =>
      alertDedupeKey(a.symbol, a.kind) === key &&
      Date.parse(a.createdAt) >= cutoff
  )
}

export async function pushTradeWatchAlert(
  email: string,
  alert: Omit<TradeWatchAlert, 'id' | 'read' | 'createdAt'>
): Promise<TradeWatchAlert | null> {
  const book = await getTradeWatchBook(email)
  if (hasRecentAlert(book.alerts, alert.symbol, alert.kind)) {
    return null
  }
  const full: TradeWatchAlert = {
    ...alert,
    id: randomUUID(),
    read: false,
    createdAt: new Date().toISOString(),
  }
  book.alerts.unshift(full)
  await saveBook(book)
  return full
}

export async function markTradeWatchAlertRead(
  email: string,
  alertId: string
): Promise<boolean> {
  const book = await getTradeWatchBook(email)
  const idx = book.alerts.findIndex((a) => a.id === alertId)
  if (idx < 0) return false
  book.alerts[idx] = { ...book.alerts[idx], read: true }
  await saveBook(book)
  return true
}

export async function patchTradeWatchAlert(
  email: string,
  alertId: string,
  patch: Partial<Pick<TradeWatchAlert, 'setup' | 'kind' | 'title' | 'detail' | 'severity'>>
): Promise<TradeWatchAlert | null> {
  const book = await getTradeWatchBook(email)
  const idx = book.alerts.findIndex((a) => a.id === alertId)
  if (idx < 0) return null
  book.alerts[idx] = { ...book.alerts[idx], ...patch }
  await saveBook(book)
  return book.alerts[idx]
}

/** Attach AI setup to the latest unread signal for a symbol. */
export async function attachSetupToSymbolAlerts(
  email: string,
  symbol: string,
  setup: NonNullable<TradeWatchAlert['setup']>
): Promise<TradeWatchAlert[]> {
  const book = await getTradeWatchBook(email)
  const symKey = resolveQuoteSymbol(symbol)
  const updated: TradeWatchAlert[] = []
  book.alerts = book.alerts.map((a) => {
    if (a.read || resolveQuoteSymbol(a.symbol) !== symKey) return a
    if (a.kind !== 'movement' && a.kind !== 'breakout' && a.kind !== 'setup') return a
    const next: TradeWatchAlert = {
      ...a,
      setup,
      kind: setup.bias === 'HOLD' ? a.kind : 'setup',
      title: a.title.includes('setup')
        ? a.title
        : `${displaySymbolLabel(symbol)} - ${setup.bias} setup`,
      detail: formatAlertSetupDetail(setup),
    }
    updated.push(next)
    return next
  })
  if (updated.length > 0) await saveBook(book)
  return updated
}

export async function markAllTradeWatchAlertsRead(email: string): Promise<number> {
  const book = await getTradeWatchBook(email)
  let count = 0
  book.alerts = book.alerts.map((a) => {
    if (a.read) return a
    count++
    return { ...a, read: true }
  })
  if (count > 0) await saveBook(book)
  return count
}

export async function listEmailsWithEnabledTradeWatch(): Promise<string[]> {
  const emails = new Set<string>()

  const r = getRedis()
  if (r) {
    try {
      const keys = await r.keys('ms:trade-watch:*')
      for (const key of keys.slice(0, 200)) {
        const book = await r.get<TradeWatchBook>(key)
        if (book?.config.enabled && book.email) emails.add(book.email)
      }
    } catch {
      /* fall through */
    }
  }

  const sql = getSql()
  if (sql && (await ensureTradeWatchSchema())) {
    try {
      const rows = (await sql`
        SELECT email, data FROM ms_trade_watch LIMIT 500
      `) as Array<{ email: string; data: TradeWatchBook }>
      for (const row of rows) {
        if (row.data?.config?.enabled) emails.add(row.email)
      }
    } catch {
      /* ignore */
    }
  }

  try {
    const dir = getDataDir('bot')
    const files = await readdir(dir)
    for (const f of files) {
      if (!f.endsWith('.tradewatch.json')) continue
      try {
        const book = JSON.parse(
          await readFile(path.join(dir, f), 'utf-8')
        ) as TradeWatchBook
        if (book.config?.enabled && book.email) emails.add(book.email)
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no dir */
  }

  return [...emails]
}
