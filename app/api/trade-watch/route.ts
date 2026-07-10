import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { getUserData } from '@/lib/user-store'
import {
  getTradeWatchBook,
  listTradeWatchAlerts,
  markAllTradeWatchAlertsRead,
  markTradeWatchAlertRead,
  updateTradeWatchConfig,
} from '@/lib/trade-watch-store'
import type { TradeWatchConfig } from '@/lib/trade-watch-types'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const user = await getUserData(auth.email)
  const book = await getTradeWatchBook(auth.email)
  const alerts = await listTradeWatchAlerts(auth.email, { limit: 30 })
  const unread = alerts.filter((a) => !a.read).length

  return NextResponse.json({
    config: book.config,
    alerts,
    unread,
    watchlist: user.watchlist ?? [],
    favorites: user.favorites ?? [],
  })
}

export async function PATCH(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  try {
    const body = (await request.json()) as Partial<
      Pick<
        TradeWatchConfig,
        'enabled' | 'autoAnalyze' | 'browserNotify' | 'scanIntervalMinutes' | 'defaultTimeframe'
      >
    >

    const patch: Partial<TradeWatchConfig> = {}
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (typeof body.autoAnalyze === 'boolean') patch.autoAnalyze = body.autoAnalyze
    if (typeof body.browserNotify === 'boolean') patch.browserNotify = body.browserNotify
    if (body.scanIntervalMinutes === 5 || body.scanIntervalMinutes === 15 || body.scanIntervalMinutes === 30) {
      patch.scanIntervalMinutes = body.scanIntervalMinutes
    }
    if (
      body.defaultTimeframe === '15m' ||
      body.defaultTimeframe === '1h' ||
      body.defaultTimeframe === '4h' ||
      body.defaultTimeframe === '1d'
    ) {
      patch.defaultTimeframe = body.defaultTimeframe
    }

    const config = await updateTradeWatchConfig(auth.email, patch)
    return NextResponse.json({ config })
  } catch {
    return NextResponse.json({ error: 'Failed to update config' }, { status: 400 })
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const url = new URL(request.url)
  const action = url.searchParams.get('action')

  if (action === 'mark-all-read') {
    const count = await markAllTradeWatchAlertsRead(auth.email)
    return NextResponse.json({ marked: count })
  }

  try {
    const body = (await request.json()) as { alertId?: string }
    if (!body.alertId) {
      return NextResponse.json({ error: 'alertId required' }, { status: 400 })
    }
    const ok = await markTradeWatchAlertRead(auth.email, body.alertId)
    return NextResponse.json({ ok })
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 400 })
  }
}
