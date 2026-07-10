import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { rateLimit } from '@/lib/rate-limit'
import { getUserData } from '@/lib/user-store'
import { isValidSymbol, normalizeSymbol } from '@/lib/symbols'
import {
  pushSessionAlertsIfNeeded,
  scanWatchlistForUser,
} from '@/lib/trade-watch-scan'
import { listTradeWatchAlerts } from '@/lib/trade-watch-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

type ScanBody = {
  symbol?: string
  force?: boolean
  runAi?: boolean
}

export async function POST(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const rl = await rateLimit(`trade-watch:scan:${auth.email}`, 30, 300)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Scan rate limit reached.' }, { status: 429 })
  }

  const body = (await request.json().catch(() => ({}))) as ScanBody
  const user = await getUserData(auth.email)
  const watchlist = user.watchlist ?? []

  let symbols = watchlist.map((s) => normalizeSymbol(s))
  if (body.symbol) {
    const sym = normalizeSymbol(body.symbol)
    if (!isValidSymbol(sym)) {
      return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 })
    }
    symbols = [sym]
  }

  if (symbols.length === 0) {
    return NextResponse.json(
      { error: 'Add symbols to your watchlist first.', code: 'EMPTY_WATCHLIST' },
      { status: 400 }
    )
  }

  const sessionAlerts = await pushSessionAlertsIfNeeded(auth.email, symbols)

  const result = await scanWatchlistForUser(auth.email, {
    symbols,
    force: body.force ?? false,
    runAi: body.runAi,
  })

  const alerts = await listTradeWatchAlerts(auth.email, { limit: 30 })

  return NextResponse.json({
    ...result,
    sessionAlerts,
    alerts,
    unread: alerts.filter((a) => !a.read).length,
  })
}
