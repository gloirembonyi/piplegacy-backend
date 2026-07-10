/**
 * Regime specialist - answers the question every trader needs to ask BEFORE
 * picking a direction: "what is the market doing right now?"
 *
 * States detected:
 *   - **compression**   - Bollinger Band width at a 20-bar low, low ATR. A move
 *                         is brewing; wait for the breakout candle.
 *   - **trending_up**   - Strong directional move, expanding bands, price
 *                         pulling away from SMA.
 *   - **trending_down** - Same, downside.
 *   - **sideways**      - Mid-range chop, no edge. Stay out or scalp the edges.
 *   - **extension**     - Price >2.5 ATR from SMA20 - late to chase, wait for
 *                         a pullback. This is the "move ended" warning the
 *                         user explicitly asked for.
 *   - **reversal**      - Recent strong move that just stalled (last 3 bars
 *                         opposite color of the prior 5).
 *
 * The agent reports verdict + a `state` data field so the orchestrator can
 * downgrade BUY signals to "wait" when the market is already extended.
 */

import { fetchSpecialistCandlesForContext } from '@/lib/agent/specialists/candles'
import {
  clamp,
  callSpecialistModel,
  degradedReport,
  normalizeVerdict,
  parseJsonish,
  timeframeToResolution,
  type SpecialistContext,
} from '@/lib/agent/specialists/helpers'
import {
  attachSituation,
  buildRegimeSituation,
} from '@/lib/agent/specialists/situation'
import type { SpecialistReport } from '@/lib/agent/pipeline-types'
import type { CandleBar } from '@/lib/candle-providers'

export type RegimeState =
  | 'compression'
  | 'trending_up'
  | 'trending_down'
  | 'sideways'
  | 'extension_up'
  | 'extension_down'
  | 'reversal_up'
  | 'reversal_down'

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null
  let sum = 0
  for (let i = values.length - n; i < values.length; i++) sum += values[i]
  return sum / n
}

function stdev(values: number[], n: number, mean: number): number {
  let s = 0
  for (let i = values.length - n; i < values.length; i++) {
    s += (values[i] - mean) ** 2
  }
  return Math.sqrt(s / n)
}

function atr(bars: CandleBar[], n: number): number | null {
  if (bars.length <= n) return null
  const trs: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i].h - bars[i].l
    const b = Math.abs(bars[i].h - bars[i - 1].c)
    const c = Math.abs(bars[i].l - bars[i - 1].c)
    trs.push(Math.max(a, b, c))
  }
  const slice = trs.slice(-n)
  return slice.reduce((a, c) => a + c, 0) / slice.length
}

/** Bollinger Band Width history (last N values), highest=widest, lowest=tightest. */
function bbwSeries(closes: number[], n = 20, mult = 2): number[] {
  const out: number[] = []
  for (let i = n; i <= closes.length; i++) {
    const slice = closes.slice(i - n, i)
    const m = slice.reduce((a, c) => a + c, 0) / n
    let v = 0
    for (let j = 0; j < n; j++) v += (slice[j] - m) ** 2
    const sd = Math.sqrt(v / n)
    const upper = m + mult * sd
    const lower = m - mult * sd
    out.push(((upper - lower) / m) * 100) // percentage
  }
  return out
}

type Analysis = {
  state: RegimeState
  confidence: number
  headline: string
  /** Whether the orchestrator should be careful about entering now. */
  cautionEntry: boolean
  bbwNow: number | null
  bbwMin: number | null
  bbwMax: number | null
  bbwPctile: number | null
  atrNow: number | null
  distFromSmaInAtr: number | null
  rangePct: number | null
}

function analyseRegime(bars: CandleBar[]): Analysis {
  const closes = bars.map((b) => b.c)
  const last = bars[bars.length - 1]
  const sma20 = sma(closes, 20)
  const sma50 = sma(closes, 50)
  const atr14 = atr(bars, 14)
  const bbw = bbwSeries(closes, 20)
  const bbwNow = bbw.length ? bbw[bbw.length - 1] : null
  const bbwHist = bbw.slice(-50)
  const bbwMin = bbwHist.length ? Math.min(...bbwHist) : null
  const bbwMax = bbwHist.length ? Math.max(...bbwHist) : null

  // Percentile of current BBW within last 50 bars (0 = tightest, 100 = widest).
  let bbwPctile: number | null = null
  if (bbwNow != null && bbwHist.length >= 10) {
    const sorted = [...bbwHist].sort((a, b) => a - b)
    const idx = sorted.findIndex((v) => v >= bbwNow)
    bbwPctile = idx < 0 ? 100 : Math.round((idx / sorted.length) * 100)
  }

  // How far is price from SMA20, expressed in ATR units?
  let distFromSmaInAtr: number | null = null
  if (sma20 != null && atr14 != null && atr14 > 0) {
    distFromSmaInAtr = (last.c - sma20) / atr14
  }

  // Recent range as percentage move (last 20 bars).
  const last20 = bars.slice(-20)
  let rangePct: number | null = null
  if (last20.length >= 10) {
    const hi = Math.max(...last20.map((b) => b.h))
    const lo = Math.min(...last20.map((b) => b.l))
    const mid = (hi + lo) / 2
    rangePct = mid > 0 ? ((hi - lo) / mid) * 100 : null
  }

  // ── Classify ─────────────────────────────────────────────────────────
  // Compression: BBW in bottom 25% of recent history → coiling.
  if (bbwPctile != null && bbwPctile <= 25 && distFromSmaInAtr != null) {
    if (Math.abs(distFromSmaInAtr) < 0.6) {
      return {
        state: 'compression',
        confidence: 70 + Math.max(0, 25 - bbwPctile),
        headline: `Compression - BBW at ${bbwPctile}th pctile, breakout brewing`,
        cautionEntry: true,
        bbwNow,
        bbwMin,
        bbwMax,
        bbwPctile,
        atrNow: atr14,
        distFromSmaInAtr,
        rangePct,
      }
    }
  }

  // Extension: price > 2.5 ATR from SMA20 → late chase risk.
  if (distFromSmaInAtr != null && Math.abs(distFromSmaInAtr) >= 2.5) {
    const up = distFromSmaInAtr > 0
    return {
      state: up ? 'extension_up' : 'extension_down',
      confidence: 65,
      headline: `Extension ${up ? 'up' : 'down'} - ${distFromSmaInAtr.toFixed(1)}× ATR from SMA20 (wait for pullback)`,
      cautionEntry: true,
      bbwNow,
      bbwMin,
      bbwMax,
      bbwPctile,
      atrNow: atr14,
      distFromSmaInAtr,
      rangePct,
    }
  }

  // Trending: BBW expanding (>50th pctile) + price >0.5 ATR away from SMA.
  if (bbwPctile != null && bbwPctile >= 50 && distFromSmaInAtr != null) {
    if (distFromSmaInAtr >= 0.5 && sma20 != null && sma50 != null && sma20 > sma50) {
      return {
        state: 'trending_up',
        confidence: 70,
        headline: `Trending up - BBW expanding, +${distFromSmaInAtr.toFixed(1)}× ATR from SMA20`,
        cautionEntry: false,
        bbwNow,
        bbwMin,
        bbwMax,
        bbwPctile,
        atrNow: atr14,
        distFromSmaInAtr,
        rangePct,
      }
    }
    if (distFromSmaInAtr <= -0.5 && sma20 != null && sma50 != null && sma20 < sma50) {
      return {
        state: 'trending_down',
        confidence: 70,
        headline: `Trending down - BBW expanding, ${distFromSmaInAtr.toFixed(1)}× ATR from SMA20`,
        cautionEntry: false,
        bbwNow,
        bbwMin,
        bbwMax,
        bbwPctile,
        atrNow: atr14,
        distFromSmaInAtr,
        rangePct,
      }
    }
  }

  // Reversal: last 3 bars opposite color of prior 5.
  if (bars.length >= 8) {
    const prior5 = bars.slice(-8, -3)
    const last3 = bars.slice(-3)
    const priorBull = prior5.filter((b) => b.c > b.o).length
    const priorBear = prior5.length - priorBull
    const last3Bull = last3.filter((b) => b.c > b.o).length
    if (priorBull >= 4 && last3Bull === 0) {
      return {
        state: 'reversal_down',
        confidence: 60,
        headline: 'Reversal down - 3 red bars after sustained green run',
        cautionEntry: true,
        bbwNow,
        bbwMin,
        bbwMax,
        bbwPctile,
        atrNow: atr14,
        distFromSmaInAtr,
        rangePct,
      }
    }
    if (priorBear >= 4 && last3Bull === 3) {
      return {
        state: 'reversal_up',
        confidence: 60,
        headline: 'Reversal up - 3 green bars after sustained red run',
        cautionEntry: false,
        bbwNow,
        bbwMin,
        bbwMax,
        bbwPctile,
        atrNow: atr14,
        distFromSmaInAtr,
        rangePct,
      }
    }
  }

  // Default - sideways.
  return {
    state: 'sideways',
    confidence: 50,
    headline: 'Sideways - no clear regime, scalp the edges or stay out',
    cautionEntry: true,
    bbwNow,
    bbwMin,
    bbwMax,
    bbwPctile,
    atrNow: atr14,
    distFromSmaInAtr,
    rangePct,
  }
}

const REGIME_SYSTEM = `You are a market regime analyst. Given computed regime metrics, return ONE strict JSON object:
{"verdict":"BULLISH|BEARISH|NEUTRAL|AVOID","confidence":0..100,"headline":"<=120 chars - what the market IS doing now","situation":"<=180 chars plain-language summary for traders","blockers":["short reason if entry should wait"]}

Use the rule-based state as ground truth but explain it clearly (compression, extension, trend, sideways).`

export async function runRegimeSpecialist(
  ctx: SpecialistContext
): Promise<SpecialistReport> {
  const start = Date.now()
  try {
    const resolution = timeframeToResolution(ctx.timeframe)
    const candles = await fetchSpecialistCandlesForContext(ctx, resolution, 30)
    if (candles.bars.length < 30) {
      return degradedReport(
        'regime',
        start,
        `Only ${candles.bars.length} ${ctx.timeframe} bars - regime needs 30+`
      )
    }
    const bars = candles.bars.slice(-120)
    const a = analyseRegime(bars)

    const userPrompt = `Symbol: ${ctx.symbolLabel} (${ctx.symbol})  TF: ${ctx.timeframe}
Rule state: ${a.state}
BBW percentile: ${a.bbwPctile ?? 'n/a'}  ATR dist from SMA: ${a.distFromSmaInAtr?.toFixed(2) ?? 'n/a'}
Range% (20 bars): ${a.rangePct?.toFixed(2) ?? 'n/a'}
Caution entry: ${a.cautionEntry}
Rule headline: ${a.headline}

Return ONLY the JSON object.`

    const r = await callSpecialistModel({
      systemPrompt: REGIME_SYSTEM,
      userPrompt,
      maxTokens: 400,
    })

    // Map regime → verdict (rule fallback)
    let verdict: SpecialistReport['verdict'] = 'NEUTRAL'
    if (a.state === 'trending_up' || a.state === 'reversal_up') verdict = 'BULLISH'
    else if (a.state === 'trending_down' || a.state === 'reversal_down') verdict = 'BEARISH'

    const blockers: string[] = []
    if (a.cautionEntry) {
      if (a.state.startsWith('extension')) {
        blockers.push('Regime: extended - wait for pullback or skip')
      } else if (a.state === 'compression') {
        blockers.push('Regime: compression - wait for breakout candle')
      } else if (a.state === 'sideways') {
        blockers.push('Regime: sideways - no trend edge')
      }
    }

    if (r.ok) {
      type Parsed = {
        verdict?: string
        confidence?: number
        headline?: string
        situation?: string
        blockers?: string[]
      }
      const parsed = parseJsonish<Parsed>(r.text, {})
      const modelVerdict = normalizeVerdict(parsed.verdict)
      if (modelVerdict !== 'NEUTRAL' || verdict === 'NEUTRAL') {
        verdict = modelVerdict
      }
      const confidence = clamp(Number(parsed.confidence ?? a.confidence), 0, 100)
      const headline = String(parsed.headline ?? a.headline)
      const situation =
        String(parsed.situation ?? '').trim() ||
        buildRegimeSituation(a.state, {
          rangePct: a.rangePct ?? undefined,
          distFromSmaInAtr: a.distFromSmaInAtr ?? undefined,
          bbwPctile: a.bbwPctile ?? undefined,
          timeframe: ctx.timeframe,
        })
      const modelBlockers = Array.isArray(parsed.blockers)
        ? parsed.blockers.filter((b) => typeof b === 'string').slice(0, 3)
        : blockers

      return attachSituation(
        {
          id: 'regime',
          verdict,
          confidence,
          headline,
          durationMs: Date.now() - start,
          blockers: modelBlockers.length > 0 ? modelBlockers : blockers.length > 0 ? blockers : undefined,
          data: {
            state: a.state,
            bbwNow: a.bbwNow,
            bbwPctile: a.bbwPctile,
            atrNow: a.atrNow,
            distFromSmaInAtr: a.distFromSmaInAtr,
            rangePct: a.rangePct,
            cautionEntry: a.cautionEntry,
            source: candles.source,
          },
        },
        situation
      )
    }

    // Gemini offline - keep rule metrics but still use rule headline
    return attachSituation(
      {
        id: 'regime',
        verdict,
        confidence: clamp(a.confidence, 0, 100),
        headline: a.headline,
        durationMs: Date.now() - start,
        degraded: true,
        error: r.error,
        blockers: blockers.length > 0 ? blockers : undefined,
        data: {
          state: a.state,
          bbwNow: a.bbwNow,
          bbwPctile: a.bbwPctile,
          atrNow: a.atrNow,
          distFromSmaInAtr: a.distFromSmaInAtr,
          rangePct: a.rangePct,
          cautionEntry: a.cautionEntry,
          source: candles.source,
        },
      },
      buildRegimeSituation(a.state, {
        rangePct: a.rangePct ?? undefined,
        distFromSmaInAtr: a.distFromSmaInAtr ?? undefined,
        bbwPctile: a.bbwPctile ?? undefined,
        timeframe: ctx.timeframe,
      })
    )
  } catch (err) {
    return degradedReport(
      'regime',
      start,
      err instanceof Error ? err.message : 'unknown error'
    )
  }
}
