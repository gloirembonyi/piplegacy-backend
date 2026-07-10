import { NextResponse } from "next/server"
import { promises as fs } from "node:fs"
import { fetchQuote } from "@/lib/finnhub"
import { getGeminiApiKeys } from "@/lib/gemini"
import { getDeepseekApiKeys } from "@/lib/deepseek"
import { poolStatus } from "@/lib/gemini-keypool"
import { getRedis } from "@/lib/redis"
import { getDataDir } from "@/lib/data-dir"
import { isStripeConfigured, isGoogleAuthConfigured, isSessionConfigured } from "@/lib/env"
import { isAuthSession, requireAuth } from "@/lib/require-auth"

export const dynamic = "force-dynamic"

type ServiceStatus = "online" | "warning" | "offline"

type ServiceResult = {
  id: string
  name: string
  type: string
  status: ServiceStatus
  health: number
  latency: number
  detail?: string
}

const TIMEOUT_MS = 4000

async function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ])
}

/** Real Finnhub quote probe - measures live API latency and validates the payload. */
async function checkFinnhub(): Promise<ServiceResult> {
  const hasKey = Boolean(process.env.FINNHUB_API_KEY?.trim())
  const start = Date.now()
  const q = await withTimeout(fetchQuote("SPY"))
  const latency = Date.now() - start
  if (!q || !q.c) {
    return {
      id: "finnhub",
      name: "Market Data API",
      type: "Finnhub · quotes & calendar",
      status: hasKey ? "warning" : "offline",
      health: hasKey ? 55 : 0,
      latency,
      detail: hasKey ? "No quote returned" : "FINNHUB_API_KEY missing",
    }
  }
  const slow = latency > 1500
  return {
    id: "finnhub",
    name: "Market Data API",
    type: "Finnhub · quotes & calendar",
    status: slow ? "warning" : "online",
    health: slow ? 80 : 98,
    latency,
    detail: `SPY ${q.c.toFixed(2)}`,
  }
}

/** Gemini + DeepSeek key pool snapshot. */
function checkAiEngine(): ServiceResult {
  const geminiCount = getGeminiApiKeys().length
  const deepseekCount = getDeepseekApiKeys().length
  const geminiPool = poolStatus('gemini')
  const deepseekPool = poolStatus('deepseek')
  const configured = geminiCount > 0 || deepseekCount > 0
  const ready = geminiPool.ready + deepseekPool.ready
  const total = geminiCount + deepseekCount

  let status: ServiceStatus = 'offline'
  if (configured && ready > 0) status = 'online'
  else if (configured) status = 'warning'

  const parts: string[] = []
  if (geminiCount > 0) parts.push(`Gemini ${geminiPool.ready}/${geminiCount}`)
  if (deepseekCount > 0) parts.push(`DeepSeek ${deepseekPool.ready}/${deepseekCount}`)
  const detail = configured
    ? parts.join(' · ') || 'Keys configured'
    : 'GEMINI_API_KEY or DEEPSEEK_API_KEY missing'

  return {
    id: 'gemini',
    name: 'AI Engine',
    type: 'Gemini + DeepSeek · chat agent',
    status,
    health: !configured ? 0 : ready > 0 ? 96 : 45,
    latency: 0,
    detail,
  }
}

/** Live Redis ping if Upstash is configured. */
async function checkRedis(): Promise<ServiceResult> {
  const client = getRedis()
  if (!client) {
    return {
      id: "redis",
      name: "Cache & KV",
      type: "Upstash Redis",
      status: "offline",
      health: 0,
      latency: 0,
      detail: "Not configured (optional)",
    }
  }
  const start = Date.now()
  try {
    const pong = await withTimeout(client.ping(), 2000)
    const latency = Date.now() - start
    if (pong !== "PONG") {
      return {
        id: "redis",
        name: "Cache & KV",
        type: "Upstash Redis",
        status: "warning",
        health: 70,
        latency,
        detail: "Ping returned unexpected value",
      }
    }
    return {
      id: "redis",
      name: "Cache & KV",
      type: "Upstash Redis",
      status: latency > 1000 ? "warning" : "online",
      health: latency > 1000 ? 85 : 98,
      latency,
      detail: "PONG",
    }
  } catch (err) {
    return {
      id: "redis",
      name: "Cache & KV",
      type: "Upstash Redis",
      status: "warning",
      health: 50,
      latency: Date.now() - start,
      detail: err instanceof Error ? err.message.slice(0, 80) : "Ping failed",
    }
  }
}

/** Writable data directory probe - touches a marker file. */
async function checkStorage(): Promise<ServiceResult> {
  const start = Date.now()
  const dir = getDataDir("health")
  try {
    await fs.mkdir(dir, { recursive: true })
    const marker = `${dir}/touch.tmp`
    await fs.writeFile(marker, String(Date.now()), "utf8")
    await fs.unlink(marker)
    const latency = Date.now() - start
    return {
      id: "storage",
      name: "Local Storage",
      type: "Server disk · /tmp on Vercel",
      status: latency > 500 ? "warning" : "online",
      health: latency > 500 ? 88 : 99,
      latency,
      detail: process.env.VERCEL ? "/tmp/market-signal" : ".data/",
    }
  } catch (err) {
    return {
      id: "storage",
      name: "Local Storage",
      type: "Server disk",
      status: "warning",
      health: 40,
      latency: Date.now() - start,
      detail: err instanceof Error ? err.message.slice(0, 80) : "Write failed",
    }
  }
}

/** Authenticated session + secret strength - we know it's working because we got here. */
function checkAuthGateway(): ServiceResult {
  const sessionOk = isSessionConfigured()
  const googleOk = isGoogleAuthConfigured()
  return {
    id: "auth",
    name: "Auth Gateway",
    type: "Session · Google OAuth",
    status: sessionOk ? "online" : "warning",
    health: sessionOk && googleOk ? 99 : sessionOk ? 90 : 65,
    latency: 0,
    detail: googleOk ? "Google OAuth ready" : "Email-only auth",
  }
}

/** Stripe billing - env presence + publishable key sanity. */
function checkStripe(): ServiceResult {
  const ok = isStripeConfigured()
  return {
    id: "stripe",
    name: "Billing",
    type: "Stripe · checkout",
    status: ok ? "online" : "offline",
    health: ok ? 96 : 0,
    latency: 0,
    detail: ok ? "Configured" : "Stripe keys missing",
  }
}

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Live probe of every backend service (market data, AI keys, cache, storage, billing)
 *     tags: [System]
 *     responses:
 *       200:
 *         description: Service statuses + summary
 *       401:
 *         description: Unauthorized
 */
export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const start = Date.now()

  const [finnhub, redis, storage] = await Promise.all([
    checkFinnhub(),
    checkRedis(),
    checkStorage(),
  ])

  const services: ServiceResult[] = [
    finnhub,
    checkAiEngine(),
    checkAuthGateway(),
    redis,
    storage,
    checkStripe(),
  ]

  // Optional services (offline + intentionally so) shouldn't count against attention.
  const isOptionalOffline = (s: ServiceResult) =>
    s.status === "offline" && (s.id === "redis" || s.id === "stripe")

  const online = services.filter((s) => s.status === "online").length
  const needsAttention = services.filter(
    (s) => s.status !== "online" && !isOptionalOffline(s)
  ).length

  const considered = services.filter((s) => !isOptionalOffline(s))
  const avgHealth = considered.length
    ? Math.round(considered.reduce((a, s) => a + s.health, 0) / considered.length)
    : 0

  return NextResponse.json({
    services,
    summary: {
      online,
      total: services.length,
      needsAttention,
      uptime: `${avgHealth}%`,
      checkedInMs: Date.now() - start,
    },
    timestamp: new Date().toISOString(),
  })
}
