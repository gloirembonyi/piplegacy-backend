import { NextResponse } from 'next/server'
import { runAiHealthCheck, resetKeyPool } from '@/lib/ai-health'
import { buildAdminUsageReport } from '@/lib/ai-admin-metrics'
import { getAiConfigStatus } from '@/lib/ai-config'
import { aiCallSlotStats } from '@/lib/ai-call-limiter'
import { isAuthSession } from '@/lib/require-auth'
import { requireAdmin } from '@/lib/require-admin'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!isAuthSession(auth)) return auth

  const url = new URL(request.url)
  const live = url.searchParams.get('live') === '1'

  const [report, config, usage] = await Promise.all([
    runAiHealthCheck({ probeLive: live }),
    Promise.resolve(getAiConfigStatus()),
    buildAdminUsageReport(),
  ])

  return NextResponse.json({ report, config, usage, aiCallSlots: aiCallSlotStats() })
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request)
  if (!isAuthSession(auth)) return auth

  let action = 'reset'
  try {
    const body = await request.json()
    if (body && typeof body === 'object' && 'action' in body) {
      action = String((body as { action: unknown }).action)
    }
  } catch {
    /* default reset */
  }

  if (action === 'reset') {
    resetKeyPool()
    return NextResponse.json({
      ok: true,
      message: 'Key pool cooldowns cleared.',
    })
  }

  if (action === 'reset-gemini') {
    resetKeyPool('gemini')
    return NextResponse.json({ ok: true, message: 'Gemini cooldowns cleared.' })
  }

  if (action === 'reset-deepseek') {
    resetKeyPool('deepseek')
    return NextResponse.json({ ok: true, message: 'DeepSeek cooldowns cleared.' })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
