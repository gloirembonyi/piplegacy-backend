import { Redis } from '@upstash/redis'

let client: Redis | null = null

function redisEnv(): { url: string; token: string } | null {
  const url = (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ''
  ).trim()
  const token = (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ''
  ).trim()
  if (!url || !token) return null
  return { url, token }
}

export function isRedisConfigured(): boolean {
  return redisEnv() !== null
}

/** Actionable hint when Redis/KV is missing (shown in admin Services). */
export function getRedisSetupHint(): string {
  if (process.env.VERCEL === '1') {
    return 'Vercel → Storage → Upstash Redis → Connect project (KV_REST_API_URL + KV_REST_API_TOKEN), then redeploy'
  }
  return 'Set KV_REST_API_URL and KV_REST_API_TOKEN from Upstash in .env.local'
}

export function getRedis(): Redis | null {
  if (client) return client
  const env = redisEnv()
  if (!env) return null
  client = new Redis({ url: env.url, token: env.token })
  return client
}

export type RedisProbeResult = {
  ok: boolean
  configured: boolean
  latency: number
  detail: string
}

/** Live ping + optional read/write smoke test for admin diagnostics. */
export async function probeRedis(): Promise<RedisProbeResult> {
  if (!isRedisConfigured()) {
    return {
      ok: false,
      configured: false,
      latency: 0,
      detail: getRedisSetupHint(),
    }
  }

  const redis = getRedis()
  if (!redis) {
    return {
      ok: false,
      configured: false,
      latency: 0,
      detail: 'Client init failed',
    }
  }

  const start = Date.now()
  try {
    const pong = await redis.ping()
    if (pong !== 'PONG') {
      return {
        ok: false,
        configured: true,
        latency: Date.now() - start,
        detail: `Unexpected ping: ${String(pong)}`,
      }
    }

    const probeKey = `ms:health:${Date.now()}`
    await redis.set(probeKey, '1', { ex: 30 })
    const val = await redis.get(probeKey)
    await redis.del(probeKey)

    return {
      ok: val === '1' || val === 1,
      configured: true,
      latency: Date.now() - start,
      detail: val === '1' || val === 1 ? 'PONG · read/write OK' : 'PONG · write/read failed',
    }
  } catch (err) {
    return {
      ok: false,
      configured: true,
      latency: Date.now() - start,
      detail: err instanceof Error ? err.message.slice(0, 120) : 'Ping failed',
    }
  }
}
