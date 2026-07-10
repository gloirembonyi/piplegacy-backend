/**
 * Live grounding - fetched in parallel BEFORE the agent's first model call.
 *
 * Why: even the cheapest tool roundtrip costs a Gemini call. By front-loading
 * the basics (quote, sessions, next high-impact event, news blackout flag)
 * we give the model immediate situational awareness and cut latency by 1–2
 * iterations on most questions.
 *
 * What we DO NOT pre-fetch: deep candle history, technical indicators,
 * full news feed - those stay as tools the model can call when relevant.
 */

import { fetchEconomicCalendar } from '@/lib/economic-calendar'
import { fetchQuote, formatTimeAgo } from '@/lib/finnhub'
import {
  formatOpensIn,
  getActiveSessionNames,
  getMarketLiquidity,
  getMarketStatusForSymbol,
  getMinutesUntilNextSession,
  isForexMarketOpen,
  isUsStockMarketOpen,
} from '@/lib/market-sessions'
import { displaySymbolLabel } from '@/lib/symbols'

const GROUNDING_TIMEOUT_MS = 3500

type LiveQuote = {
  price: number
  changePercent: number
  dayHigh: number
  dayLow: number
  open: number
  prevClose: number
  ageSec: number
}

type UpcomingEvent = {
  event: string
  currency: string
  impact: string
  date: string
  time: string
  forecast?: string | number
  previous?: string | number
  minutesUntil: number | null
}

export type LiveGrounding = {
  serverTimeUtc: string
  serverTimeLocal: string
  symbol?: string
  symbolLabel?: string
  quote?: LiveQuote
  forexOpen: boolean
  usStockOpen: boolean
  activeSessions: string[]
  liquidity: 'High' | 'Medium' | 'Low'
  marketStatusForSymbol?: { label: string; isOpen: boolean }
  nextSession?: { name: string; currency: string; opensIn: string; minutesUntil: number }
  nextHighImpact?: UpcomingEvent
  newsBlackout: boolean
  newsBlackoutReason?: string
}

function parseEventToMinutes(dateStr?: string, timeStr?: string): number | null {
  if (!dateStr || !timeStr) return null
  const iso = `${dateStr}T${timeStr.length === 5 ? timeStr : `${timeStr}:00`}:00Z`
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return null
  return Math.round((ts - Date.now()) / 60000)
}

/** Which currencies are relevant to a symbol - used to flag news blackouts. */
function relevantCurrencies(symbol?: string): string[] {
  if (!symbol) return ['USD']
  const s = symbol.toUpperCase()
  // FX pair like OANDA:EUR_USD or EURUSD
  const fxMatch = s.match(/([A-Z]{3})[_./]?([A-Z]{3})$/)
  if (fxMatch) return [fxMatch[1], fxMatch[2]]
  // XAU/USD, XAG/USD
  if (/XAU|GOLD/.test(s)) return ['USD']
  if (/BTC|ETH|SOL|XRP|DOGE/.test(s)) return ['USD']
  // US equity / index
  if (/^(SPY|QQQ|DIA|VIX|NDX|SPX|US30|NAS|NVDA|AAPL|MSFT|TSLA|AMZN|GOOGL|META|AMD)/.test(s)) {
    return ['USD']
  }
  return ['USD']
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

/** Fetch a small, time-sensitive context in parallel. Best-effort; never throws. */
export async function fetchLiveGrounding(opts: {
  symbol?: string
  symbolLabel?: string
}): Promise<LiveGrounding> {
  const now = new Date()
  const serverTimeUtc = now.toISOString()
  const serverTimeLocal = now.toString()

  const today = serverTimeUtc.split('T')[0]
  const horizon = new Date(now.getTime() + 36 * 3600 * 1000).toISOString().split('T')[0]
  const past = new Date(now.getTime() - 12 * 3600 * 1000).toISOString().split('T')[0]

  const quotePromise = opts.symbol
    ? withTimeout(fetchQuote(opts.symbol), GROUNDING_TIMEOUT_MS, null)
    : Promise.resolve(null)

  const calendarPromise = withTimeout(
    fetchEconomicCalendar(past, horizon),
    GROUNDING_TIMEOUT_MS,
    { data: [], sources: [] }
  )

  const [quote, calendar] = await Promise.all([quotePromise, calendarPromise])

  const activeSessions = getActiveSessionNames(now)
  const liquidity = getMarketLiquidity(now)
  const forexOpen = isForexMarketOpen(now)
  const usStockOpen = isUsStockMarketOpen(now)
  const nextSession = getMinutesUntilNextSession(now)
  const marketStatusForSymbol = opts.symbol
    ? getMarketStatusForSymbol(opts.symbol)
    : undefined

  let quoteOut: LiveQuote | undefined
  if (quote) {
    quoteOut = {
      price: quote.c,
      changePercent: quote.dp,
      dayHigh: quote.h,
      dayLow: quote.l,
      open: quote.o,
      prevClose: quote.pc,
      ageSec: Math.max(0, Math.round(Date.now() / 1000 - quote.t)),
    }
  }

  const ccys = relevantCurrencies(opts.symbol)
  const events = calendar.data
    .filter((e) => e.impact === 'high' || e.impact === 'medium')
    .map((e) => ({
      event: e.event,
      currency: e.currency,
      impact: e.impact,
      date: e.date,
      time: e.time,
      forecast: e.forecast,
      previous: e.previous,
      minutesUntil: parseEventToMinutes(e.date, e.time),
    }))

  const upcomingForSymbol = events
    .filter((e) => ccys.includes(e.currency))
    .filter((e) => e.minutesUntil != null && e.minutesUntil > -60)
    .sort((a, b) => (a.minutesUntil ?? 1e9) - (b.minutesUntil ?? 1e9))

  const nextHighImpact = upcomingForSymbol.find(
    (e) => e.impact === 'high' && (e.minutesUntil ?? 0) >= -10
  )

  // News blackout flag: any high-impact event for a relevant currency within ±30 min.
  let newsBlackout = false
  let newsBlackoutReason: string | undefined
  for (const e of upcomingForSymbol) {
    if (e.impact !== 'high') continue
    const m = e.minutesUntil
    if (m == null) continue
    if (m >= -10 && m <= 30) {
      newsBlackout = true
      const when = m < 0 ? `${Math.abs(m)}m ago` : `in ${m}m`
      newsBlackoutReason = `${e.event} (${e.currency}, high impact) ${when}`
      break
    }
  }

  return {
    serverTimeUtc,
    serverTimeLocal,
    symbol: opts.symbol,
    symbolLabel: opts.symbolLabel ?? (opts.symbol ? displaySymbolLabel(opts.symbol) : undefined),
    quote: quoteOut,
    forexOpen,
    usStockOpen,
    activeSessions,
    liquidity,
    marketStatusForSymbol: marketStatusForSymbol
      ? { label: marketStatusForSymbol.label, isOpen: marketStatusForSymbol.isOpen }
      : undefined,
    nextSession: nextSession
      ? {
          name: nextSession.name,
          currency: nextSession.currency,
          opensIn: formatOpensIn(nextSession.minutes),
          minutesUntil: nextSession.minutes,
        }
      : undefined,
    nextHighImpact,
    newsBlackout,
    newsBlackoutReason,
  }
}

/** Render the grounding object as a compact text block the agent reads first. */
export function renderGroundingForPrompt(g: LiveGrounding): string {
  const lines: string[] = []
  lines.push(`=== LIVE GROUNDING (pre-fetched, treat as authoritative) ===`)
  lines.push(`Now (UTC): ${g.serverTimeUtc}`)

  if (g.symbol) {
    lines.push(`Symbol: ${g.symbolLabel ?? g.symbol} (${g.symbol})`)
  }

  if (g.quote) {
    const q = g.quote
    const sign = q.changePercent >= 0 ? '+' : ''
    lines.push(
      `Live quote: ${q.price} (${sign}${q.changePercent.toFixed(2)}%), day H ${q.dayHigh} / L ${q.dayLow}, open ${q.open}, prev close ${q.prevClose} · quote age ${q.ageSec}s.`
    )
  } else if (g.symbol) {
    lines.push(`Live quote: unavailable. Use get_quote tool to retry.`)
  }

  if (g.marketStatusForSymbol) {
    lines.push(
      `Market for symbol: ${g.marketStatusForSymbol.label} (${g.marketStatusForSymbol.isOpen ? 'open' : 'closed'}).`
    )
  }

  lines.push(
    `Sessions: ${g.activeSessions.length ? g.activeSessions.join(', ') : 'none active'} · liquidity ${g.liquidity} · forex ${g.forexOpen ? 'open' : 'closed'} · US equities ${g.usStockOpen ? 'open' : 'closed'}.`
  )

  if (g.nextSession) {
    lines.push(
      `Next session: ${g.nextSession.name} (${g.nextSession.currency}) opens in ${g.nextSession.opensIn}.`
    )
  }

  if (g.nextHighImpact) {
    const e = g.nextHighImpact
    const inTxt =
      e.minutesUntil == null
        ? `${e.date} ${e.time}`
        : e.minutesUntil < 0
          ? `${Math.abs(e.minutesUntil)}m ago`
          : `in ${e.minutesUntil}m (${e.date} ${e.time} UTC)`
    lines.push(
      `Next high-impact event for this symbol: ${e.event} (${e.currency}) ${inTxt} · forecast ${e.forecast ?? '-'} prev ${e.previous ?? '-'}.`
    )
  } else {
    lines.push(`No high-impact event flagged for this symbol in the next 36h.`)
  }

  if (g.newsBlackout) {
    lines.push(
      `⚠ NEWS BLACKOUT ACTIVE: ${g.newsBlackoutReason}. Do NOT open new positions until the event passes and volatility settles.`
    )
  }

  lines.push(`=== END LIVE GROUNDING ===`)
  return lines.join('\n')
}

/** Quote helper used by chat to display "as of" timestamps. */
export { formatTimeAgo }
