import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { getDataDir } from '@/lib/data-dir'
import { ensureSchema, getSql } from '@/lib/db'
import path from 'path'
import type {
  StoredChatMessage,
  StoredConversation,
  UserAnalysis,
  UserData,
  UserPreferences,
} from '@/lib/user-types'
import { DEFAULT_WATCHLIST } from '@/lib/user-constants'
import { getPlanLimits } from '@/lib/plan-limits'
import { getRedis } from '@/lib/redis'
import { FINNHUB_SYMBOL_RE, normalizeSymbol } from '@/lib/symbols'

export type {
  StoredChatMessage,
  StoredConversation,
  UserAnalysis,
  UserData,
  UserPreferences,
} from '@/lib/user-types'

const MAX_ANALYSES = 25
/** Per scope. Each conversation is capped to keep the user record compact. */
const MAX_MESSAGES_PER_CONVERSATION = 40
/** Total number of distinct scopes we retain per user. */
const MAX_CONVERSATIONS = 12
/** Hard cap on a single message body (truncate to keep storage size bounded). */
const MAX_MESSAGE_CHARS = 8_000

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function userKey(email: string): string {
  return `ms:user:${createHash('sha256').update(normalizeEmail(email)).digest('hex')}`
}

function maxWatchlistForPlan(plan: string | undefined): number {
  const limit = getPlanLimits(plan).watchlistMax
  return limit < 0 ? 999 : limit
}

function sanitizeSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map(normalizeSymbol).filter((s) => FINNHUB_SYMBOL_RE.test(s)))]
}

function defaultUserData(email: string): UserData {
  const now = new Date().toISOString()
  return {
    email: normalizeEmail(email),
    watchlist: [...DEFAULT_WATCHLIST],
    favorites: [...DEFAULT_WATCHLIST],
    analyses: [],
    conversations: {},
    preferences: {},
    createdAt: now,
    updatedAt: now,
  }
}

async function readFromFile(email: string): Promise<UserData | null> {
  const filePath = path.join(
    getDataDir('users'),
    `${createHash('sha256').update(normalizeEmail(email)).digest('hex')}.json`
  )
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as UserData
    if (normalizeEmail(parsed.email) !== normalizeEmail(email)) return null
    return parsed
  } catch {
    return null
  }
}

async function writeToFile(data: UserData): Promise<boolean> {
  try {
    const dir = getDataDir('users')
    await mkdir(dir, { recursive: true })
    const filePath = path.join(
      dir,
      `${createHash('sha256').update(normalizeEmail(data.email)).digest('hex')}.json`
    )
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('user-store writeToFile failed:', err)
    return false
  }
}

async function readFromKv(email: string): Promise<UserData | null> {
  const redis = getRedis()
  if (!redis) return null
  try {
    const parsed = await redis.get<UserData>(userKey(email))
    if (!parsed || normalizeEmail(parsed.email) !== normalizeEmail(email)) return null
    return parsed
  } catch {
    return null
  }
}

async function writeToKv(data: UserData): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return false
  try {
    await redis.set(userKey(data.email), data)
    return true
  } catch {
    return false
  }
}

async function readFromDb(email: string): Promise<UserData | null> {
  const sql = getSql()
  if (!sql) return null
  try {
    if (!(await ensureSchema())) return null
    const rows = (await sql`
      SELECT data
      FROM ms_user_data
      WHERE email = ${normalizeEmail(email)}
      LIMIT 1
    `) as Array<{ data: UserData }>
    const row = rows[0]
    if (!row?.data) return null
    const parsed = row.data
    if (normalizeEmail(parsed.email) !== normalizeEmail(email)) return null
    return parsed
  } catch (err) {
    console.error('user-store readFromDb failed:', err)
    return null
  }
}

async function writeToDb(data: UserData): Promise<boolean> {
  const sql = getSql()
  if (!sql) return false
  try {
    if (!(await ensureSchema())) return false
    await sql`
      INSERT INTO ms_user_data (email, data, updated_at)
      VALUES (${data.email}, ${data}, ${data.updatedAt})
      ON CONFLICT (email) DO UPDATE SET
        data = EXCLUDED.data,
        updated_at = EXCLUDED.updated_at
    `
    return true
  } catch (err) {
    console.error('user-store writeToDb failed:', err)
    return false
  }
}

/** Ensure the authenticated user can only access their own records. */
export function assertSameUser(sessionEmail: string, resourceEmail: string): void {
  if (normalizeEmail(sessionEmail) !== normalizeEmail(resourceEmail)) {
    throw new Error('FORBIDDEN')
  }
}

export async function getUserData(email: string): Promise<UserData> {
  const normalized = normalizeEmail(email)
  const fromKv = await readFromKv(normalized)
  if (fromKv) return migrateUserData(fromKv)

  const fromDb = await readFromDb(normalized)
  if (fromDb) return migrateUserData(fromDb)

  const fromFile = await readFromFile(normalized)
  if (fromFile) return migrateUserData(fromFile)

  const fresh = defaultUserData(normalized)
  try {
    await saveUserData(fresh)
  } catch {
    /* offline - return in-memory profile */
  }
  return fresh
}

function migrateUserData(data: UserData): UserData {
  const watchlist = sanitizeSymbols(data.watchlist)
  const favorites = sanitizeSymbols(data.favorites ?? watchlist.slice(0, 2))
  return {
    ...data,
    watchlist: watchlist.length ? watchlist : [...DEFAULT_WATCHLIST],
    favorites: favorites.filter((s) => watchlist.includes(s)),
    conversations: data.conversations ?? {},
    preferences: data.preferences ?? {},
    createdAt: data.createdAt ?? data.updatedAt,
  }
}

export async function saveUserData(data: UserData): Promise<void> {
  const normalized = normalizeEmail(data.email)
  const maxWatchlist = maxWatchlistForPlan(data.plan)
  const watchlist = sanitizeSymbols(data.watchlist).slice(0, maxWatchlist)
  const favorites = sanitizeSymbols(data.favorites ?? []).filter((s) => watchlist.includes(s))

  const payload: UserData = {
    ...data,
    email: normalized,
    watchlist,
    favorites,
    analyses: data.analyses.slice(0, MAX_ANALYSES),
    conversations: data.conversations ?? {},
    preferences: data.preferences ?? {},
    createdAt: data.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  const wroteKv = await writeToKv(payload)
  if (wroteKv) return

  const wroteDb = await writeToDb(payload)
  if (wroteDb) return

  await writeToFile(payload)
}

/** Load or initialize user profile without failing auth when storage is unavailable. */
export async function ensureUserData(email: string): Promise<UserData> {
  try {
    return await getUserData(email)
  } catch (err) {
    console.error('ensureUserData failed:', err)
    return defaultUserData(email)
  }
}

export async function updateWatchlist(
  email: string,
  watchlist: string[],
  favorites?: string[]
): Promise<UserData> {
  const data = await getUserData(email)
  const maxWatchlist = maxWatchlistForPlan(data.plan)
  data.watchlist = sanitizeSymbols(watchlist).slice(0, maxWatchlist)
  if (favorites !== undefined) {
    data.favorites = sanitizeSymbols(favorites).filter((s) => data.watchlist.includes(s))
  } else {
    data.favorites = (data.favorites ?? []).filter((s) => data.watchlist.includes(s))
  }
  await saveUserData(data)
  return data
}

export async function patchWatchlist(
  email: string,
  action: 'add' | 'remove' | 'toggleFavorite',
  symbol: string
): Promise<UserData> {
  const data = await getUserData(email)
  const sym = normalizeSymbol(symbol)
  if (!FINNHUB_SYMBOL_RE.test(sym)) {
    throw new Error('INVALID_SYMBOL')
  }

  const maxWatchlist = maxWatchlistForPlan(data.plan)
  const favorites = [...(data.favorites ?? [])]
  let watchlist = [...data.watchlist]

  if (action === 'add') {
    if (!watchlist.includes(sym)) {
      if (watchlist.length >= maxWatchlist) throw new Error('WATCHLIST_FULL')
      watchlist.push(sym)
    }
  } else if (action === 'remove') {
    watchlist = watchlist.filter((s) => s !== sym)
    const favIdx = favorites.indexOf(sym)
    if (favIdx >= 0) favorites.splice(favIdx, 1)
    if (watchlist.length === 0) throw new Error('WATCHLIST_EMPTY')
  } else if (action === 'toggleFavorite') {
    if (!watchlist.includes(sym)) {
      if (watchlist.length >= maxWatchlist) throw new Error('WATCHLIST_FULL')
      watchlist.push(sym)
      favorites.unshift(sym)
    } else {
      const idx = favorites.indexOf(sym)
      if (idx >= 0) favorites.splice(idx, 1)
      else favorites.unshift(sym)
    }
  }

  data.watchlist = watchlist
  data.favorites = favorites.filter((s) => watchlist.includes(s))
  await saveUserData(data)
  return data
}

export async function addUserAnalysis(
  email: string,
  analysis: Omit<UserAnalysis, 'id' | 'createdAt'>
): Promise<UserData> {
  const data = await getUserData(email)
  const entry: UserAnalysis = {
    ...analysis,
    id: `a-${Date.now()}`,
    createdAt: new Date().toISOString(),
  }
  data.analyses = [entry, ...data.analyses].slice(0, MAX_ANALYSES)
  await saveUserData(data)
  return data
}

// ───────────────────────────────────────────────────────────────────────────
// Conversations (per-user agent chat history)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Scopes look like `chart:AAPL`, `insights:MARKET`. We allow safe characters
 * and a single colon as a separator. Anything else is rejected to keep keys
 * predictable across storage tiers.
 */
const SCOPE_RE = /^[a-z]+:[A-Za-z0-9:_./-]{1,80}$/

export function isValidConversationScope(scope: string): boolean {
  return SCOPE_RE.test(scope)
}

function sanitizeMessage(m: StoredChatMessage): StoredChatMessage | null {
  if (!m || typeof m !== 'object') return null
  if (m.role !== 'user' && m.role !== 'assistant') return null
  const content = typeof m.content === 'string' ? m.content.slice(0, MAX_MESSAGE_CHARS) : ''
  if (!content && !m.setup) return null
  return {
    id: typeof m.id === 'string' && m.id ? m.id : `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: m.role,
    content,
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date().toISOString(),
    setup: m.setup,
    levels: Array.isArray(m.levels) ? m.levels.slice(0, 50) : undefined,
    zones: Array.isArray(m.zones) ? m.zones.slice(0, 50) : undefined,
    drawIntent: typeof m.drawIntent === 'boolean' ? m.drawIntent : null,
    model: typeof m.model === 'string' ? m.model.slice(0, 80) : undefined,
  }
}

export async function getConversation(
  email: string,
  scope: string
): Promise<StoredConversation | null> {
  if (!isValidConversationScope(scope)) return null
  const data = await getUserData(email)
  return data.conversations?.[scope] ?? null
}

export async function listConversations(
  email: string
): Promise<StoredConversation[]> {
  const data = await getUserData(email)
  const list = Object.values(data.conversations ?? {})
  return list.sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  )
}

export async function saveConversation(
  email: string,
  scope: string,
  messages: StoredChatMessage[],
  title?: string
): Promise<StoredConversation | null> {
  if (!isValidConversationScope(scope)) return null
  const data = await getUserData(email)

  const cleaned = (messages || [])
    .map(sanitizeMessage)
    .filter((m): m is StoredChatMessage => m !== null)
    .slice(-MAX_MESSAGES_PER_CONVERSATION)

  const conversations = { ...(data.conversations ?? {}) }
  const conv: StoredConversation = {
    scope,
    title: title?.slice(0, 80),
    messages: cleaned,
    updatedAt: new Date().toISOString(),
  }
  conversations[scope] = conv

  // If we exceeded the max, drop the least-recently-updated scopes.
  const entries = Object.entries(conversations)
  if (entries.length > MAX_CONVERSATIONS) {
    entries.sort(
      (a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt)
    )
    const trimmed = Object.fromEntries(entries.slice(0, MAX_CONVERSATIONS))
    data.conversations = trimmed
  } else {
    data.conversations = conversations
  }

  try {
    await saveUserData(data)
  } catch (err) {
    console.warn('saveConversation: persist failed, returning in-memory copy:', err)
  }
  return conv
}

export async function clearConversation(
  email: string,
  scope: string
): Promise<boolean> {
  if (!isValidConversationScope(scope)) return false
  const data = await getUserData(email)
  if (!data.conversations?.[scope]) return true
  const conversations = { ...data.conversations }
  delete conversations[scope]
  data.conversations = conversations
  await saveUserData(data)
  return true
}

export async function clearAllConversations(email: string): Promise<void> {
  const data = await getUserData(email)
  data.conversations = {}
  await saveUserData(data)
}

// ───────────────────────────────────────────────────────────────────────────
// Preferences
// ───────────────────────────────────────────────────────────────────────────

const ALLOWED_PREFERENCE_KEYS = new Set<keyof UserPreferences>([
  'agentVerbosity',
  'agentAutoDraw',
  'timezone',
  'defaultTimeframe',
  'lastChartSymbol',
])

function sanitizePreferences(prefs: Partial<UserPreferences>): UserPreferences {
  const out: UserPreferences = {}
  for (const [k, v] of Object.entries(prefs || {})) {
    if (!ALLOWED_PREFERENCE_KEYS.has(k as keyof UserPreferences)) continue
    if (k === 'agentVerbosity') {
      if (v === 'concise' || v === 'detailed') out.agentVerbosity = v
    } else if (k === 'agentAutoDraw') {
      if (typeof v === 'boolean') out.agentAutoDraw = v
    } else if (k === 'timezone' && typeof v === 'string') {
      out.timezone = v.slice(0, 60)
    } else if (k === 'defaultTimeframe' && typeof v === 'string') {
      out.defaultTimeframe = v.slice(0, 8)
    } else if (k === 'lastChartSymbol' && typeof v === 'string') {
      out.lastChartSymbol = v.trim().toUpperCase().slice(0, 24)
    }
  }
  return out
}

export async function updatePreferences(
  email: string,
  patch: Partial<UserPreferences>
): Promise<UserData> {
  const data = await getUserData(email)
  data.preferences = {
    ...(data.preferences ?? {}),
    ...sanitizePreferences(patch),
  }
  await saveUserData(data)
  return data
}

