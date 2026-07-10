/**
 * Unified candle fetcher for specialist agents.
 *
 * Specialists need OHLC for *any* asset class - stocks, forex, metals, crypto.
 * Free providers are scattered:
 *   - FMP            → US stocks daily
 *   - Alpha Vantage  → US stocks daily (backup)
 *   - Yahoo Finance  → everything (stocks, forex, metals, crypto, intraday + daily)
 *   - Finnhub        → stocks/forex/crypto intraday (often deprecated for free)
 *
 * This module picks the broadest provider that returns ≥10 bars for the
 * requested resolution, so specialists work uniformly for XAUUSD, EURUSD,
 * AAPL, and BTCUSD.
 */

import { fetchMarketCandles, type CandleBar } from '@/lib/candle-providers'
import { fetchYahooCandles } from '@/lib/candle-providers/yahoo'
import { getCandleEndpoint, resolveQuoteSymbol } from '@/lib/symbols'

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'demo'
const FINNHUB_BASE = 'https://finnhub.io/api/v1'

export type SpecialistCandles = {
  bars: CandleBar[]
  source: 'fmp' | 'alpha-vantage' | 'yahoo' | 'finnhub' | 'none'
  resolution: string
}

function resolutionToSeconds(resolution: string): number {
  if (resolution === 'D' || resolution === '1d') return 86_400
  if (resolution === '4h') return 4 * 3600
  if (resolution === '1h' || resolution === '60') return 3600
  const n = Number(resolution)
  return Number.isFinite(n) ? n * 60 : 86_400
}

function lookbackSeconds(resolution: string): number {
  if (resolution === 'D' || resolution === '1d') return 400 * 86_400
  if (resolution === '4h') return 180 * 86_400
  if (resolution === '1h' || resolution === '60') return 60 * 86_400
  if (resolution === '30') return 21 * 86_400
  if (resolution === '15') return 14 * 86_400
  if (resolution === '5') return 7 * 86_400
  return 3 * 86_400
}

function normalizeRes(resolution: string): string {
  const map: Record<string, string> = {
    '1d': 'D',
    '1D': 'D',
    '4h': '4h',
    '1h': '60',
    '60m': '60',
  }
  return map[resolution] ?? resolution
}

async function fetchFinnhub(
  symbol: string,
  resolution: string
): Promise<CandleBar[]> {
  const res = normalizeRes(resolution)
  if (res === '4h') return [] // Finnhub doesn't expose 4h natively
  const resolved = resolveQuoteSymbol(symbol)
  const endpoint = getCandleEndpoint(symbol)
  const toSec = Math.floor(Date.now() / 1000)
  const fromSec = toSec - lookbackSeconds(res)

  const paths =
    endpoint === 'forex'
      ? [`${FINNHUB_BASE}/forex/candle`, `${FINNHUB_BASE}/stock/candle`]
      : endpoint === 'crypto'
        ? [`${FINNHUB_BASE}/crypto/candle`, `${FINNHUB_BASE}/stock/candle`]
        : [`${FINNHUB_BASE}/stock/candle`]

  for (const base of paths) {
    const url = new URL(base)
    url.searchParams.set('symbol', resolved)
    url.searchParams.set('resolution', res === 'D' ? 'D' : res)
    url.searchParams.set('from', String(fromSec))
    url.searchParams.set('to', String(toSec))
    url.searchParams.set('token', FINNHUB_API_KEY)

    try {
      const r = await fetch(url.toString(), {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      })
      if (!r.ok) continue
      const data = (await r.json()) as {
        s?: string
        t?: number[]
        o?: number[]
        h?: number[]
        l?: number[]
        c?: number[]
        v?: number[]
      }
      if (data.s !== 'ok' || !data.t?.length) continue
      return data.t.map((t, i) => ({
        t,
        o: data.o![i],
        h: data.h![i],
        l: data.l![i],
        c: data.c![i],
        v: data.v?.[i] ?? 0,
      }))
    } catch {
      /* try next path */
    }
  }
  return []
}

/**
 * Pull candles for a specialist. Tries Yahoo first (broad coverage, free,
 * no key), then Finnhub for intraday, then daily fallback via FMP/AV.
 *
 * `minBars` controls when we accept a dataset - defaults to 30 for daily
 * (enough for SMA20/SMA50) and 20 for intraday.
 */
export async function fetchSpecialistCandles(
  symbol: string,
  resolution: string,
  minBars?: number,
  cache?: Map<string, SpecialistCandles>
): Promise<SpecialistCandles> {
  const res = normalizeRes(resolution)
  const needBars = minBars ?? (res === 'D' ? 30 : 20)
  const cacheKey = `${symbol.toUpperCase()}:${res}:${needBars}`

  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey)!
  }

  const result = await fetchSpecialistCandlesUncached(symbol, resolution, needBars)
  cache?.set(cacheKey, result)
  return result
}

async function fetchSpecialistCandlesUncached(
  symbol: string,
  resolution: string,
  needBars: number
): Promise<SpecialistCandles> {
  const res = normalizeRes(resolution)
  // 1. Yahoo first - works for forex/metals/crypto/stocks on free tier.
  const yahoo = await fetchYahooCandles(symbol, res, 400).catch(() => [])
  if (yahoo.length >= needBars) {
    return { bars: yahoo, source: 'yahoo', resolution: res }
  }

  // 2. For intraday, try Finnhub as a second source.
  if (res !== 'D' && res !== '4h') {
    const finnhub = await fetchFinnhub(symbol, res)
    if (finnhub.length >= needBars) {
      return { bars: finnhub, source: 'finnhub', resolution: res }
    }
  }

  // 3. For daily, fall back to FMP/AV (good for US stocks).
  if (res === 'D') {
    const daily = await fetchMarketCandles(symbol, 'D')
    if (daily.data.length >= needBars) {
      return {
        bars: daily.data,
        source: daily.source as SpecialistCandles['source'],
        resolution: res,
      }
    }
  }

  // 4. Return whatever we got - even short series - so specialists can degrade
  //    gracefully with a warning rather than crashing.
  if (yahoo.length > 0) return { bars: yahoo, source: 'yahoo', resolution: res }

  return { bars: [], source: 'none', resolution: res }
}

/** Fetch candles using the shared cache on SpecialistContext. */
export function fetchSpecialistCandlesForContext(
  ctx: { symbol: string; candleCache?: Map<string, SpecialistCandles> },
  resolution: string,
  minBars?: number
): Promise<SpecialistCandles> {
  return fetchSpecialistCandles(ctx.symbol, resolution, minBars, ctx.candleCache)
}
