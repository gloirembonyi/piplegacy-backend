/** Global trading session helpers (UTC-based, no external API). */

export type TradingSession = {
  name: string
  currency: string
  isActive: boolean
}

const SESSIONS = [
  { name: 'Sydney', start: { hour: 20, minute: 0 }, end: { hour: 5, minute: 0 }, currency: 'AUD' },
  { name: 'Tokyo', start: { hour: 23, minute: 0 }, end: { hour: 8, minute: 0 }, currency: 'JPY' },
  { name: 'London', start: { hour: 8, minute: 0 }, end: { hour: 17, minute: 0 }, currency: 'GBP' },
  { name: 'New York', start: { hour: 13, minute: 0 }, end: { hour: 22, minute: 0 }, currency: 'USD' },
] as const

function isSessionActive(
  utcHour: number,
  utcMinute: number,
  start: { hour: number; minute: number },
  end: { hour: number; minute: number }
): boolean {
  const afterStart =
    utcHour > start.hour || (utcHour === start.hour && utcMinute >= start.minute)
  const beforeEnd =
    utcHour < end.hour || (utcHour === end.hour && utcMinute <= end.minute)

  if (start.hour > end.hour) {
    return afterStart || beforeEnd
  }
  return afterStart && beforeEnd
}

export function getTradingSessions(now = new Date()): TradingSession[] {
  const forexOpen = isForexMarketOpen(now)
  const utcHour = now.getUTCHours()
  const utcMinute = now.getUTCMinutes()

  return SESSIONS.map((session) => ({
    name: session.name,
    currency: session.currency,
    isActive:
      forexOpen &&
      isSessionActive(utcHour, utcMinute, session.start, session.end),
  }))
}

export function getActiveSessionNames(now = new Date()): string[] {
  return getTradingSessions(now)
    .filter((s) => s.isActive)
    .map((s) => s.name)
}

export function getMarketLiquidity(now = new Date()): 'High' | 'Medium' | 'Low' {
  if (!isForexMarketOpen(now)) return 'Low'
  const active = getActiveSessionNames(now)
  if (active.length >= 2) return 'High'
  if (active.length === 1) return 'Medium'
  return 'Low'
}

function utcMinutes(now: Date): number {
  return now.getUTCHours() * 60 + now.getUTCMinutes()
}

function sessionStartMinutes(start: { hour: number; minute: number }): number {
  return start.hour * 60 + start.minute
}

/** Minutes until the next session open (0 if one is already active). */
export function getMinutesUntilNextSession(now = new Date()): {
  name: string
  currency: string
  minutes: number
} | null {
  if (!isForexMarketOpen(now)) {
    return { name: 'Sydney', currency: 'AUD', minutes: minutesUntilSundayOpen(now) }
  }

  const utcM = utcMinutes(now)
  const active = SESSIONS.find((s) =>
    isSessionActive(now.getUTCHours(), now.getUTCMinutes(), s.start, s.end)
  )
  if (active) return null

  let best: { name: string; currency: string; minutes: number } | null = null
  for (const s of SESSIONS) {
    let startM = sessionStartMinutes(s.start)
    let delta = startM - utcM
    if (delta <= 0) delta += 24 * 60
    if (!best || delta < best.minutes) {
      best = { name: s.name, currency: s.currency, minutes: delta }
    }
  }
  return best
}

function minutesUntilSundayOpen(now: Date): number {
  const day = now.getUTCDay()
  const utcM = utcMinutes(now)
  const sundayOpen = 22 * 60
  if (day === 6) return sundayOpen - utcM + 24 * 60
  if (day === 0 && utcM < sundayOpen) return sundayOpen - utcM
  return 0
}

export function formatOpensIn(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/** US equities: Mon–Fri 14:30–21:00 UTC (approx NYSE regular). */
export function isUsStockMarketOpen(now = new Date()): boolean {
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return false
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes()
  return mins >= 14 * 60 + 30 && mins < 21 * 60
}

export function isForexMarketOpen(now = new Date()): boolean {
  const day = now.getUTCDay()
  if (day === 6) return false
  if (day === 0 && now.getUTCHours() < 22) return false
  return true
}

export function getMarketStatusForSymbol(symbol?: string): {
  isOpen: boolean
  label: string
} {
  const now = new Date()
  const day = now.getUTCDay()
  const isWeekend = day === 0 || day === 6

  if (!symbol) {
    return {
      isOpen: isForexMarketOpen(now),
      label: isForexMarketOpen(now) ? 'Forex open' : 'Markets closed',
    }
  }

  const upper = symbol.toUpperCase()
  const isForex =
    upper.includes('USD') ||
    upper.includes('EUR') ||
    upper.includes('GBP') ||
    upper.includes('JPY') ||
    upper.startsWith('OANDA:')

  if (isForex) {
    const open = isForexMarketOpen(now) && !isWeekend
    return { isOpen: open, label: open ? 'Open' : isWeekend ? 'Closed (Weekend)' : 'Closed' }
  }

  const open = isUsStockMarketOpen(now)
  return { isOpen: open, label: open ? 'Open' : isWeekend ? 'Closed (Weekend)' : 'Closed' }
}

export function generateMarketNotes(
  activeSessions: string[],
  nextHighImpactEvent?: { event: string; currency?: string; time?: string },
  now = new Date()
): string {
  const notes: string[] = []

  if (!isForexMarketOpen(now)) {
    notes.push(
      'Forex is closed for the weekend. Liquidity and spreads typically normalize when Sydney opens (Sunday ~10 PM UTC).'
    )
    if (nextHighImpactEvent) {
      const time = nextHighImpactEvent.time ? ` at ${nextHighImpactEvent.time}` : ''
      const cur = nextHighImpactEvent.currency ? ` (${nextHighImpactEvent.currency})` : ''
      notes.push(`Upcoming: ${nextHighImpactEvent.event}${cur}${time}.`)
    }
    return notes.join(' ')
  }

  if (activeSessions.length >= 2) {
    notes.push(
      `Elevated liquidity: ${activeSessions.slice(0, 2).join(' and ')} sessions overlap.`
    )
  } else if (activeSessions.length === 1) {
    notes.push(`${activeSessions[0]} session is active.`)
  } else {
    notes.push('No major sessions active - liquidity may be lower.')
  }

  if (nextHighImpactEvent) {
    const time = nextHighImpactEvent.time ? ` at ${nextHighImpactEvent.time}` : ''
    const cur = nextHighImpactEvent.currency ? ` (${nextHighImpactEvent.currency})` : ''
    notes.push(`Next high-impact event: ${nextHighImpactEvent.event}${cur}${time}.`)
  }

  return notes.join(' ')
}
