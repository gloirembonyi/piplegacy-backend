import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { rateLimit } from '@/lib/rate-limit'
import { isValidSymbol, normalizeSymbol } from '@/lib/symbols'
import { runAiSetupForSymbol } from '@/lib/trade-watch-ai-setup'
import { listTradeWatchAlerts } from '@/lib/trade-watch-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

type Body = {
  symbol?: string
  force?: boolean
}

export async function POST(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const rl = await rateLimit(`trade-watch:setup:${auth.email}`, 20, 300)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Rate limit reached.' }, { status: 429 })
  }

  const body = (await request.json().catch(() => ({}))) as Body
  const symbol = body.symbol ? normalizeSymbol(body.symbol) : ''
  if (!symbol || !isValidSymbol(symbol)) {
    return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 })
  }

  try {
    const result = await runAiSetupForSymbol(auth.email, symbol, {
      force: body.force ?? false,
    })
    const alerts = await listTradeWatchAlerts(auth.email, { limit: 30 })
    if (!result.setup) {
      return NextResponse.json({
        ...result,
        alerts,
        unread: alerts.filter((a) => !a.read).length,
        error: result.reply
          ? 'Agent finished but no valid entry/stop/target levels'
          : 'No trade setup returned',
      })
    }
    return NextResponse.json({
      ...result,
      alerts,
      unread: alerts.filter((a) => !a.read).length,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'AI setup failed'
    if (msg === 'PLAN_UPGRADE_REQUIRED') {
      return NextResponse.json({ error: msg, upgradeRequired: true }, { status: 403 })
    }
    if (msg.includes('limit')) {
      return NextResponse.json({ error: msg, upgradeRequired: true }, { status: 429 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
