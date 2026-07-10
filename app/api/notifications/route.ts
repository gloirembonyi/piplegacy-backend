import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { getUserData } from '@/lib/user-store'
import { fetchQuotes } from '@/lib/finnhub'
import { fetchEconomicCalendar, getHighImpactEvents } from '@/lib/economic-calendar'
import { getMinutesUntilNextSession } from '@/lib/market-sessions'
import { displaySymbolLabel } from '@/lib/symbols'
import { isAdminEmail } from '@/lib/admin'
import { getRecentAdminErrors } from '@/lib/admin-error-log'
import { isRedisConfigured } from '@/lib/redis'
import { listTradeWatchAlerts } from '@/lib/trade-watch-store'

export const dynamic = 'force-dynamic'

type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical'

type Notification = {
  id: string
  /** Drives the icon and accent color in the popover. */
  category: 'event' | 'mover' | 'session' | 'system' | 'signal'
  severity: NotificationSeverity
  title: string
  detail?: string
  /** Anchor link to dive deeper (chart, calendar tab, etc.). */
  href?: string
  /** Stable sort key - earlier = higher priority. */
  priority: number
  /** Friendly relative time string ("in 18m", "now"). */
  when: string
}

function fmtMinutes(mins: number): string {
  if (mins <= 0) return 'now'
  if (mins < 60) return `in ${mins}m`
  const h = Math.floor(mins / 60)
  const r = mins % 60
  if (h < 24) return r > 0 ? `in ${h}h ${r}m` : `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const notifications: Notification[] = []

  try {
    const user = await getUserData(auth.email)
    const watchlist = (user.watchlist ?? []).slice(0, 20)

    // 1) Watchlist movers (>= 2% absolute change)
    if (watchlist.length > 0) {
      try {
        const quotes = await fetchQuotes(watchlist.map((s) => ({ symbol: s })))
        const movers = quotes
          .filter((q) => Math.abs(q.changePercent) >= 2)
          .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
          .slice(0, 4)
        for (const m of movers) {
          const up = m.changePercent >= 0
          notifications.push({
            id: `mover-${m.symbol}`,
            category: 'mover',
            severity: Math.abs(m.changePercent) >= 5 ? 'critical' : up ? 'success' : 'warning',
            title: `${displaySymbolLabel(m.symbol)} ${up ? '+' : ''}${m.changePercent.toFixed(2)}%`,
            detail: `Watchlist move · price ${
              m.price >= 1 ? m.price.toFixed(2) : m.price.toFixed(4)
            }`,
            href: `/app?view=chart&symbol=${encodeURIComponent(m.symbol)}`,
            priority: 100 - Math.min(50, Math.abs(m.changePercent) * 5),
            when: 'now',
          })
        }
      } catch {
        /* ignore - partial response is still useful */
      }
    }

    // 2) Upcoming high-impact events (next 24h, max 3)
    try {
      const today = new Date().toISOString().split('T')[0]
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const to = tomorrow.toISOString().split('T')[0]
      const cal = await fetchEconomicCalendar(today, to)
      const events = getHighImpactEvents(cal.data || [], 12)
      const now = Date.now()
      const soon = events
        .map((ev) => {
          const t = ev.event_dt ? new Date(ev.event_dt).getTime() : 0
          return { ev, msUntil: t - now }
        })
        .filter((e) => e.msUntil > -15 * 60_000 && e.msUntil < 24 * 60 * 60_000)
        .slice(0, 3)
      for (const { ev, msUntil } of soon) {
        const mins = Math.max(0, Math.round(msUntil / 60_000))
        const live = msUntil <= 0
        notifications.push({
          id: `event-${ev.event_id}`,
          category: 'event',
          severity: live ? 'critical' : mins <= 60 ? 'warning' : 'info',
          title: ev.event,
          detail: `${ev.currency} · ${live ? 'LIVE now' : fmtMinutes(mins)}${
            ev.forecast && ev.forecast !== '-' ? ` · forecast ${ev.forecast}` : ''
          }`,
          href: `/app?view=markets`,
          priority: live ? 5 : mins <= 60 ? 10 : 30 + Math.floor(mins / 60),
          when: live ? 'LIVE' : fmtMinutes(mins),
        })
      }
    } catch {
      /* ignore */
    }

    // 3) Next trading session opening
    try {
      const next = getMinutesUntilNextSession()
      if (next && next.minutes > 0 && next.minutes < 240) {
        notifications.push({
          id: `session-${next.name}`,
          category: 'session',
          severity: next.minutes <= 30 ? 'warning' : 'info',
          title: `${next.name} opens ${fmtMinutes(next.minutes)}`,
          detail: `${next.currency} session - liquidity will pick up.`,
          href: `/app?view=markets`,
          priority: 50 + next.minutes,
          when: fmtMinutes(next.minutes),
        })
      }
    } catch {
      /* ignore */
    }

    // 4) Trade Watch signals (unread, max 5)
    try {
      const signals = await listTradeWatchAlerts(auth.email, { unreadOnly: true, limit: 5 })
      for (const s of signals) {
        notifications.push({
          id: `signal-${s.id}`,
          category: 'signal',
          severity:
            s.severity === 'critical'
              ? 'critical'
              : s.severity === 'warning'
                ? 'warning'
                : 'info',
          title: s.title,
          detail: s.detail,
          href: s.href ?? `/app?view=chart&symbol=${encodeURIComponent(s.symbol)}&panel=signals`,
          priority: s.kind === 'setup' ? 12 : s.kind === 'breakout' ? 15 : 25,
          when: 'now',
        })
      }
    } catch {
      /* ignore */
    }

    // 5) Admin system alerts (errors, missing Redis on Vercel)
    if (isAdminEmail(auth.email)) {
      try {
        if (process.env.VERCEL && !isRedisConfigured()) {
          notifications.push({
            id: 'admin-redis-missing',
            category: 'system',
            severity: 'warning',
            title: 'Token usage may not persist on Vercel',
            detail: 'Connect Upstash Redis (KV_REST_API_URL) for accurate AI usage totals.',
            href: '/admin/ai',
            priority: 8,
            when: 'now',
          })
        }

        const adminErrors = await getRecentAdminErrors(5)
        const recentCutoff = Date.now() - 60 * 60_000
        for (const err of adminErrors) {
          const at = new Date(err.at).getTime()
          if (!Number.isFinite(at) || at < recentCutoff) continue
          notifications.push({
            id: `admin-err-${err.id}`,
            category: 'system',
            severity: err.status && err.status >= 500 ? 'critical' : 'warning',
            title: `${err.kind}: ${err.target}${err.status ? ` (${err.status})` : ''}`,
            detail: err.message.slice(0, 120),
            href: err.kind === 'tool' || err.kind === 'agent' ? '/admin/agents' : '/admin/ai',
            priority: err.kind === 'agent' ? 3 : 6,
            when: 'now',
          })
        }
      } catch {
        /* ignore */
      }
    }

    notifications.sort((a, b) => a.priority - b.priority)

    const unread = notifications.filter(
      (n) => n.severity === 'warning' || n.severity === 'critical'
    ).length

    return NextResponse.json({
      notifications,
      unread,
      total: notifications.length,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('notifications error:', error)
    return NextResponse.json(
      { notifications: [], unread: 0, total: 0, error: 'Failed to load notifications' },
      { status: 500 }
    )
  }
}
