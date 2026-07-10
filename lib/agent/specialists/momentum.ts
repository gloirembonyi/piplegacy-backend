/**
 * Momentum / scalper specialist.
 *
 * This is the agent the previous pipeline was missing: it looks at the user's
 * actual trading timeframe (5m, 15m, 1h, ...) and screams BULLISH/BEARISH the
 * moment a clean directional move develops - fast EMAs crossing, big-body
 * candles in one direction, breakout of recent range, etc.
 *
 * Without this, a 35-pip GBP/USD move on 5m was invisible to daily-only TA.
 */

import {
  callSpecialistModel,
  clamp,
  degradedReport,
  normalizeVerdict,
  parseJsonish,
  timeframeToResolution,
  timeframeMinutes,
  type SpecialistContext,
} from '@/lib/agent/specialists/helpers'
import { fetchSpecialistCandlesForContext } from '@/lib/agent/specialists/candles'
import { attachSituation, buildMomentumSituation } from '@/lib/agent/specialists/situation'
import type { SpecialistReport } from '@/lib/agent/pipeline-types'
import type { CandleBar } from '@/lib/candle-providers'

const SYSTEM = `You are an aggressive scalp/momentum trader. You are paid to TAKE TRADES when short-term momentum is clear - not to wait for daily confirmations. Look at the live tape on the user's timeframe and decide.

Return ONE strict JSON object:
{"verdict":"BULLISH|BEARISH|NEUTRAL|AVOID","confidence":0..100,"headline":"<=120 chars","strength":"explosive|strong|moderate|weak","direction":"up|down|sideways","breakout":true|false,"blockers":["short reason"]}

Decision rules:
- If the last 5 bars are >70% same-color in one direction AND the close is above EMA9/EMA21 stack → BULLISH (or below stack → BEARISH).
- If price just broke above the recent 20-bar high (or below the 20-bar low) on a strong body → BULLISH/BEARISH with breakout:true, confidence 70+.
- If EMA9 just crossed above EMA21 with positive close → BULLISH, confidence 55-70.
- NEUTRAL ONLY when bars are mixed colors AND price is pinned to EMA21 (sideways range).
- Confidence 50+ means you'd actually take the trade.`

type Indicators = {
  ema9: number | null
  ema21: number | null
  ema50: number | null
  rsi7: number | null
  closes: number[]
  highs: number[]
  lows: number[]
  bodyRatios: number[]
  recentDirection: number // +1 up, -1 down, 0 mixed
  recentBodyPct: number | null
  range20High: number | null
  range20Low: number | null
  brokeOutUp: boolean
  brokeOutDown: boolean
}

function ema(values: number[], n: number): number | null {
  if (values.length < n) return null
  const k = 2 / (n + 1)
  let prev = values.slice(0, n).reduce((a, c) => a + c, 0) / n
  for (let i = n; i < values.length; i++) prev = values[i] * k + prev * (1 - k)
  return prev
}

function rsi(closes: number[], period: number): number | null {
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
  return 100 - 100 / (1 + avgGain / avgLoss)
}

function computeMomentum(bars: CandleBar[]): Indicators {
  const closes = bars.map((b) => b.c)
  const highs = bars.map((b) => b.h)
  const lows = bars.map((b) => b.l)
  const bodyRatios = bars.map((b) => {
    const range = b.h - b.l || Number.EPSILON
    return (b.c - b.o) / range
  })

  // Net direction of last 5 bars: weighted sum of body ratios.
  const last5 = bodyRatios.slice(-5)
  const dir = last5.reduce((sum, br) => sum + Math.sign(br), 0)
  const recentDirection = dir >= 3 ? 1 : dir <= -3 ? -1 : 0

  // Average body size as % of price (proxy for "is something happening?").
  const recentBodies = bars
    .slice(-5)
    .map((b) => Math.abs(b.c - b.o) / (b.c || 1))
  const recentBodyPct =
    recentBodies.length > 0
      ? (recentBodies.reduce((a, c) => a + c, 0) / recentBodies.length) * 100
      : null

  const range20 = bars.slice(-21, -1) // exclude current bar
  const range20High = range20.length ? Math.max(...range20.map((b) => b.h)) : null
  const range20Low = range20.length ? Math.min(...range20.map((b) => b.l)) : null
  const last = bars[bars.length - 1]
  const brokeOutUp =
    range20High != null && last.c > range20High && (last.c - last.o) > 0
  const brokeOutDown =
    range20Low != null && last.c < range20Low && (last.c - last.o) < 0

  return {
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    ema50: ema(closes, 50),
    rsi7: rsi(closes, 7),
    closes,
    highs,
    lows,
    bodyRatios,
    recentDirection,
    recentBodyPct,
    range20High,
    range20Low,
    brokeOutUp,
    brokeOutDown,
  }
}

/** Rule-based verdict so we can answer even when the model is offline. */
function ruleVerdict(ind: Indicators, lastClose: number) {
  const { ema9, ema21, ema50, rsi7, recentDirection, brokeOutUp, brokeOutDown } = ind

  // Breakouts dominate - high confidence.
  if (brokeOutUp) return { verdict: 'BULLISH' as const, confidence: 78, why: 'Broke 20-bar high' }
  if (brokeOutDown) return { verdict: 'BEARISH' as const, confidence: 78, why: 'Broke 20-bar low' }

  // Stacked EMAs with last close on the right side.
  if (ema9 != null && ema21 != null && ema9 > ema21 && lastClose > ema9) {
    const strong = ema50 != null && ema21 > ema50 && rsi7 != null && rsi7 > 55
    return {
      verdict: 'BULLISH' as const,
      confidence: strong ? 72 : 62,
      why: strong ? 'EMA9>EMA21>EMA50 + RSI7>55' : 'EMA9>EMA21 + close above',
    }
  }
  if (ema9 != null && ema21 != null && ema9 < ema21 && lastClose < ema9) {
    const strong = ema50 != null && ema21 < ema50 && rsi7 != null && rsi7 < 45
    return {
      verdict: 'BEARISH' as const,
      confidence: strong ? 72 : 62,
      why: strong ? 'EMA9<EMA21<EMA50 + RSI7<45' : 'EMA9<EMA21 + close below',
    }
  }

  // Last 5 bars decisively one direction.
  if (recentDirection === 1) {
    return { verdict: 'BULLISH' as const, confidence: 58, why: 'Last 5 bars mostly green' }
  }
  if (recentDirection === -1) {
    return { verdict: 'BEARISH' as const, confidence: 58, why: 'Last 5 bars mostly red' }
  }

  return { verdict: 'NEUTRAL' as const, confidence: 30, why: 'Sideways / mixed bars' }
}

export async function runMomentumSpecialist(
  ctx: SpecialistContext
): Promise<SpecialistReport> {
  const start = Date.now()
  try {
    const resolution = timeframeToResolution(ctx.timeframe)
    const candles = await fetchSpecialistCandlesForContext(ctx, resolution, 25)
    if (candles.bars.length < 25) {
      return degradedReport(
        'momentum',
        start,
        `Only ${candles.bars.length} ${ctx.timeframe} bars available - need 25+`
      )
    }
    const bars = candles.bars.slice(-80)
    const ind = computeMomentum(bars)
    const last = bars[bars.length - 1]
    const rule = ruleVerdict(ind, last.c)

    const compactTail = bars
      .slice(-15)
      .map(
        (b) =>
          `${b.o.toFixed(4)} ${b.h.toFixed(4)} ${b.l.toFixed(4)} ${b.c.toFixed(4)}`
      )
      .join('\n')

    const userPrompt = `Symbol: ${ctx.symbolLabel} (${ctx.symbol})  Timeframe: ${ctx.timeframe} (${timeframeMinutes(ctx.timeframe)} min/bar)
Last close: ${last.c}  EMA9: ${ind.ema9?.toFixed(5) ?? 'n/a'}  EMA21: ${ind.ema21?.toFixed(5) ?? 'n/a'}  EMA50: ${ind.ema50?.toFixed(5) ?? 'n/a'}
RSI7: ${ind.rsi7?.toFixed(1) ?? 'n/a'}
Recent 5-bar net direction: ${ind.recentDirection > 0 ? 'UP' : ind.recentDirection < 0 ? 'DOWN' : 'mixed'} (avg body ${ind.recentBodyPct?.toFixed(3) ?? 'n/a'}%)
20-bar range high: ${ind.range20High?.toFixed(5) ?? 'n/a'}  low: ${ind.range20Low?.toFixed(5) ?? 'n/a'}
Breakout up? ${ind.brokeOutUp}  Breakout down? ${ind.brokeOutDown}
Rule-based hint: ${rule.verdict} (${rule.confidence}%) - ${rule.why}

Last 15 bars (O H L C):
${compactTail}

Return ONLY the JSON object specified by the system prompt.`

    const r = await callSpecialistModel({
      systemPrompt: SYSTEM,
      userPrompt,
      maxTokens: 512,
      temperature: 0.15,
    })

    if (!r.ok) {
      return attachSituation(
        {
          id: 'momentum',
          verdict: rule.verdict,
          confidence: rule.confidence,
          headline: `Rule-based ${rule.verdict.toLowerCase()} - ${rule.why}`,
          durationMs: Date.now() - start,
          degraded: true,
          error: r.error,
          data: { ind, rule, lastClose: last.c, source: candles.source },
        },
        buildMomentumSituation(ctx, rule, ind)
      )
    }

    type ParsedMomentum = {
      verdict?: string
      confidence?: number
      headline?: string
      strength?: string
      direction?: string
      breakout?: boolean
      blockers?: string[]
    }
    const parsed = parseJsonish<ParsedMomentum>(r.text, {})

    // If model is "neutral" but rule engine sees a clean signal with ≥58 conf,
    // override toward the rule (this is the whole point of the agent).
    let verdict = normalizeVerdict(parsed.verdict)
    let confidence = clamp(Number(parsed.confidence ?? 50), 0, 100)
    if (
      verdict === 'NEUTRAL' &&
      rule.verdict !== 'NEUTRAL' &&
      rule.confidence >= 58
    ) {
      verdict = rule.verdict
      confidence = Math.max(confidence, rule.confidence)
    }

    return attachSituation(
      {
        id: 'momentum',
        verdict,
        confidence,
        headline:
          String(parsed.headline ?? '').trim() ||
          `${verdict.toLowerCase()} momentum on ${ctx.timeframe} (${parsed.strength ?? 'moderate'})`,
        durationMs: Date.now() - start,
        blockers: Array.isArray(parsed.blockers)
          ? parsed.blockers.filter((b) => typeof b === 'string').slice(0, 3)
          : undefined,
        data: {
          ind,
          rule,
          strength: parsed.strength ?? null,
          direction: parsed.direction ?? null,
          breakout: Boolean(parsed.breakout),
          lastClose: last.c,
          source: candles.source,
        },
      },
      buildMomentumSituation(ctx, rule, ind)
    )
  } catch (err) {
    return degradedReport(
      'momentum',
      start,
      err instanceof Error ? err.message : 'unknown error'
    )
  }
}
