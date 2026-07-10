/** Shared economic calendar date windows for UI + API. */

export const CALENDAR_DAYS_BACK = 2
export const CALENDAR_DAYS_AHEAD = 30
export const CALENDAR_MAX_SPAN_DAYS = 45
export const CALENDAR_MAX_EVENTS = 600

function toDateKey(d: Date): string {
  return d.toISOString().split('T')[0]!
}

export function calendarDefaultRange(opts?: {
  daysBack?: number
  daysAhead?: number
}): { from: string; to: string } {
  const now = new Date()
  const from = new Date(now)
  from.setUTCDate(from.getUTCDate() - (opts?.daysBack ?? CALENDAR_DAYS_BACK))
  const to = new Date(now)
  to.setUTCDate(to.getUTCDate() + (opts?.daysAhead ?? CALENDAR_DAYS_AHEAD))
  return { from: toDateKey(from), to: toDateKey(to) }
}

/** Clamp client/API ranges so we do not hammer upstream providers. */
export function clampCalendarRange(
  fromDate: string,
  toDate: string
): { from: string; to: string } {
  const today = new Date()
  const minFrom = new Date(today)
  minFrom.setUTCDate(minFrom.getUTCDate() - 7)
  const maxTo = new Date(today)
  maxTo.setUTCDate(maxTo.getUTCDate() + CALENDAR_MAX_SPAN_DAYS)

  let from = fromDate || toDateKey(today)
  let to = toDate || from
  if (from > to) [from, to] = [to, from]

  if (from < toDateKey(minFrom)) from = toDateKey(minFrom)
  if (to > toDateKey(maxTo)) to = toDateKey(maxTo)

  const spanMs = new Date(to).getTime() - new Date(from).getTime()
  const maxSpanMs = CALENDAR_MAX_SPAN_DAYS * 86_400_000
  if (spanMs > maxSpanMs) {
    const cappedTo = new Date(from)
    cappedTo.setUTCDate(cappedTo.getUTCDate() + CALENDAR_MAX_SPAN_DAYS)
    to = toDateKey(cappedTo)
  }

  return { from, to }
}

export function formatCalendarDayLabel(dateStr: string, now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const todayKey = `${y}-${m}-${d}`
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowKey = toDateKey(tomorrow)

  if (dateStr === todayKey) return 'Today'
  if (dateStr === tomorrowKey) return 'Tomorrow'

  try {
    const parsed = new Date(`${dateStr}T12:00:00`)
    if (Number.isNaN(parsed.getTime())) return dateStr
    return parsed.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return dateStr
  }
}
