import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { getDataDir } from '@/lib/data-dir'
import { getRedis } from '@/lib/redis'

type MemoryEntry = { count: number; resetAt: number }
const memoryStore = new Map<string, MemoryEntry>()

type RateLimitResult = { ok: boolean; remaining: number; count: number }

function usageFilePath(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex')
  return path.join(getDataDir('usage'), `${hash}.json`)
}

async function readLocalEntry(key: string): Promise<MemoryEntry | null> {
  const cached = memoryStore.get(key)
  const now = Date.now()
  if (cached && cached.resetAt >= now) return cached

  try {
    const raw = await readFile(usageFilePath(key), 'utf-8')
    const parsed = JSON.parse(raw) as MemoryEntry
    if (
      typeof parsed.count !== 'number' ||
      typeof parsed.resetAt !== 'number' ||
      parsed.resetAt < now
    ) {
      return null
    }
    memoryStore.set(key, parsed)
    return parsed
  } catch {
    return null
  }
}

async function writeLocalEntry(key: string, entry: MemoryEntry): Promise<void> {
  memoryStore.set(key, entry)
  try {
    const dir = getDataDir('usage')
    await mkdir(dir, { recursive: true })
    await writeFile(usageFilePath(key), JSON.stringify(entry), 'utf-8')
  } catch (err) {
    console.warn('[rate-limit] local usage write failed:', err)
  }
}

async function readCount(key: string): Promise<number> {
  const redis = getRedis()
  if (redis) {
    try {
      const bucket = `rl:${key}`
      const raw = await redis.get<number | string>(bucket)
      const count = typeof raw === 'number' ? raw : Number(raw) || 0
      if (count > 0) {
        const ttl = await redis.ttl(bucket)
        // ttl -1 = no expiry set yet; only treat expired/missing keys as empty.
        if (ttl === 0 || ttl === -2) {
          await redis.del(bucket)
          return 0
        }
      }
      return count
    } catch (err) {
      console.warn('[rate-limit] redis read failed, falling back to local store:', err)
    }
  }

  const entry = await readLocalEntry(key)
  return entry?.count ?? 0
}

async function writeCount(key: string, count: number, windowSec: number): Promise<number> {
  const redis = getRedis()
  if (redis) {
    try {
      const bucket = `rl:${key}`
      await redis.set(bucket, count)
      await redis.expire(bucket, windowSec)
      return count
    } catch (err) {
      console.warn('[rate-limit] redis write failed, falling back to local store:', err)
    }
  }

  const resetAt = Date.now() + windowSec * 1000
  await writeLocalEntry(key, { count, resetAt })
  return count
}

/** Read current usage without incrementing. */
export async function peekRateLimit(
  key: string,
  limit: number,
  windowSec: number
): Promise<RateLimitResult> {
  void windowSec
  const count = await readCount(key)
  return {
    ok: count < limit,
    remaining: Math.max(0, limit - count),
    count,
  }
}

export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number
): Promise<RateLimitResult> {
  const redis = getRedis()
  if (redis) {
    try {
      const bucket = `rl:${key}`
      const count = await redis.incr(bucket)
      const ttl = await redis.ttl(bucket)
      if (ttl < 0) {
        await redis.expire(bucket, windowSec)
      }
      return { ok: count <= limit, remaining: Math.max(0, limit - count), count }
    } catch (err) {
      console.warn('[rate-limit] redis incr failed, falling back to local store:', err)
    }
  }

  const now = Date.now()
  const entry = await readLocalEntry(key)
  if (!entry || entry.resetAt < now) {
    const next = { count: 1, resetAt: now + windowSec * 1000 }
    await writeLocalEntry(key, next)
    return { ok: true, remaining: limit - 1, count: 1 }
  }

  entry.count += 1
  await writeLocalEntry(key, entry)
  return {
    ok: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    count: entry.count,
  }
}

/** Add an arbitrary amount to a rolling counter (e.g. token totals). */
export async function addUsageAmount(
  key: string,
  amount: number,
  windowSec: number
): Promise<number> {
  if (!Number.isFinite(amount) || amount <= 0) {
    return readCount(key)
  }

  const rounded = Math.round(amount)
  const redis = getRedis()
  if (redis) {
    try {
      const bucket = `rl:${key}`
      const count = await redis.incrby(bucket, rounded)
      const ttl = await redis.ttl(bucket)
      if (ttl < 0) {
        await redis.expire(bucket, windowSec)
      }
      return count
    } catch (err) {
      console.warn('[rate-limit] redis incrby failed, falling back to local store:', err)
    }
  }

  const now = Date.now()
  const entry = await readLocalEntry(key)
  if (!entry || entry.resetAt < now) {
    return writeCount(key, rounded, windowSec)
  }

  entry.count += rounded
  await writeLocalEntry(key, entry)
  return entry.count
}

/** Read a rolling counter total without modifying it. */
export async function readUsageAmount(key: string): Promise<number> {
  return readCount(key)
}

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown'
  return request.headers.get('x-real-ip')?.trim() || 'unknown'
}
