import { fetchEconomicCalendar, getHighImpactEvents } from '@/lib/economic-calendar'
import { calendarDefaultRange } from '@/lib/calendar-range'
import {
  formatOpensIn,
  generateMarketNotes,
  getMarketLiquidity,
  getMarketStatusForSymbol,
  getMinutesUntilNextSession,
  getTradingSessions,
  isForexMarketOpen,
} from '@/lib/market-sessions'
import { isAuthSession, requireAuth } from '@/lib/require-auth'

export async function GET(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const { searchParams } = new URL(req.url)
  const symbol = searchParams.get('symbol') || undefined

  const { from: today, to: toDate } = calendarDefaultRange({ daysBack: 0, daysAhead: 7 })

  const [{ data: calendarEvents }, sessions] = await Promise.all([
    fetchEconomicCalendar(today, toDate),
    Promise.resolve(getTradingSessions()),
  ])

  const highImpactEvents = getHighImpactEvents(calendarEvents, 8)
  const activeSessions = sessions.filter((s) => s.isActive)
  const marketStatus = getMarketStatusForSymbol(symbol)
  const liquidity = getMarketLiquidity()
  const forexOpen = isForexMarketOpen()
  const nextSession = getMinutesUntilNextSession()

  const nextEvent = highImpactEvents[0]
  const marketNotes = generateMarketNotes(
    activeSessions.map((s) => s.name),
    nextEvent
      ? { event: nextEvent.event, currency: nextEvent.currency, time: nextEvent.time }
      : undefined
  )

  return Response.json({
    symbol,
    marketStatus,
    forexOpen,
    liquidity,
    activeSessions,
    allSessions: sessions,
    highImpactEvents,
    marketNotes,
    nextSession: nextSession
      ? {
          name: nextSession.name,
          currency: nextSession.currency,
          opensIn: formatOpensIn(nextSession.minutes),
          minutes: nextSession.minutes,
        }
      : null,
    updatedAt: new Date().toISOString(),
  })
}
