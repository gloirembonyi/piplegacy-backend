import { fetchEconomicCalendar } from '@/lib/economic-calendar'
import { calendarDefaultRange, clampCalendarRange } from '@/lib/calendar-range'
import { isAuthSession, requireAuth } from '@/lib/require-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const { searchParams } = new URL(req.url)
  const defaults = calendarDefaultRange()
  const { from, to } = clampCalendarRange(
    searchParams.get('from') || defaults.from,
    searchParams.get('to') || defaults.to
  )

  const { data, sources } = await fetchEconomicCalendar(from, to)
  return Response.json(
    { data, sources, from, to, count: data.length },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
