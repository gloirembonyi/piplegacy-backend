import { fetchMarketCandles, type CandleBar } from '@/lib/candle-providers'
import { fetchYahooCandles } from '@/lib/candle-providers/yahoo'
import {
  normalizeCandleTimestamps,
  sanitizeCandleSeries,
} from '@/lib/chart-live-candle'
import { getCandleEndpoint, resolveQuoteSymbol } from '@/lib/symbols'
import type { ChartCandle } from '@/lib/chart-drawings'

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'demo'
const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1'

function toChartCandles(bars: CandleBar[], resolution: string): ChartCandle[] {
  const rows = bars
    .map((b) => ({
      t: b.t < 1e12 ? b.t * 1000 : b.t,
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
      v: b.v,
    }))
    .sort((a, b) => a.t - b.t)
  return normalizeCandleTimestamps(rows, resolution)
}

/** Finnhub-supported candle resolutions (3m and 4h are Yahoo-only). */
function resolutionToFinnhub(resolution: string): string | null {
  const map: Record<string, string> = {
    '1': '1',
    '5': '5',
    '15': '15',
    '30': '30',
    '60': '60',
    D: 'D',
    W: 'W',
  }
  return map[resolution] ?? null
}

function lookbackSeconds(finnhubRes: string): number {
  if (finnhubRes === 'D') return 400 * 86400
  if (finnhubRes === 'W') return 365 * 3 * 86400
  if (finnhubRes === '60') return 45 * 86400
  if (finnhubRes === '30') return 21 * 86400
  if (finnhubRes === '15') return 14 * 86400
  if (finnhubRes === '5') return 7 * 86400
  if (finnhubRes === '1') return 3 * 86400
  return 3 * 86400
}

function isNumericIntraday(resolution: string): boolean {
  return /^\d+$/.test(resolution)
}

async function fetchFinnhubCandles(
  symbol: string,
  finnhubRes: string,
  resolution: string
): Promise<ChartCandle[]> {
  const resolved = resolveQuoteSymbol(symbol)
  const endpoint = getCandleEndpoint(symbol)
  const toSec = Math.floor(Date.now() / 1000)
  const fromSec = toSec - lookbackSeconds(finnhubRes)

  const paths =
    endpoint === 'forex'
      ? [`${FINNHUB_BASE_URL}/forex/candle`, `${FINNHUB_BASE_URL}/stock/candle`]
      : endpoint === 'crypto'
        ? [`${FINNHUB_BASE_URL}/crypto/candle`, `${FINNHUB_BASE_URL}/stock/candle`]
        : [`${FINNHUB_BASE_URL}/stock/candle`]

  for (const base of paths) {
    const url = new URL(base)
    url.searchParams.set('symbol', resolved)
    url.searchParams.set('resolution', finnhubRes === 'D' ? 'D' : finnhubRes)
    url.searchParams.set('from', String(fromSec))
    url.searchParams.set('to', String(toSec))
    url.searchParams.set('token', FINNHUB_API_KEY)

    const res = await fetch(url.toString(), {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) continue

    const data = (await res.json()) as {
      s?: string
      t?: number[]
      o?: number[]
      h?: number[]
      l?: number[]
      c?: number[]
      v?: number[]
    }

    if (data.s !== 'ok' || !data.t?.length) continue

    const rows = data.t.map((t, i) => ({
      t: t * 1000,
      o: data.o![i],
      h: data.h![i],
      l: data.l![i],
      c: data.c![i],
      ...(data.v?.[i] != null && data.v[i] > 0 ? { v: data.v[i] } : {}),
    }))
    return normalizeCandleTimestamps(rows, resolution)
  }

  return []
}

function pickIntradaySeries(
  yahoo: ChartCandle[],
  finnhub: ChartCandle[],
  yahooPreferred: boolean
): ChartCandle[] {
  if (yahooPreferred) {
    return yahoo.length >= 10 ? yahoo : finnhub
  }
  return finnhub.length >= 10 ? finnhub : yahoo
}

/**
 * Real OHLC bars for the chart overlay.
 *
 * For intraday resolutions (1/3/5/15/30/60/240) we want TRUE intraday candles -
 * not a daily series squeezed onto a minute chart. Order:
 *   1. Yahoo + Finnhub in parallel (Yahoo preferred for FX/crypto on free tier)
 *   2. Daily candles (last-ditch so the chart is never blank)
 */
export async function fetchChartOverlayCandles(
  symbol: string,
  resolution: string
): Promise<ChartCandle[]> {
  const finnhubRes = resolutionToFinnhub(resolution)
  const endpoint = getCandleEndpoint(symbol)
  const yahooPreferred = endpoint === 'forex' || endpoint === 'crypto'

  if (resolution === 'W' || finnhubRes === 'W') {
    const yahooWeekly = toChartCandles(await fetchYahooCandles(symbol, 'W', 300), 'W')
    if (yahooWeekly.length >= 10) {
      return sanitizeCandleSeries(yahooWeekly, 'W').slice(-300)
    }
    const finnhubWeekly = await fetchFinnhubCandles(symbol, 'W', 'W')
    if (finnhubWeekly.length >= 10) {
      return sanitizeCandleSeries(finnhubWeekly, 'W').slice(-300)
    }
  }

  if (resolution === 'D' || finnhubRes === 'D') {
    const yahooDaily = toChartCandles(await fetchYahooCandles(symbol, 'D', 500), 'D')
    if (yahooDaily.length >= 30) return yahooDaily.slice(-400)
  } else if (isNumericIntraday(resolution)) {
    const [yahooBars, finnhubBars] = await Promise.all([
      fetchYahooCandles(symbol, resolution, 500).catch(() => [] as CandleBar[]),
      finnhubRes
        ? fetchFinnhubCandles(symbol, finnhubRes, resolution)
        : Promise.resolve([] as ChartCandle[]),
    ])

    const primary = pickIntradaySeries(
      toChartCandles(yahooBars, resolution),
      finnhubBars,
      yahooPreferred
    )

    if (primary.length >= 10) {
      return sanitizeCandleSeries(primary, resolution).slice(-300)
    }
  }

  const daily = await fetchMarketCandles(symbol, 'D')
  if (daily.data.length >= 10) {
    return toChartCandles(daily.data, 'D').slice(-400)
  }

  const yahooHourly = toChartCandles(await fetchYahooCandles(symbol, '60', 300), '60')
  if (yahooHourly.length >= 10) return yahooHourly.slice(-300)

  const intraday = await fetchFinnhubCandles(symbol, '60', '60')
  return intraday.slice(-300)
}
