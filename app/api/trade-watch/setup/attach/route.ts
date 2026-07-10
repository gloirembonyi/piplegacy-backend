import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { rateLimit } from '@/lib/rate-limit'
import { isValidSymbol, normalizeSymbol, displaySymbolLabel } from '@/lib/symbols'
import { listTradeWatchAlerts } from '@/lib/trade-watch-store'
import {
  chatSetupToAlertSetup,
  formatAlertSetupDetail,
} from '@/lib/trade-watch-setup'
import type { MarketChatSetup } from '@/lib/parse-market-chat-json'
import {
  attachSetupToSymbolAlerts,
  getTradeWatchBook,
  hasRecentAlert,
  pushTradeWatchAlert,
} from '@/lib/trade-watch-store'

export const dynamic = 'force-dynamic'

type Body = {
  symbol?: string
  setup?: MarketChatSetup | null
  reply?: string
}

function chartHref(symbol: string): string {
  return `/app?view=chart&symbol=${encodeURIComponent(symbol)}&panel=signals`
}

/** Persist a chart-agent setup onto Trade Watch alerts (after client agent run). */
export async function POST(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const rl = await rateLimit(`trade-watch:attach:${auth.email}`, 30, 300)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Rate limit reached.' }, { status: 429 })
  }

  const body = (await request.json().catch(() => ({}))) as Body
  const symbol = body.symbol ? normalizeSymbol(body.symbol) : ''
  if (!symbol || !isValidSymbol(symbol)) {
    return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 })
  }

  const alertSetup = chatSetupToAlertSetup(body.setup, {
    symbol,
    reply: body.reply,
  })
  if (!alertSetup) {
    return NextResponse.json(
      { error: 'No valid BUY/SELL setup to attach' },
      { status: 422 }
    )
  }

  const book = await getTradeWatchBook(auth.email)
  await attachSetupToSymbolAlerts(auth.email, symbol, alertSetup)

  if (!hasRecentAlert(book.alerts, symbol, 'setup')) {
    await pushTradeWatchAlert(auth.email, {
      symbol,
      kind: 'setup',
      severity: (alertSetup.confluenceScore ?? 0) >= 70 ? 'critical' : 'warning',
      title: `${displaySymbolLabel(symbol)} - ${alertSetup.bias} setup`,
      detail: formatAlertSetupDetail(alertSetup),
      setup: alertSetup,
      href: chartHref(symbol),
    })
  }

  const alerts = await listTradeWatchAlerts(auth.email, { limit: 30 })
  return NextResponse.json({
    symbol,
    setup: alertSetup,
    alerts,
    unread: alerts.filter((a) => !a.read).length,
  })
}

