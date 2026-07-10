/**
 * Smart Money Concepts (SMC) specialist - looks at the price like a market
 * maker would. Detects the tricks the user explicitly called out:
 *
 *   - **Liquidity pools**: equal highs / equal lows where stops cluster.
 *     Price tends to "hunt" these before reversing.
 *   - **Liquidity sweep / stop hunt**: a candle that wicks beyond a swing
 *     high/low (taking out stops) and closes back inside → reversal signal.
 *   - **Inducement**: a small fake move into a minor S/R level to lure
 *     breakout traders before the real move starts in the opposite direction.
 *   - **Order Block (OB)**: the LAST opposite-color candle before a strong
 *     impulse - institutions tend to revisit it for entries.
 *   - **Fair Value Gap (FVG)**: an imbalance where price moved so fast that
 *     bar i+1 didn't overlap bar i's range - magnets for price.
 *   - **Break of Structure (BOS)**: close above last swing high in an uptrend
 *     (or below last swing low in a downtrend) → continuation.
 *   - **Change of Character (CHoCH)**: first lower-high in an uptrend (or
 *     first higher-low in a downtrend) → reversal warning.
 *
 * All detection is pure rule-based - no LLM needed. The LLM is only used to
 * write a clean headline; if exhausted, the rule-based output stands.
 */

import { fetchSpecialistCandlesForContext } from '@/lib/agent/specialists/candles'
import {
  clamp,
  degradedReport,
  timeframeToResolution,
  type SpecialistContext,
} from '@/lib/agent/specialists/helpers'
import type { SpecialistReport } from '@/lib/agent/pipeline-types'
import type { CandleBar } from '@/lib/candle-providers'

type Signal = {
  kind:
    | 'bullish-liquidity-sweep'
    | 'bearish-liquidity-sweep'
    | 'bullish-bos'
    | 'bearish-bos'
    | 'bullish-choch'
    | 'bearish-choch'
    | 'bullish-order-block'
    | 'bearish-order-block'
    | 'bullish-fvg'
    | 'bearish-fvg'
    | 'equal-highs-liquidity'
    | 'equal-lows-liquidity'
    | 'inducement-above'
    | 'inducement-below'
  /** Bar index in the input array where the signal fired. */
  at: number
  /** Price level (the liquidity level or OB midpoint). */
  level: number
  /** Strength 0-100 of this individual signal. */
  strength: number
  detail: string
}

/** Find swing highs/lows with a 2-bar lookback. */
function findSwings(bars: CandleBar[]): {
  highs: Array<{ at: number; price: number }>
  lows: Array<{ at: number; price: number }>
} {
  const highs: Array<{ at: number; price: number }> = []
  const lows: Array<{ at: number; price: number }> = []
  for (let i = 2; i < bars.length - 2; i++) {
    const b = bars[i]
    if (
      b.h > bars[i - 1].h &&
      b.h > bars[i - 2].h &&
      b.h > bars[i + 1].h &&
      b.h > bars[i + 2].h
    ) {
      highs.push({ at: i, price: b.h })
    }
    if (
      b.l < bars[i - 1].l &&
      b.l < bars[i - 2].l &&
      b.l < bars[i + 1].l &&
      b.l < bars[i + 2].l
    ) {
      lows.push({ at: i, price: b.l })
    }
  }
  return { highs, lows }
}

/** Liquidity pools = pairs of swing highs/lows within 0.1% of each other. */
function detectLiquidityPools(
  swings: ReturnType<typeof findSwings>,
  tolerance = 0.001
): Signal[] {
  const out: Signal[] = []
  const checkPair = (
    arr: Array<{ at: number; price: number }>,
    kind: 'equal-highs-liquidity' | 'equal-lows-liquidity'
  ) => {
    for (let i = 0; i < arr.length - 1; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]
        const b = arr[j]
        if (Math.abs(a.price - b.price) / a.price < tolerance) {
          out.push({
            kind,
            at: b.at,
            level: (a.price + b.price) / 2,
            strength: 60,
            detail: `Equal ${kind === 'equal-highs-liquidity' ? 'highs' : 'lows'} @ ${b.price.toFixed(5)}`,
          })
        }
      }
    }
  }
  checkPair(swings.highs, 'equal-highs-liquidity')
  checkPair(swings.lows, 'equal-lows-liquidity')
  return out
}

/**
 * Liquidity sweep: the most recent candle wicks BEYOND a recent swing high
 * (or low) but closes back INSIDE the prior range. That's a stop hunt.
 */
function detectLiquiditySweep(
  bars: CandleBar[],
  swings: ReturnType<typeof findSwings>
): Signal[] {
  if (bars.length < 5) return []
  const out: Signal[] = []
  const last = bars[bars.length - 1]
  const lastIdx = bars.length - 1

  // Recent swing high taken out by wick but closed back below.
  const prevHighs = swings.highs.filter((h) => h.at < lastIdx - 1).slice(-3)
  for (const h of prevHighs) {
    if (last.h > h.price && last.c < h.price) {
      out.push({
        kind: 'bearish-liquidity-sweep',
        at: lastIdx,
        level: h.price,
        strength: 75,
        detail: `Wick above ${h.price.toFixed(5)} swept stops then closed back inside`,
      })
    }
  }
  const prevLows = swings.lows.filter((l) => l.at < lastIdx - 1).slice(-3)
  for (const l of prevLows) {
    if (last.l < l.price && last.c > l.price) {
      out.push({
        kind: 'bullish-liquidity-sweep',
        at: lastIdx,
        level: l.price,
        strength: 75,
        detail: `Wick below ${l.price.toFixed(5)} swept stops then closed back inside`,
      })
    }
  }
  return out
}

/**
 * BOS = current close breaks last swing high (bullish) or last swing low (bearish).
 * CHoCH = AFTER a sequence of HH/HL, a new lower low forms (or vice versa).
 */
function detectStructure(
  bars: CandleBar[],
  swings: ReturnType<typeof findSwings>
): Signal[] {
  const out: Signal[] = []
  const last = bars[bars.length - 1]
  const lastIdx = bars.length - 1
  const lastHigh = swings.highs[swings.highs.length - 1]
  const lastLow = swings.lows[swings.lows.length - 1]

  // BOS - current candle close breaks recent swing.
  if (lastHigh && last.c > lastHigh.price) {
    out.push({
      kind: 'bullish-bos',
      at: lastIdx,
      level: lastHigh.price,
      strength: 70,
      detail: `Close ${last.c.toFixed(5)} > swing high ${lastHigh.price.toFixed(5)} - BOS up`,
    })
  }
  if (lastLow && last.c < lastLow.price) {
    out.push({
      kind: 'bearish-bos',
      at: lastIdx,
      level: lastLow.price,
      strength: 70,
      detail: `Close ${last.c.toFixed(5)} < swing low ${lastLow.price.toFixed(5)} - BOS down`,
    })
  }

  // CHoCH - last two swings show structure flip.
  if (swings.highs.length >= 2 && swings.lows.length >= 2) {
    const h2 = swings.highs[swings.highs.length - 1]
    const h1 = swings.highs[swings.highs.length - 2]
    const l2 = swings.lows[swings.lows.length - 1]
    const l1 = swings.lows[swings.lows.length - 2]
    // Was uptrend (HH+HL), now formed LL? CHoCH down.
    if (h1.price < h2.price && l1.price < l2.price && last.c < l2.price) {
      out.push({
        kind: 'bearish-choch',
        at: lastIdx,
        level: l2.price,
        strength: 72,
        detail: `Was HH-HL, now broke ${l2.price.toFixed(5)} - CHoCH bearish`,
      })
    }
    // Was downtrend (LH+LL), now formed HH? CHoCH up.
    if (h1.price > h2.price && l1.price > l2.price && last.c > h2.price) {
      out.push({
        kind: 'bullish-choch',
        at: lastIdx,
        level: h2.price,
        strength: 72,
        detail: `Was LH-LL, now broke ${h2.price.toFixed(5)} - CHoCH bullish`,
      })
    }
  }

  return out
}

/**
 * Order Block: the LAST opposite-color candle before a strong impulse
 * (>1.5×ATR in a single bar). Returns the most recent unmitigated OB.
 */
function detectOrderBlocks(bars: CandleBar[]): Signal[] {
  if (bars.length < 10) return []
  // Average true range over last 14 for "impulse" detection.
  let trSum = 0
  let trCount = 0
  for (let i = Math.max(1, bars.length - 15); i < bars.length; i++) {
    const a = bars[i].h - bars[i].l
    const b = Math.abs(bars[i].h - bars[i - 1].c)
    const c = Math.abs(bars[i].l - bars[i - 1].c)
    trSum += Math.max(a, b, c)
    trCount += 1
  }
  const avgTR = trCount > 0 ? trSum / trCount : 0
  if (avgTR <= 0) return []

  const out: Signal[] = []
  // Look at the last 10 bars for an impulse.
  for (let i = Math.max(1, bars.length - 10); i < bars.length; i++) {
    const b = bars[i]
    const body = Math.abs(b.c - b.o)
    if (body < avgTR * 1.5) continue
    const bullishImpulse = b.c > b.o
    // Find last opposite-color candle BEFORE this impulse.
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const c = bars[j]
      const cBull = c.c > c.o
      if (bullishImpulse && !cBull) {
        out.push({
          kind: 'bullish-order-block',
          at: j,
          level: (c.h + c.l) / 2,
          strength: 65,
          detail: `Bullish OB @ ${c.l.toFixed(5)}-${c.h.toFixed(5)} (last red before impulse)`,
        })
        break
      }
      if (!bullishImpulse && cBull) {
        out.push({
          kind: 'bearish-order-block',
          at: j,
          level: (c.h + c.l) / 2,
          strength: 65,
          detail: `Bearish OB @ ${c.l.toFixed(5)}-${c.h.toFixed(5)} (last green before impulse)`,
        })
        break
      }
    }
  }
  // Keep most recent OB only.
  return out.slice(-1)
}

/**
 * FVG: 3-candle imbalance - candle i+1's low > candle i's high (bullish FVG)
 * or candle i+1's high < candle i's low (bearish FVG).
 */
function detectFvgs(bars: CandleBar[]): Signal[] {
  if (bars.length < 5) return []
  const out: Signal[] = []
  for (let i = bars.length - 12; i < bars.length - 2; i++) {
    if (i < 1) continue
    const a = bars[i]
    const c = bars[i + 2]
    if (c.l > a.h) {
      out.push({
        kind: 'bullish-fvg',
        at: i + 1,
        level: (a.h + c.l) / 2,
        strength: 55,
        detail: `Bullish FVG @ ${a.h.toFixed(5)}-${c.l.toFixed(5)}`,
      })
    }
    if (c.h < a.l) {
      out.push({
        kind: 'bearish-fvg',
        at: i + 1,
        level: (a.h + c.l) / 2,
        strength: 55,
        detail: `Bearish FVG @ ${c.h.toFixed(5)}-${a.l.toFixed(5)}`,
      })
    }
  }
  return out.slice(-2)
}

/**
 * Inducement: small push beyond a minor recent level (within last 5 bars)
 * that gets immediately rejected. This is the "fake-out before the real move"
 * pattern market makers use to trigger breakout-trader stops.
 */
function detectInducement(bars: CandleBar[]): Signal[] {
  if (bars.length < 6) return []
  const out: Signal[] = []
  const last5 = bars.slice(-6, -1)
  const last = bars[bars.length - 1]
  if (!last5.length) return []
  const recentHigh = Math.max(...last5.map((b) => b.h))
  const recentLow = Math.min(...last5.map((b) => b.l))

  // Last bar pushed above recentHigh by < 0.1% then closed below the high.
  if (last.h > recentHigh && last.c < recentHigh && (last.h - recentHigh) / recentHigh < 0.002) {
    out.push({
      kind: 'inducement-above',
      at: bars.length - 1,
      level: recentHigh,
      strength: 60,
      detail: `Inducement above ${recentHigh.toFixed(5)} - fake breakout, expect drop`,
    })
  }
  if (last.l < recentLow && last.c > recentLow && (recentLow - last.l) / recentLow < 0.002) {
    out.push({
      kind: 'inducement-below',
      at: bars.length - 1,
      level: recentLow,
      strength: 60,
      detail: `Inducement below ${recentLow.toFixed(5)} - fake breakdown, expect rally`,
    })
  }
  return out
}

function bias(signals: Signal[]): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  let bull = 0
  let bear = 0
  for (const s of signals) {
    if (s.kind.startsWith('bullish-') || s.kind === 'inducement-below') bull += s.strength
    else if (s.kind.startsWith('bearish-') || s.kind === 'inducement-above') bear += s.strength
    // Liquidity pools are direction-neutral.
  }
  if (bull > bear * 1.2) return 'BULLISH'
  if (bear > bull * 1.2) return 'BEARISH'
  return 'NEUTRAL'
}

/** Plain-language read for the main LLM/orchestrator to reason over -
 * substantive analysis, not just a BULLISH/BEARISH tag. */
function buildSmcSituation(analysis: {
  confirmed: Array<{ detail: string }>
  speculative: Array<{ kind: string; detail: string }>
  liquidityPools: Array<{ detail: string }>
}): string {
  const parts: string[] = []
  if (analysis.confirmed[0]) parts.push(`Confirmed: ${analysis.confirmed[0].detail}`)
  const spec = analysis.speculative.find((s) => !s.kind.startsWith('equal-'))
  if (spec) parts.push(`Watching: ${spec.detail}`)
  if (analysis.liquidityPools.length > 0) {
    parts.push(
      `${analysis.liquidityPools.length} liquidity pool${analysis.liquidityPools.length > 1 ? 's' : ''} nearby (${analysis.liquidityPools[0].detail})`
    )
  }
  if (parts.length === 0) return 'No confirmed structure signal - flat/ranging price action, no clean SMC read.'
  return parts.join('; ').slice(0, 220)
}

export type SmcSignal = Signal

export type SmcAnalysisResult = {
  verdict: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  headline: string
  blockers: string[]
  confirmed: Array<{ kind: string; level: number; detail: string; strength: number }>
  speculative: Array<{ kind: string; level?: number; detail: string; strength: number }>
  liquidityPools: Array<{ kind: string; level: number; detail: string }>
  signals: Signal[]
  swings: {
    highs: Array<{ at: number; price: number }>
    lows: Array<{ at: number; price: number }>
  }
}

const CONFIRMED_KINDS = new Set([
  'bullish-liquidity-sweep',
  'bearish-liquidity-sweep',
  'bullish-bos',
  'bearish-bos',
  'bullish-choch',
  'bearish-choch',
])

/** Rule-based SMC pass - shared by pipeline specialist and liquidity sub-agent. */
export function analyzeSmcFromBars(bars: CandleBar[]): SmcAnalysisResult | null {
  if (bars.length < 20) return null
  const slice = bars.slice(-150)
  const swings = findSwings(slice)
  const signals: Signal[] = [
    ...detectLiquiditySweep(slice, swings),
    ...detectStructure(slice, swings),
    ...detectOrderBlocks(slice),
    ...detectFvgs(slice),
    ...detectInducement(slice),
    ...detectLiquidityPools(swings),
  ]
  const verdict = bias(signals)
  const dirSignals = signals.filter((s) => !s.kind.startsWith('equal-'))
  const totalStrength = dirSignals.reduce((sum, s) => sum + s.strength, 0)
  const confidence = clamp(
    dirSignals.length === 0 ? 35 : 45 + Math.round(totalStrength / Math.max(1, dirSignals.length)),
    0,
    90
  )
  const top = [...signals].sort((a, b) => b.at - a.at || b.strength - a.strength)[0]
  const headline = top ? top.detail : 'No clean SMC signal - flat structure'

  const blockers: string[] = []
  const induceUp = signals.find((s) => s.kind === 'inducement-above')
  const induceDown = signals.find((s) => s.kind === 'inducement-below')
  if (induceUp && verdict !== 'BEARISH') {
    blockers.push('Inducement above - likely fake breakout until sweep confirms')
  }
  if (induceDown && verdict !== 'BULLISH') {
    blockers.push('Inducement below - likely fake breakdown until sweep confirms')
  }

  const confirmed = signals
    .filter((s) => CONFIRMED_KINDS.has(s.kind))
    .map((s) => ({ kind: s.kind, level: s.level, detail: s.detail, strength: s.strength }))

  const speculative = signals
    .filter((s) => !CONFIRMED_KINDS.has(s.kind))
    .map((s) => ({
      kind: s.kind,
      level: s.level,
      detail: s.detail,
      strength: s.strength,
    }))

  const liquidityPools = signals
    .filter((s) => s.kind.startsWith('equal-'))
    .map((s) => ({ kind: s.kind, level: s.level, detail: s.detail }))

  return {
    verdict,
    confidence,
    headline,
    blockers,
    confirmed,
    speculative,
    liquidityPools,
    signals: signals.slice(0, 12),
    swings: { highs: swings.highs.slice(-4), lows: swings.lows.slice(-4) },
  }
}

export async function runSmcSpecialist(
  ctx: SpecialistContext
): Promise<SpecialistReport> {
  const start = Date.now()
  try {
    const resolution = timeframeToResolution(ctx.timeframe)
    const candles = await fetchSpecialistCandlesForContext(ctx, resolution, 30)
    if (candles.bars.length < 30) {
      return degradedReport(
        'smc',
        start,
        `Only ${candles.bars.length} ${ctx.timeframe} bars - SMC needs 30+`
      )
    }
    const bars = candles.bars.slice(-150)
    const analysis = analyzeSmcFromBars(bars)
    if (!analysis) {
      return degradedReport(
        'smc',
        start,
        `Only ${candles.bars.length} ${ctx.timeframe} bars - SMC needs 20+`
      )
    }
    const { verdict, confidence, headline, blockers, signals, swings } = analysis

    return {
      id: 'smc',
      verdict,
      confidence,
      headline,
      situation: buildSmcSituation(analysis),
      durationMs: Date.now() - start,
      blockers: blockers.length > 0 ? blockers : undefined,
      data: {
        signals: signals.slice(0, 10),
        swings: {
          highs: swings.highs.slice(-3),
          lows: swings.lows.slice(-3),
        },
        source: candles.source,
        confirmed: analysis.confirmed,
        speculative: analysis.speculative,
      },
    }
  } catch (err) {
    return degradedReport(
      'smc',
      start,
      err instanceof Error ? err.message : 'unknown error'
    )
  }
}
