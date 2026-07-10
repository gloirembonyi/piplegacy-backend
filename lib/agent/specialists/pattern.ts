/**
 * Pattern specialist - looks at the last ~60 bars on the trader's working
 * timeframe (NOT just daily) and classifies the dominant chart pattern.
 *
 * On 5m/15m this catches inside-bar breakouts, flag continuations, and
 * engulfings the daily-only version would miss.
 */

import { fetchSpecialistCandlesForContext } from '@/lib/agent/specialists/candles'
import {
  callSpecialistModel,
  clamp,
  degradedReport,
  normalizeVerdict,
  parseJsonish,
  timeframeMinutes,
  timeframeToResolution,
  type SpecialistContext,
} from '@/lib/agent/specialists/helpers'
import type { SpecialistReport } from '@/lib/agent/pipeline-types'
import type { CandleBar } from '@/lib/candle-providers'

const SYSTEM = `You are a price-action specialist. Classify the dominant pattern from the bars given on the trader's timeframe. Return ONE strict JSON object:
{"verdict":"BULLISH|BEARISH|NEUTRAL|AVOID","confidence":0..100,"headline":"<=120 chars","pattern":"primary pattern name","structure":"HH-HL | HL-LL | LH-LL | LH-HL | ranging | breakout | reversal","candleSignals":["short list"],"blockers":["short reason"]}

Trigger rules:
- Higher highs + higher lows (last 5-10 bars) → BULLISH, conf 65+.
- Lower lows + lower highs → BEARISH, conf 65+.
- Bullish engulfing or hammer at recent support → BULLISH, conf 60+.
- Bearish engulfing or shooting star at recent resistance → BEARISH, conf 60+.
- Break of recent range (highest high in last 20 bars taken out by a close) → BULLISH with structure "breakout".
- Inside-bar consolidation that breaks → trade the break direction.
- NEUTRAL only when bars are mixed and price has no clean structure.`

/** Light rule-based structure check so we never return blank. */
function structureHint(bars: CandleBar[]): {
  verdict: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  pattern: string
  confidence: number
} {
  if (bars.length < 8) return { verdict: 'NEUTRAL', pattern: 'no-structure', confidence: 30 }

  const recent = bars.slice(-10)
  const highs = recent.map((b) => b.h)
  const lows = recent.map((b) => b.l)

  // Higher highs and higher lows over the last 6 bars?
  const last6 = recent.slice(-6)
  const hh =
    last6.slice(1).every((b, i) => b.h >= last6[i].h * 0.999) &&
    last6[last6.length - 1].h > last6[0].h
  const hl =
    last6.slice(1).every((b, i) => b.l >= last6[i].l * 0.999) &&
    last6[last6.length - 1].l > last6[0].l
  if (hh && hl) return { verdict: 'BULLISH', pattern: 'higher-highs-higher-lows', confidence: 70 }

  const lh =
    last6.slice(1).every((b, i) => b.h <= last6[i].h * 1.001) &&
    last6[last6.length - 1].h < last6[0].h
  const ll =
    last6.slice(1).every((b, i) => b.l <= last6[i].l * 1.001) &&
    last6[last6.length - 1].l < last6[0].l
  if (lh && ll) return { verdict: 'BEARISH', pattern: 'lower-highs-lower-lows', confidence: 70 }

  // Range breakout
  const range20 = bars.slice(-21, -1)
  if (range20.length >= 15) {
    const rangeHigh = Math.max(...range20.map((b) => b.h))
    const rangeLow = Math.min(...range20.map((b) => b.l))
    const last = bars[bars.length - 1]
    if (last.c > rangeHigh && last.c - last.o > 0) {
      return { verdict: 'BULLISH', pattern: 'range-breakout-up', confidence: 72 }
    }
    if (last.c < rangeLow && last.c - last.o < 0) {
      return { verdict: 'BEARISH', pattern: 'range-breakout-down', confidence: 72 }
    }
  }

  // Bullish/bearish engulfing
  const a = bars[bars.length - 2]
  const b = bars[bars.length - 1]
  if (a && b) {
    const aBody = a.c - a.o
    const bBody = b.c - b.o
    if (aBody < 0 && bBody > 0 && b.c > a.o && b.o < a.c) {
      return { verdict: 'BULLISH', pattern: 'bullish-engulfing', confidence: 64 }
    }
    if (aBody > 0 && bBody < 0 && b.c < a.o && b.o > a.c) {
      return { verdict: 'BEARISH', pattern: 'bearish-engulfing', confidence: 64 }
    }
  }

  // Default - direction of last 3 closes vs the swing midpoint.
  const swingHigh = Math.max(...highs)
  const swingLow = Math.min(...lows)
  const mid = (swingHigh + swingLow) / 2
  const last = bars[bars.length - 1]
  if (last.c > mid * 1.0008) return { verdict: 'BULLISH', pattern: 'upper-half', confidence: 50 }
  if (last.c < mid * 0.9992) return { verdict: 'BEARISH', pattern: 'lower-half', confidence: 50 }
  return { verdict: 'NEUTRAL', pattern: 'mid-range', confidence: 40 }
}

export async function runPatternSpecialist(
  ctx: SpecialistContext
): Promise<SpecialistReport> {
  const start = Date.now()
  try {
    const resolution = timeframeToResolution(ctx.timeframe)
    const candles = await fetchSpecialistCandlesForContext(ctx, resolution, 15)
    const bars = candles.bars.slice(-60)
    if (bars.length < 15) {
      return degradedReport(
        'pattern',
        start,
        `Only ${bars.length} ${ctx.timeframe} bars - need 15+`
      )
    }
    const hint = structureHint(bars)

    const tail = bars
      .slice(-30)
      .map(
        (b) =>
          `${new Date(b.t < 1e12 ? b.t * 1000 : b.t).toISOString().slice(0, 16).replace('T', ' ')} O${b.o.toFixed(5)} H${b.h.toFixed(5)} L${b.l.toFixed(5)} C${b.c.toFixed(5)}`
      )
      .join('\n')

    const userPrompt = `Symbol: ${ctx.symbolLabel} (${ctx.symbol})  Timeframe: ${ctx.timeframe} (${timeframeMinutes(ctx.timeframe)} min/bar)
Rule-based structure hint: ${hint.verdict} (${hint.confidence}%) - ${hint.pattern}
Last 30 bars (newest at bottom):
${tail}

Return ONLY the strict JSON object the system prompt specified.`

    const r = await callSpecialistModel({
      systemPrompt: SYSTEM,
      userPrompt,
      maxTokens: 512,
    })

    if (!r.ok) {
      return {
        id: 'pattern',
        verdict: hint.verdict,
        confidence: hint.confidence,
        headline: `Rule-based ${hint.verdict.toLowerCase()} - ${hint.pattern}`,
        durationMs: Date.now() - start,
        degraded: true,
        error: r.error,
        data: { pattern: hint.pattern, source: candles.source },
      }
    }

    type ParsedPattern = {
      verdict?: string
      confidence?: number
      headline?: string
      pattern?: string
      structure?: string
      candleSignals?: string[]
      blockers?: string[]
    }
    const parsed = parseJsonish<ParsedPattern>(r.text, {})

    // Override neutral verdicts when rule engine has a strong structural cue.
    let verdict = normalizeVerdict(parsed.verdict)
    let confidence = clamp(Number(parsed.confidence ?? 50), 0, 100)
    if (verdict === 'NEUTRAL' && hint.verdict !== 'NEUTRAL' && hint.confidence >= 64) {
      verdict = hint.verdict
      confidence = Math.max(confidence, hint.confidence)
    }

    return {
      id: 'pattern',
      verdict,
      confidence,
      headline: String(parsed.headline ?? `${verdict} pattern on ${ctx.timeframe}`),
      durationMs: Date.now() - start,
      blockers: Array.isArray(parsed.blockers)
        ? parsed.blockers.filter((b) => typeof b === 'string').slice(0, 3)
        : undefined,
      data: {
        pattern: parsed.pattern ?? hint.pattern,
        structure: parsed.structure ?? null,
        candleSignals: parsed.candleSignals ?? [],
        source: candles.source,
      },
    }
  } catch (err) {
    return degradedReport(
      'pattern',
      start,
      err instanceof Error ? err.message : 'unknown error'
    )
  }
}
