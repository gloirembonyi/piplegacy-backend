import { fetchEconomicCalendar, getHighImpactEvents, type EconomicEvent } from '@/lib/economic-calendar'
import { fetchMarketCandles } from '@/lib/candle-providers'
import {
  fetchMarketNewsFeed,
  fetchQuote,
  fetchQuotes,
  formatTimeAgo,
} from '@/lib/finnhub'
import { INSIGHTS_CONTEXT_SYMBOLS } from '@/lib/insights-symbols'
import {
  generateMarketNotes,
  getActiveSessionNames,
  getMarketLiquidity,
  getMarketStatusForSymbol,
} from '@/lib/market-sessions'
import { displaySymbolLabel, resolveQuoteSymbol } from '@/lib/symbols'

function summarizeDailyCandles(
  bars: { t: number; o: number; h: number; l: number; c: number }[]
): string {
  if (bars.length < 5) return ''

  const sorted = [...bars].sort((a, b) => a.t - b.t)
  const recent = sorted.slice(-20)
  const last = recent[recent.length - 1]
  const fiveAgo = recent[Math.max(0, recent.length - 6)]
  const change5d =
    fiveAgo.c > 0 ? (((last.c - fiveAgo.c) / fiveAgo.c) * 100).toFixed(2) : '0'

  const highs = recent.map((b) => b.h)
  const lows = recent.map((b) => b.l)
  const resistance = Math.max(...highs).toFixed(4)
  const support = Math.min(...lows).toFixed(4)

  const closes = recent.map((b) => b.c)
  const sma10 =
    closes.length >= 10
      ? closes.slice(-10).reduce((a, c) => a + c, 0) / 10
      : closes.reduce((a, c) => a + c, 0) / closes.length

  const trend =
    last.c > sma10 * 1.002 ? 'bullish' : last.c < sma10 * 0.998 ? 'bearish' : 'neutral'

  return `Daily context (last ${recent.length} sessions): trend ${trend}, 5d change ${change5d}%, support ${support}, resistance ${resistance}, SMA10 ${sma10.toFixed(4)}.`
}

/** Live quote + sessions + calendar + OHLC summary for a symbol. */
export async function buildSymbolMarketContext(
  symbol: string,
  chartResolution = 'D'
): Promise<string> {
  const resolved = resolveQuoteSymbol(symbol)
  const label = displaySymbolLabel(symbol)
  const parts: string[] = [
    `Analyzing ${label} (${resolved}). Chart timeframe requested: ${chartResolution}.`,
  ]

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 4500))

  const dataPromise = Promise.all([
    fetchQuote(symbol),
    fetchMarketCandles(symbol, 'D'),
    fetchEconomicCalendar(
      new Date().toISOString().split('T')[0],
      new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0]
    ),
    Promise.resolve(fetchQuote('SPY')),
  ])

  const result = await Promise.race([dataPromise, timeout])

  if (result) {
    const [quote, candles, calendar, spy] = result

    if (quote) {
      parts.push(
        `Live quote: price ${quote.c}, change ${quote.d >= 0 ? '+' : ''}${quote.d} (${quote.dp >= 0 ? '+' : ''}${quote.dp.toFixed(2)}%), day high ${quote.h}, day low ${quote.l}, open ${quote.o}, prev close ${quote.pc}.`
      )
    } else {
      parts.push('Live quote: unavailable - base levels on daily history only.')
    }

    const candleSummary = summarizeDailyCandles(candles.data)
    if (candleSummary) parts.push(candleSummary)

    const status = getMarketStatusForSymbol(symbol)
    parts.push(`Market status: ${status.label} (${status.isOpen ? 'open' : 'closed'}).`)

    const liquidity = getMarketLiquidity()
    const sessions = getActiveSessionNames()
    parts.push(`Liquidity: ${liquidity}.`)
    if (sessions.length) parts.push(`Active sessions: ${sessions.join(', ')}.`)

    if (spy) {
      parts.push(`Benchmark SPY: ${spy.c} (${spy.dp >= 0 ? '+' : ''}${spy.dp.toFixed(2)}%).`)
    }

    const highImpact = getHighImpactEvents(calendar.data, 3)
    if (highImpact.length) {
      parts.push(
        `Upcoming events: ${highImpact.map((e) => `${e.event} (${e.currency})`).join('; ')}.`
      )
    }

    const notes = generateMarketNotes(
      sessions,
      highImpact[0]
        ? { event: highImpact[0].event, currency: highImpact[0].currency, time: highImpact[0].time }
        : undefined
    )
    if (notes) parts.push(notes)
  }

  parts.push(
    'Use ONLY the numbers above. If quote is missing, say so and avoid inventing prices.'
  )

  return parts.join(' ')
}

function formatCalendarLine(e: EconomicEvent): string {
  const actual =
    e.actual && e.actual !== '-' ? ` actual ${e.actual}` : ''
  return `${e.date} ${e.time} ${e.currency} ${e.event} (impact ${e.impact}) fcst ${e.forecast} prev ${e.previous}${actual}`
}

/** Full Market Insights context: multi-asset quotes, calendar, news, sessions. */
export async function buildInsightsMarketContext(focusSymbol?: string): Promise<string> {
  const parts: string[] = [
    'MARKET INSIGHTS LIVE DATA (use only these numbers; timestamp is fetch time).',
    `Fetched at: ${new Date().toISOString()}.`,
  ]

  const today = new Date().toISOString().split('T')[0]
  const weekEnd = new Date()
  weekEnd.setDate(weekEnd.getDate() + 7)
  const toDate = weekEnd.toISOString().split('T')[0]

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))

  const dataPromise = Promise.all([
    fetchQuotes(
      INSIGHTS_CONTEXT_SYMBOLS.map((s) => ({
        symbol: s,
        label: displaySymbolLabel(s),
      }))
    ),
    fetchEconomicCalendar(today, toDate),
    fetchMarketNewsFeed(10),
  ])

  const result = await Promise.race([dataPromise, timeout])

  if (result) {
    const [quotes, calendar, news] = result

    if (quotes.length) {
      parts.push(
        `Live quotes: ${quotes
          .map(
            (q) =>
              `${q.label || q.symbol} ${q.price} (${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%)`
          )
          .join('; ')}.`
      )
    }

    const sessions = getActiveSessionNames()
    const liquidity = getMarketLiquidity()
    parts.push(`Liquidity: ${liquidity}.`)
    if (sessions.length) parts.push(`Active sessions: ${sessions.join(', ')}.`)

    const upcoming = calendar.data
      .filter((e) => e.impact === 'high' || e.impact === 'medium')
      .slice(0, 12)
    if (upcoming.length) {
      parts.push(`Economic calendar (next events):\n${upcoming.map(formatCalendarLine).join('\n')}`)
    }

    if (news.length) {
      parts.push(
        `Recent headlines: ${news
          .slice(0, 8)
          .map((n) => `${n.headline} (${n.source}, ${formatTimeAgo(n.datetime)})`)
          .join(' | ')}.`
      )
    }

    const notes = generateMarketNotes(
      sessions,
      upcoming[0]
        ? { event: upcoming[0].event, currency: upcoming[0].currency, time: upcoming[0].time }
        : undefined
    )
    if (notes) parts.push(notes)
  }

  const focus = focusSymbol && focusSymbol !== 'MARKET' ? focusSymbol : null
  if (focus) {
    parts.push('\n--- Focus instrument ---')
    parts.push(await buildSymbolMarketContext(focus))
  } else {
    parts.push(
      'No single symbol focus - answer for the whole market (FX, indices, commodities, crypto) using the data above.'
    )
  }

  parts.push(
    'Educational analysis only. Never invent prices. Reference calendar times in UTC/local as listed.'
  )

  return parts.join('\n')
}

/** Broader macro context (no symbol-specific quote). */
export async function buildGlobalMarketContext(): Promise<string> {
  try {
    const today = new Date().toISOString().split('T')[0]
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 2)
    const toDate = tomorrow.toISOString().split('T')[0]

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
    const dataPromise = Promise.all([
      fetchQuote('SPY'),
      fetchQuote('OANDA:EUR_USD'),
      fetchEconomicCalendar(today, toDate),
    ])
    const result = await Promise.race([dataPromise, timeout])
    if (!result) return ''

    const [spy, eur, calendar] = result
    const parts: string[] = []

    if (spy) parts.push(`SPY ${spy.dp >= 0 ? '+' : ''}${spy.dp.toFixed(2)}%`)
    if (eur) parts.push(`EUR/USD ${eur.c.toFixed(4)}`)

    const activeSessions = getActiveSessionNames()
    const liquidity = getMarketLiquidity()
    parts.push(`Liquidity: ${liquidity}`)
    if (activeSessions.length) parts.push(`Active sessions: ${activeSessions.join(', ')}`)

    const highImpact = getHighImpactEvents(calendar.data, 2)
    if (highImpact.length) {
      parts.push(
        `Upcoming: ${highImpact.map((e) => `${e.event} (${e.currency})`).join('; ')}`
      )
    }

    const notes = generateMarketNotes(
      activeSessions,
      highImpact[0]
        ? { event: highImpact[0].event, currency: highImpact[0].currency, time: highImpact[0].time }
        : undefined
    )
    if (notes) parts.push(notes)

    return parts.length ? `Live market context: ${parts.join('. ')}.` : ''
  } catch {
    return ''
  }
}
