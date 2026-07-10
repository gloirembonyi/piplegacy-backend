/**
 * Yahoo Finance unofficial chart endpoint.
 *
 * No API key needed. Supports the four asset classes the bot trades:
 *  - Stocks:  AAPL → AAPL
 *  - Forex:   EURUSD → EURUSD=X (OANDA:EUR_USD → EURUSD=X)
 *  - Metals:  XAUUSD → GC=F (gold), XAGUSD → SI=F (silver)
 *  - Crypto:  BTCUSD → BTC-USD (BINANCE:BTCUSDT → BTC-USD)
 *
 * This is the most reliable free fallback when FMP / Alpha Vantage / Finnhub
 * all fail for free-tier symbols (especially forex pairs and metals).
 */

import type { RawCandle } from '@/lib/candle-providers/fmp'

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const METAL_MAP: Record<string, string> = {
  XAUUSD: 'GC=F',
  XAGUSD: 'SI=F',
  XPTUSD: 'PL=F',
  XPDUSD: 'PA=F',
}

const CRYPTO_MAP: Record<string, string> = {
  BTCUSD: 'BTC-USD',
  BTCUSDT: 'BTC-USD',
  ETHUSD: 'ETH-USD',
  ETHUSDT: 'ETH-USD',
  SOLUSD: 'SOL-USD',
  SOLUSDT: 'SOL-USD',
  XRPUSD: 'XRP-USD',
  XRPUSDT: 'XRP-USD',
  DOGEUSD: 'DOGE-USD',
  AVAXUSD: 'AVAX-USD',
  ADAUSD: 'ADA-USD',
  LTCUSD: 'LTC-USD',
  BNBUSD: 'BNB-USD',
}

/** Strip exchange prefix and return the canonical bare ticker. */
function stripPrefix(symbol: string): string {
  const upper = symbol.trim().toUpperCase()
  if (upper.startsWith('OANDA:')) return upper.slice(6).replace('_', '')
  if (upper.startsWith('BINANCE:') || upper.startsWith('COINBASE:')) {
    return upper.split(':')[1] ?? upper
  }
  if (upper.startsWith('FX:')) return upper.slice(3)
  if (upper.startsWith('TVC:')) return upper.slice(4)
  if (upper.includes(':')) return upper.split(':')[1] ?? upper
  if (upper.includes('/')) return upper.replace('/', '')
  return upper
}

/** Map any input symbol to its Yahoo equivalent. */
export function toYahooSymbol(symbol: string): string {
  const bare = stripPrefix(symbol)

  if (METAL_MAP[bare]) return METAL_MAP[bare]
  if (CRYPTO_MAP[bare]) return CRYPTO_MAP[bare]

  // 6-letter forex pair (EURUSD, GBPJPY, etc.) → EURUSD=X
  if (/^[A-Z]{6}$/.test(bare)) {
    return `${bare}=X`
  }
  return bare
}

/** Yahoo `interval` strings - used directly in the query string. */
type YahooInterval = '1m' | '2m' | '3m' | '5m' | '15m' | '30m' | '60m' | '90m' | '1d' | '1wk' | '1mo'

/** Yahoo `range` strings. */
type YahooRange =
  | '1d'
  | '5d'
  | '1mo'
  | '3mo'
  | '6mo'
  | '1y'
  | '2y'
  | '5y'
  | 'max'
  | '60d'
  | '730d'

function rangeForInterval(interval: YahooInterval): YahooRange {
  switch (interval) {
    case '1m':
      // Yahoo caps 1-minute history at 7 days.
      return '5d'
    case '2m':
    case '3m':
    case '5m':
    case '15m':
    case '30m':
    case '90m':
      // Yahoo caps these sub-hour intervals at 60 days.
      return '60d'
    case '60m':
      // Hourly is allowed back ~2 years.
      return '730d'
    default:
      return '2y'
  }
}

type YahooResponse = {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number
        chartPreviousClose?: number
        previousClose?: number
        regularMarketTime?: number
        regularMarketDayHigh?: number
        regularMarketDayLow?: number
        regularMarketOpen?: number
        regularMarketVolume?: number
      }
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>
          high?: Array<number | null>
          low?: Array<number | null>
          close?: Array<number | null>
          volume?: Array<number | null>
        }>
      }
    }>
    error?: { description?: string } | null
  }
}

async function fetchYahoo(
  symbol: string,
  interval: YahooInterval,
  range?: YahooRange
): Promise<RawCandle[]> {
  const yahooSym = toYahooSymbol(symbol)
  const url = new URL(`${YAHOO_BASE}/${encodeURIComponent(yahooSym)}`)
  url.searchParams.set('interval', interval)
  url.searchParams.set('range', range ?? rangeForInterval(interval))
  url.searchParams.set('includePrePost', 'false')

  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return []
    const json = (await res.json()) as YahooResponse
    const result = json.chart?.result?.[0]
    const ts = result?.timestamp
    const q = result?.indicators?.quote?.[0]
    if (!ts || !q || !q.open || !q.high || !q.low || !q.close) return []

    const bars: RawCandle[] = []
    for (let i = 0; i < ts.length; i++) {
      const o = q.open[i]
      const h = q.high[i]
      const l = q.low[i]
      const c = q.close[i]
      if (o == null || h == null || l == null || c == null) continue
      bars.push({
        t: ts[i],
        o,
        h,
        l,
        c,
        v: q.volume?.[i] ?? 0,
      })
    }
    return bars
  } catch {
    return []
  }
}

export async function fetchYahooDailyCandles(
  symbol: string,
  limit = 400
): Promise<RawCandle[]> {
  const bars = await fetchYahoo(symbol, '1d', '2y')
  return bars.slice(-limit)
}

/** Map our resolution strings (1, 5, 15, 60, D) to Yahoo intervals. */
export function resolutionToYahoo(resolution: string): YahooInterval {
  switch (resolution) {
    case '1':
      return '1m'
    case '3':
      return '3m'
    case '5':
      return '5m'
    case '15':
      return '15m'
    case '30':
      return '30m'
    case '60':
      return '60m'
    case '1h':
      return '60m'
    case '240':
    case '4h':
      return '60m'
    case '1w':
    case 'W':
      return '1wk'
    case '1d':
    case 'D':
    default:
      return '1d'
  }
}

export async function fetchYahooCandles(
  symbol: string,
  resolution: string,
  limit = 300
): Promise<RawCandle[]> {
  const interval = resolutionToYahoo(resolution)
  const bars = await fetchYahoo(symbol, interval)
  return bars.slice(-limit)
}

/** Snapshot price from Yahoo's meta block - much faster than a full candle pull. */
export async function fetchYahooQuote(symbol: string): Promise<{
  price: number
  prevClose: number
} | null> {
  const full = await fetchYahooQuoteFull(symbol)
  if (!full) return null
  return { price: full.price, prevClose: full.prevClose }
}

export type YahooFullQuote = {
  price: number
  prevClose: number
  high: number
  low: number
  open: number
  volume: number
  timeSec: number
}

/**
 * Full OHLC snapshot via the (working) v8 chart endpoint. Pulls a short daily
 * window and combines the live `meta` block with the most recent candle so we
 * get price + day high/low/open + previous close + volume in a single call.
 * This is the reliable free quote source for forex / metals / crypto when
 * Finnhub's free tier returns nothing.
 */
export async function fetchYahooQuoteFull(
  symbol: string
): Promise<YahooFullQuote | null> {
  const yahooSym = toYahooSymbol(symbol)
  const url = new URL(`${YAHOO_BASE}/${encodeURIComponent(yahooSym)}`)
  url.searchParams.set('interval', '1d')
  url.searchParams.set('range', '5d')
  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as YahooResponse
    const result = json.chart?.result?.[0]
    const meta = result?.meta
    if (!meta?.regularMarketPrice) return null

    const ts = result?.timestamp ?? []
    const q = result?.indicators?.quote?.[0]
    // Last bar with a real close (today / most recent session).
    let lastIdx = -1
    if (q?.close) {
      for (let i = q.close.length - 1; i >= 0; i--) {
        if (q.close[i] != null) {
          lastIdx = i
          break
        }
      }
    }

    const price = meta.regularMarketPrice
    const prevClose =
      meta.chartPreviousClose ??
      meta.previousClose ??
      (lastIdx > 0 ? q?.close?.[lastIdx - 1] ?? price : price)

    const high =
      meta.regularMarketDayHigh ?? (lastIdx >= 0 ? q?.high?.[lastIdx] : null) ?? price
    const low =
      meta.regularMarketDayLow ?? (lastIdx >= 0 ? q?.low?.[lastIdx] : null) ?? price
    const open =
      meta.regularMarketOpen ?? (lastIdx >= 0 ? q?.open?.[lastIdx] : null) ?? price
    const volume =
      meta.regularMarketVolume ??
      (lastIdx >= 0 ? q?.volume?.[lastIdx] : null) ??
      0

    return {
      price,
      prevClose: prevClose ?? price,
      high: high ?? price,
      low: low ?? price,
      open: open ?? price,
      volume: volume ?? 0,
      timeSec: meta.regularMarketTime ?? (ts.length ? ts[ts.length - 1] : Math.floor(Date.now() / 1000)),
    }
  } catch {
    return null
  }
}
