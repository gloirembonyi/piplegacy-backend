import { fetchGoldSpot } from '@/lib/ai-tools/metals-deep-market'
import { getCandleEndpoint, inferSymbolType, resolveQuoteSymbol, type SymbolMeta } from "@/lib/symbols"
import { fetchYahooQuoteFull } from "@/lib/candle-providers/yahoo"

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "demo"
const FINNHUB_BASE_URL = "https://finnhub.io/api/v1"

export type FinnhubQuote = {
  c: number
  d: number
  dp: number
  h: number
  l: number
  o: number
  pc: number
  t: number
}

export type QuoteResult = {
  symbol: string
  label: string
  price: number
  change: number
  changePercent: number
  high: number
  low: number
  open: number
  prevClose: number
  timestamp: number
}

export const INDEX_SYMBOLS = [
  { label: "S&P 500", symbol: "SPY" },
  { label: "NASDAQ", symbol: "QQQ" },
  { label: "DOW", symbol: "DIA" },
  { label: "VIX", symbol: "VIX" },
] as const

export const FOREX_SYMBOLS = [
  { pair: "EURUSD", symbol: "OANDA:EUR_USD" },
  { pair: "GBPUSD", symbol: "OANDA:GBP_USD" },
  { pair: "USDJPY", symbol: "OANDA:USD_JPY" },
] as const

/** Build a Finnhub-shaped quote from the free Yahoo v8 chart snapshot. */
async function fetchYahooFallbackQuote(symbol: string): Promise<FinnhubQuote | null> {
  const y = await fetchYahooQuoteFull(symbol)
  if (!y || !y.price) return null
  const change = y.price - y.prevClose
  const changePct = y.prevClose ? (change / y.prevClose) * 100 : 0
  return {
    c: y.price,
    d: change,
    dp: changePct,
    h: y.high,
    l: y.low,
    o: y.open,
    pc: y.prevClose,
    t: y.timeSec,
  }
}

async function fetchFinnhubQuote(symbol: string): Promise<FinnhubQuote | null> {
  const resolved = resolveQuoteSymbol(symbol)
  const url = new URL(`${FINNHUB_BASE_URL}/quote`)
  url.searchParams.set("symbol", resolved)
  url.searchParams.set("token", FINNHUB_API_KEY)

  try {
    const res = await fetch(url.toString(), {
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(5500),
    })
    if (!res.ok) return null
    const data = (await res.json()) as FinnhubQuote
    if (data.c && data.c !== 0) return data
  } catch {
    /* fall through */
  }
  return null
}

async function fetchMetalSpotQuote(symbol: string): Promise<FinnhubQuote | null> {
  const bare = resolveQuoteSymbol(symbol).replace("OANDA:", "")
  const isGold = /XAU|GOLD/i.test(bare)
  const isSilver = /XAG|SILVER/i.test(bare)
  if (!isGold && !isSilver) return null

  const spot = await fetchGoldSpot(isGold ? "gold" : "silver")
  if (!spot?.pricePerOzUsd) return null
  const now = Math.floor(Date.now() / 1000)
  return {
    c: spot.pricePerOzUsd,
    d: spot.changeUsd,
    dp: spot.changePct,
    h: spot.pricePerOzUsd,
    l: spot.pricePerOzUsd,
    o: spot.pricePerOzUsd - spot.changeUsd,
    pc: spot.pricePerOzUsd - spot.changeUsd,
    t: now,
  }
}

export async function fetchQuote(symbol: string): Promise<FinnhubQuote | null> {
  const endpoint = getCandleEndpoint(symbol)
  const resolved = resolveQuoteSymbol(symbol)
  const isMetal = /XAU|XAG|GOLD|SILVER/i.test(resolved)

  const [finnhub, yahoo, metalSpot] = await Promise.all([
    fetchFinnhubQuote(symbol),
    fetchYahooFallbackQuote(symbol),
    isMetal ? fetchMetalSpotQuote(symbol) : Promise.resolve(null),
  ])

  if (isMetal) return metalSpot ?? yahoo ?? finnhub
  if (endpoint === "forex" || endpoint === "crypto") return yahoo ?? finnhub
  return finnhub ?? yahoo
}

export async function fetchQuotes(
  items: { symbol: string; label?: string }[]
): Promise<QuoteResult[]> {
  const results: QuoteResult[] = []
  const chunkSize = 4
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize)
    const chunkResults = await Promise.all(
      chunk.map(async ({ symbol, label }) => {
        const q = await fetchQuote(symbol)
        if (!q) return null
        return {
          symbol,
          label: label || symbol,
          price: q.c,
          change: q.d,
          changePercent: q.dp,
          high: q.h,
          low: q.l,
          open: q.o,
          prevClose: q.pc,
          timestamp: q.t,
        }
      })
    )
    for (const row of chunkResults) {
      if (row) results.push(row)
    }
  }
  return results
}

export type MarketNewsItem = {
  id: number
  headline: string
  summary: string
  source: string
  url: string
  datetime: number
  category: string
  /** Hero image URL when Finnhub provides one. */
  image?: string
  /** Comma-separated related symbols (e.g. "AAPL,MSFT"). */
  related?: string
}

async function fetchNewsCategory(category: string, limit: number): Promise<MarketNewsItem[]> {
  const url = new URL(`${FINNHUB_BASE_URL}/news`)
  url.searchParams.set('category', category)
  url.searchParams.set('token', FINNHUB_API_KEY)

  const res = await fetch(url.toString(), { cache: 'no-store' })
  if (!res.ok) return []

  const data = (await res.json()) as MarketNewsItem[]
  return Array.isArray(data) ? data : []
}

export async function fetchMarketNews(limit = 8): Promise<MarketNewsItem[]> {
  const data = await fetchNewsCategory('general', limit)
  return data.slice(0, limit)
}

/** General + forex headlines merged and deduped. */
export async function fetchMarketNewsFeed(limit = 24): Promise<MarketNewsItem[]> {
  const [general, forex] = await Promise.all([
    fetchNewsCategory('general', limit),
    fetchNewsCategory('forex', limit),
  ])

  const seen = new Set<number>()
  const merged: MarketNewsItem[] = []
  for (const item of [...forex, ...general]) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }

  return merged
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, limit)
}

/**
 * Per-symbol company news. Finnhub returns up to ~1 year of headlines.
 * `daysBack` defaults to 7. Works only for true equity tickers (e.g. AAPL);
 * returns empty for FX/crypto/index proxies.
 */
export async function fetchCompanyNews(
  symbol: string,
  daysBack = 7,
  limit = 8
): Promise<MarketNewsItem[]> {
  const ticker = symbol.split(':').pop() ?? symbol
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return []

  const to = new Date()
  const from = new Date(to.getTime() - daysBack * 86_400_000)
  const toStr = to.toISOString().split('T')[0]
  const fromStr = from.toISOString().split('T')[0]

  const url = new URL(`${FINNHUB_BASE_URL}/company-news`)
  url.searchParams.set('symbol', ticker)
  url.searchParams.set('from', fromStr)
  url.searchParams.set('to', toStr)
  url.searchParams.set('token', FINNHUB_API_KEY)

  const res = await fetch(url.toString(), { cache: 'no-store' })
  if (!res.ok) return []

  const data = (await res.json()) as MarketNewsItem[]
  if (!Array.isArray(data)) return []
  return data.sort((a, b) => b.datetime - a.datetime).slice(0, limit)
}

export function sentimentFromHeadline(headline: string): "bullish" | "bearish" | "neutral" {
  const text = headline.toLowerCase()
  const bullish = ["surge", "rally", "gain", "beat", "rise", "high", "bull", "growth", "up"]
  const bearish = ["fall", "drop", "decline", "loss", "bear", "crash", "down", "cut", "recession", "fear"]
  const b = bullish.filter((w) => text.includes(w)).length
  const s = bearish.filter((w) => text.includes(w)).length
  if (b > s) return "bullish"
  if (s > b) return "bearish"
  return "neutral"
}

export function formatTimeAgo(unixSeconds: number): string {
  const diff = Date.now() - unixSeconds * 1000
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${Math.max(1, mins)}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

type FinnhubSearchResult = {
  description: string
  displaySymbol: string
  symbol: string
  type: string
  mic?: string
}

export type FinnhubEconomicCalendarItem = {
  country?: string
  event?: string
  impact?: string
  time?: string
  date?: string
  estimate?: number | string
  actual?: number | string
  prev?: number | string
  unit?: string
}

export async function fetchFinnhubEconomicCalendar(
  fromDate: string,
  toDate: string
): Promise<FinnhubEconomicCalendarItem[]> {
  const url = new URL(`${FINNHUB_BASE_URL}/calendar/economic`)
  url.searchParams.set('from', fromDate)
  url.searchParams.set('to', toDate)
  url.searchParams.set('token', FINNHUB_API_KEY)

  const res = await fetch(url.toString(), { cache: 'no-store' })
  if (!res.ok) return []

  const data = (await res.json()) as {
    economicCalendar?: FinnhubEconomicCalendarItem[]
  }
  return Array.isArray(data.economicCalendar) ? data.economicCalendar : []
}

export async function searchSymbols(query: string, limit = 20): Promise<SymbolMeta[]> {
  const q = query.trim()
  if (q.length < 1) return []

  const url = new URL(`${FINNHUB_BASE_URL}/search`)
  url.searchParams.set("q", q)
  url.searchParams.set("token", FINNHUB_API_KEY)

  const res = await fetch(url.toString(), { cache: "no-store" })
  if (!res.ok) return []

  const data = (await res.json()) as { result?: FinnhubSearchResult[] }
  if (!Array.isArray(data.result)) return []

  return data.result.slice(0, limit).map((item) => ({
    symbol: item.symbol,
    displaySymbol: item.displaySymbol || item.symbol,
    description: item.description,
    type: inferSymbolType(item.symbol, item.type),
    exchange: item.mic || item.symbol.split(":")[0],
  }))
}
