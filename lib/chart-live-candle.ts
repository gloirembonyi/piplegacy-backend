import type { ChartCandle } from '@/lib/chart-drawings'

/** Bar period length in milliseconds for our chart resolutions. */
export function resolutionToMs(resolution: string): number {
  switch (resolution) {
    case '1':
      return 60_000
    case '3':
      return 3 * 60_000
    case '5':
      return 5 * 60_000
    case '15':
      return 15 * 60_000
    case '30':
      return 30 * 60_000
    case '60':
    case '1h':
      return 60 * 60_000
    case '240':
    case '4h':
      return 4 * 60 * 60_000
    case 'D':
    case '1d':
      return 24 * 60 * 60_000
    case 'W':
      return 7 * 24 * 60 * 60_000
    default:
      return 60 * 60_000
  }
}

/** Snap any provider timestamp to the UTC open of its bar (TradingView-style). */
export function snapToBarOpenMs(t: number, resolution: string): number {
  const ms = t < 1e12 ? t * 1000 : t
  if (resolution === 'D' || resolution === '1d') {
    const d = new Date(ms)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  }
  if (resolution === 'W') {
    const d = new Date(ms)
    const day = d.getUTCDay()
    const diff = day === 0 ? 6 : day - 1
    d.setUTCDate(d.getUTCDate() - diff)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  }
  const period = resolutionToMs(resolution)
  return Math.floor(ms / period) * period
}

/** Max wick extension below/above the body as a fraction of price (per resolution). */
function maxWickRatio(resolution: string): number {
  switch (resolution) {
    case '1':
      return 0.0008
    case '5':
      return 0.0015
    case '15':
      return 0.0025
    case '60':
    case '1h':
      return 0.004
    case 'D':
    case '1d':
      return 0.012
    default:
      return 0.002
  }
}

/**
 * Fix corrupt provider ticks (common on GC=F / thin FX feeds) where low spikes
 * far below the body and creates the "picket fence" comb on the chart.
 */
export function sanitizeCandleBar(c: ChartCandle, resolution: string): ChartCandle {
  let { o, h, l, c: cl } = c
  if (![o, h, l, cl].every((v) => Number.isFinite(v) && v > 0)) return c

  const bodyHi = Math.max(o, cl)
  const bodyLo = Math.min(o, cl)
  const mid = (bodyHi + bodyLo) / 2
  const maxExt = Math.max(mid * maxWickRatio(resolution), mid * 0.00025)

  h = Math.max(h, bodyHi)
  l = Math.min(l, bodyLo)

  if (bodyLo - l > maxExt) l = bodyLo - maxExt
  if (h - bodyHi > maxExt) h = bodyHi + maxExt

  l = Math.min(l, bodyLo)
  h = Math.max(h, bodyHi)

  return { ...c, o, h, l, c: cl }
}

export function sanitizeCandleSeries(
  candles: ChartCandle[],
  resolution: string
): ChartCandle[] {
  return candles.map((bar) => sanitizeCandleBar(bar, resolution))
}

export type LiveQuoteSnap = {
  price: number
  /** Unix seconds from the quote provider. */
  timeSec?: number
}

/**
 * Merge a live tick into the candle series so the forming bar moves like
 * TradingView: update close/high/low on the current bucket, or append a new bar
 * when the period rolls.
 */
export function mergeLiveQuoteIntoCandles(
  candles: ChartCandle[],
  quote: LiveQuoteSnap,
  resolution: string
): ChartCandle[] {
  const livePrice = quote.price
  if (!candles.length || !Number.isFinite(livePrice) || livePrice <= 0) {
    return candles
  }

  const nowMs = quote.timeSec ? quote.timeSec * 1000 : Date.now()
  const currentBarOpen = snapToBarOpenMs(nowMs, resolution)
  const result = candles.map((c) => ({
    ...c,
    t: snapToBarOpenMs(c.t, resolution),
  }))

  const last = result[result.length - 1]!
  const lastBarOpen = snapToBarOpenMs(last.t, resolution)

  if (currentBarOpen > lastBarOpen) {
    result.push({
      t: currentBarOpen,
      o: livePrice,
      h: livePrice,
      l: livePrice,
      c: livePrice,
    })
  } else {
    result[result.length - 1] = sanitizeCandleBar(
      {
        ...last,
        t: lastBarOpen,
        c: livePrice,
        h: Math.max(last.h, livePrice),
        l: Math.min(last.l, livePrice),
      },
      resolution
    )
  }

  return result
}

/** Normalize provider candles to bar-open timestamps; merge OHLC when deduping. */
export function normalizeCandleTimestamps(
  candles: ChartCandle[],
  resolution: string
): ChartCandle[] {
  const map = new Map<number, ChartCandle>()
  for (const raw of candles) {
    const t = snapToBarOpenMs(raw.t, resolution)
    const c = sanitizeCandleBar({ ...raw, t }, resolution)
    const existing = map.get(t)
    if (!existing) {
      map.set(t, c)
      continue
    }
    map.set(t, {
      t,
      o: existing.o,
      h: Math.max(existing.h, c.h),
      l: Math.min(existing.l, c.l),
      c: c.c,
      v: (existing.v ?? 0) + (c.v ?? 0),
    })
  }
  return [...map.values()]
    .map((bar) => sanitizeCandleBar(bar, resolution))
    .sort((a, b) => a.t - b.t)
}

/** Recent candle range for autoscale - ignore far-away drawing levels. */
export function recentCandlePriceRange(
  candles: ChartCandle[],
  lookback = 80
): { min: number; max: number } | null {
  const recent = candles.slice(-lookback)
  if (!recent.length) return null
  const lows = recent.map((c) => c.l).filter((p) => p > 0)
  const highs = recent.map((c) => c.h).filter((p) => p > 0)
  if (!lows.length || !highs.length) return null
  return { min: Math.min(...lows), max: Math.max(...highs) }
}

/** Keep drawing levels that sit near the visible candle range. */
export function filterDrawingPricesForScale(
  prices: number[],
  candleRange: { min: number; max: number } | null,
  padRatio = 0.12
): number[] {
  if (!candleRange) return prices
  const span = candleRange.max - candleRange.min || candleRange.max * 0.01
  const lo = candleRange.min - span * padRatio
  const hi = candleRange.max + span * padRatio
  return prices.filter((p) => Number.isFinite(p) && p > 0 && p >= lo && p <= hi)
}
