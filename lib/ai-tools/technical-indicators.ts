/**
 * Lightweight technical indicators computed locally from OHLC bars.
 * Used by AI agent tools - no external API calls.
 */

import type { CandleBar as RawCandle } from '@/lib/candle-providers'

export type TechnicalSummary = {
  bars: number
  last: { o: number; h: number; l: number; c: number; t: number }
  changePct5: number | null
  changePct20: number | null
  sma20: number | null
  sma50: number | null
  ema21: number | null
  rsi14: number | null
  atr14: number | null
  swingHigh20: number | null
  swingLow20: number | null
  trend: 'bullish' | 'bearish' | 'neutral' | 'choppy'
  /** Macro structure clues - useful for SMC-style analysis. */
  recentHighs: number[]
  recentLows: number[]
}

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null
  let sum = 0
  for (let i = values.length - n; i < values.length; i++) sum += values[i]
  return sum / n
}

function ema(values: number[], n: number): number | null {
  if (values.length < n) return null
  const k = 2 / (n + 1)
  let prev = values.slice(0, n).reduce((a, c) => a + c, 0) / n
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
  }
  return prev
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gain += diff
    else loss -= diff
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function atr(bars: RawCandle[], period = 14): number | null {
  if (bars.length <= period) return null
  const trs: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i].h - bars[i].l
    const b = Math.abs(bars[i].h - bars[i - 1].c)
    const c = Math.abs(bars[i].l - bars[i - 1].c)
    trs.push(Math.max(a, b, c))
  }
  if (trs.length < period) return null
  const slice = trs.slice(-period)
  return slice.reduce((a, c) => a + c, 0) / slice.length
}

function findSwings(
  bars: RawCandle[],
  lookback = 3
): { highs: number[]; lows: number[] } {
  const highs: number[] = []
  const lows: number[] = []
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true
    let isLow = true
    for (let k = 1; k <= lookback; k++) {
      if (bars[i].h <= bars[i - k].h || bars[i].h <= bars[i + k].h) isHigh = false
      if (bars[i].l >= bars[i - k].l || bars[i].l >= bars[i + k].l) isLow = false
    }
    if (isHigh) highs.push(bars[i].h)
    if (isLow) lows.push(bars[i].l)
  }
  return { highs, lows }
}

export function computeTechnicalSummary(bars: RawCandle[]): TechnicalSummary | null {
  if (bars.length < 5) return null
  const sorted = [...bars].sort((a, b) => a.t - b.t)
  const closes = sorted.map((b) => b.c)
  const last = sorted[sorted.length - 1]

  const lookback5 = sorted[Math.max(0, sorted.length - 6)]
  const lookback20 = sorted[Math.max(0, sorted.length - 21)]
  const changePct5 = lookback5.c ? ((last.c - lookback5.c) / lookback5.c) * 100 : null
  const changePct20 = lookback20.c ? ((last.c - lookback20.c) / lookback20.c) * 100 : null

  const sma20 = sma(closes, 20)
  const sma50 = sma(closes, 50)
  const ema21 = ema(closes, 21)
  const rsi14 = rsi(closes, 14)
  const atr14 = atr(sorted, 14)

  const recent = sorted.slice(-20)
  const swingHigh20 = Math.max(...recent.map((b) => b.h))
  const swingLow20 = Math.min(...recent.map((b) => b.l))

  let trend: TechnicalSummary['trend'] = 'neutral'
  if (sma20 != null && sma50 != null) {
    if (last.c > sma20 && sma20 > sma50) trend = 'bullish'
    else if (last.c < sma20 && sma20 < sma50) trend = 'bearish'
    else trend = 'choppy'
  } else if (sma20 != null) {
    trend = last.c > sma20 * 1.002 ? 'bullish' : last.c < sma20 * 0.998 ? 'bearish' : 'neutral'
  }

  const { highs, lows } = findSwings(sorted.slice(-60))

  return {
    bars: sorted.length,
    last: { o: last.o, h: last.h, l: last.l, c: last.c, t: last.t },
    changePct5,
    changePct20,
    sma20,
    sma50,
    ema21,
    rsi14,
    atr14,
    swingHigh20,
    swingLow20,
    trend,
    recentHighs: highs.slice(-5),
    recentLows: lows.slice(-5),
  }
}
