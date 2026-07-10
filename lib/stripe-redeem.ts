import { getRedis } from '@/lib/redis'

const redeemedMemory = new Set<string>()

export async function markStripeSessionRedeemed(sessionId: string): Promise<boolean> {
  if (!sessionId.startsWith('cs_')) return false

  const redis = getRedis()
  if (redis) {
    const key = `stripe:redeemed:${sessionId}`
    const existing = await redis.get(key)
    if (existing) return false
    await redis.set(key, '1', { ex: 60 * 60 * 48 })
    return true
  }

  if (redeemedMemory.has(sessionId)) return false
  redeemedMemory.add(sessionId)
  return true
}
