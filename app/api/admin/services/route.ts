import { NextResponse } from 'next/server'
import { fetchQuote } from '@/lib/finnhub'
import { getAiConfigStatus } from '@/lib/ai-config'
import { poolStatus } from '@/lib/gemini-keypool'
import { isDeepseekConfigured } from '@/lib/deepseek'
import { isGeminiConfigured } from '@/lib/gemini'
import { getRedisSetupHint, isRedisConfigured, probeRedis } from '@/lib/redis'
import { getDataDir } from '@/lib/data-dir'
import { isStripeConfigured, isGoogleAuthConfigured, isSessionConfigured } from '@/lib/env'
import { isAuthSession } from '@/lib/require-auth'
import { requireAdmin } from '@/lib/require-admin'
import { probeScanPipelineHealth } from '@/lib/agent/pipeline-engine'
import { promises as fs } from 'node:fs'

export const dynamic = 'force-dynamic'

type ServiceStatus = 'online' | 'warning' | 'offline'

async function probeFinnhub() {
  const hasKey = Boolean(process.env.FINNHUB_API_KEY?.trim())
  const start = Date.now()
  const q = await Promise.race([
    fetchQuote('SPY'),
    new Promise<null>((r) => setTimeout(() => r(null), 5000)),
  ])
  const latency = Date.now() - start
  return {
    id: 'finnhub',
    name: 'Market Data',
    status: (q?.c ? 'online' : hasKey ? 'warning' : 'offline') as ServiceStatus,
    latency,
    detail: q?.c ? `SPY ${q.c.toFixed(2)}` : hasKey ? 'No quote' : 'FINNHUB_API_KEY missing',
  }
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!isAuthSession(auth)) return auth

  const [finnhub, redisPing, storageOk, scanPipeline] = await Promise.all([
    probeFinnhub(),
    probeRedis(),
    (async () => {
      try {
        const dir = getDataDir('health')
        await fs.mkdir(dir, { recursive: true })
        const f = `${dir}/admin-touch.tmp`
        await fs.writeFile(f, '1')
        await fs.unlink(f)
        return true
      } catch {
        return false
      }
    })(),
    probeScanPipelineHealth(),
  ])

  const geminiPool = poolStatus('gemini')
  const deepseekPool = poolStatus('deepseek')
  const aiConfig = getAiConfigStatus()
  const onVercel = process.env.VERCEL === '1'

  const redisStatus: ServiceStatus = redisPing.ok
    ? 'online'
    : redisPing.configured
      ? 'warning'
      : 'offline'

  const pipelineStatus: ServiceStatus = scanPipeline.ok
    ? 'online'
    : scanPipeline.legacyPythonEnabled
      ? 'warning'
      : 'offline'

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    deployment: {
      vercel: onVercel,
      region: process.env.VERCEL_REGION ?? null,
    },
    setup: {
      redisConfigured: isRedisConfigured(),
      redisHint: getRedisSetupHint(),
      pipelineEngine: scanPipeline.engine,
      pipelineSpecialists: scanPipeline.specialists,
      legacyPythonEnabled: scanPipeline.legacyPythonEnabled,
    },
    services: [
      finnhub,
      {
        id: 'gemini',
        name: 'Primary AI',
        status: (isGeminiConfigured()
          ? geminiPool.ready > 0
            ? 'online'
            : 'warning'
          : 'offline') as ServiceStatus,
        latency: 0,
        detail: `${geminiPool.ready}/${geminiPool.total} keys ready · Gemini`,
      },
      {
        id: 'deepseek',
        name: 'Fallback AI',
        status: (isDeepseekConfigured()
          ? deepseekPool.ready > 0
            ? 'online'
            : 'warning'
          : 'offline') as ServiceStatus,
        latency: 0,
        detail: `${deepseekPool.ready}/${deepseekPool.total} keys ready · DeepSeek`,
      },
      {
        id: 'redis',
        name: 'Redis / KV',
        status: redisStatus,
        latency: redisPing.latency,
        detail: redisPing.detail,
      },
      {
        id: 'storage',
        name: 'Writable storage',
        status: (storageOk ? 'online' : 'warning') as ServiceStatus,
        latency: 0,
        detail: process.env.VERCEL ? '/tmp/market-signal' : '.data/',
      },
      {
        id: 'scan-pipeline',
        name: 'Scan pipeline (TypeScript)',
        status: pipelineStatus,
        latency: scanPipeline.latency,
        detail: scanPipeline.detail,
      },
      {
        id: 'auth',
        name: 'Auth',
        status: (isSessionConfigured() ? 'online' : 'warning') as ServiceStatus,
        latency: 0,
        detail: isGoogleAuthConfigured() ? 'Session + OAuth' : 'Session only',
      },
      {
        id: 'stripe',
        name: 'Stripe',
        status: (isStripeConfigured() ? 'online' : 'offline') as ServiceStatus,
        latency: 0,
        detail: isStripeConfigured() ? 'Configured' : 'Not configured',
      },
    ],
    aiConfig,
    geminiPool,
    deepseekPool,
  })
}
