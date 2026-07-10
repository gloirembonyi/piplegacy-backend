import { randomBytes } from 'crypto'
import { getRedis, isRedisConfigured } from '@/lib/redis'
import type { SessionUser } from '@/lib/session-token'

// Short-lived, single-use codes that bridge the Google OAuth redirect (which must land on an
// http(s) URL) to the piplegacy-desktop app (which can only be reached via a custom URI scheme
// deep link). The code carries no secrets itself — it's just a claim ticket the desktop app
// exchanges for a bearer session token via POST /api/auth/desktop/exchange.
const CODE_TTL_SECONDS = 120
const CODE_PREFIX = 'ms:desktop-code:'

// Dev-only fallback when Redis/KV isn't configured. Not viable across serverless invocations in
// production, but keeps local dev working without Upstash — matches this repo's existing
// tiered-storage-degrades-gracefully pattern.
const memoryStore = new Map<string, { user: SessionUser; expiresAt: number }>()

function pruneMemoryStore() {
  const now = Date.now()
  for (const [key, entry] of memoryStore) {
    if (entry.expiresAt < now) memoryStore.delete(key)
  }
}

export async function mintDesktopExchangeCode(user: SessionUser): Promise<string> {
  const code = randomBytes(32).toString('base64url')
  const redis = getRedis()

  if (redis) {
    await redis.set(`${CODE_PREFIX}${code}`, JSON.stringify(user), { ex: CODE_TTL_SECONDS })
    return code
  }

  pruneMemoryStore()
  memoryStore.set(code, { user, expiresAt: Date.now() + CODE_TTL_SECONDS * 1000 })
  return code
}

/** Single-use: the code is deleted whether or not it was found/valid. */
export async function consumeDesktopExchangeCode(code: string): Promise<SessionUser | null> {
  if (!code) return null
  const redis = getRedis()

  if (redis) {
    const key = `${CODE_PREFIX}${code}`
    const raw = await redis.get<string>(key)
    await redis.del(key)
    if (!raw) return null
    try {
      return JSON.parse(raw) as SessionUser
    } catch {
      return null
    }
  }

  pruneMemoryStore()
  const entry = memoryStore.get(code)
  memoryStore.delete(code)
  if (!entry || entry.expiresAt < Date.now()) return null
  return entry.user
}

export function isDesktopAuthDurable(): boolean {
  return isRedisConfigured()
}
