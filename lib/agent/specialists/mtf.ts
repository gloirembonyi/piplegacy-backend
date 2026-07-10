/**
 * Multi-timeframe specialist - pulls real OHLC for 5m / 15m / 1h / daily,
 * computes a per-TF rule-based bias, then asks the model to call the overall
 * alignment.
 *
 * Lower TFs (1m) are skipped from the rules engine because most free-tier
 * providers don't expose them; we fall back to 5m as the fastest signal.
 * The summariser still says whether the TFs agree, conflict, or are mixed.
 */

import { fetchSpecialistCandlesForContext } from '@/lib/agent/specialists/candles'
import { computeTechnicalSummary } from '@/lib/ai-tools/technical-indicators'
import {
  callSpecialistModel,
  clamp,
  degradedReport,
  normalizeVerdict,
  parseJsonish,
  timeframeToResolution,
  type SpecialistContext,
} from '@/lib/agent/specialists/helpers'
import type { SpecialistReport } from '@/lib/agent/pipeline-types'

type TfSnap = {
  tf: string
  bars: number
  bias: 'bullish' | 'bearish' | 'neutral' | 'choppy'
  rsi: number | null
  changePct: number | null
  source: string
}

type TfDef = { id: string; resolution: string; minBars: number }

const DEFAULT_TF_LIST: TfDef[] = [
  { id: '15m', resolution: '15', minBars: 20 },
  { id: '1h', resolution: '60', minBars: 20 },
  { id: '4h', resolution: '4h', minBars: 15 },
  { id: '1d', resolution: 'D', minBars: 20 },
]

/**
 * Build a timeframe list anchored around the user's working TF - always
 * includes 2 lower TFs (for momentum confirmation) and 1-2 higher TFs (for
 * trend context). This makes the MTF specialist relevant on 5m as well as 1h.
 */
function tfListFor(userTf: string): TfDef[] {
  const ordered: TfDef[] = [
    { id: '5m', resolution: '5', minBars: 30 },
    { id: '15m', resolution: '15', minBars: 25 },
    { id: '30m', resolution: '30', minBars: 20 },
    { id: '1h', resolution: '60', minBars: 20 },
    { id: '4h', resolution: '4h', minBars: 15 },
    { id: '1d', resolution: 'D', minBars: 20 },
  ]
  const idx = ordered.findIndex((tf) => tf.id === userTf)
  if (idx < 0) return DEFAULT_TF_LIST
  const start = Math.max(0, idx - 1)
  const end = Math.min(ordered.length, idx + 3)
  return ordered.slice(start, end)
}

const SYSTEM = `You are a multi-timeframe trading desk lead. Given rule-based bias per TF, return ONE strict JSON object:
{"verdict":"BULLISH|BEARISH|NEUTRAL|AVOID","confidence":0..100,"headline":"<=120 chars","alignment":"strong|partial|mixed|conflicting","agreeingTfs":["..."] ,"conflictingTfs":["..."],"blockers":["short reason"]}`

async function snapTf(
  ctx: SpecialistContext,
  tf: { id: string; resolution: string; minBars: number }
): Promise<TfSnap> {
  try {
    const candles = await fetchSpecialistCandlesForContext(ctx, tf.resolution, tf.minBars)
    if (candles.bars.length < 10) {
      return {
        tf: tf.id,
        bars: candles.bars.length,
        bias: 'neutral',
        rsi: null,
        changePct: null,
        source: candles.source,
      }
    }
    const summary = computeTechnicalSummary(candles.bars)
    if (!summary) {
      return {
        tf: tf.id,
        bars: candles.bars.length,
        bias: 'neutral',
        rsi: null,
        changePct: null,
        source: candles.source,
      }
    }
    return {
      tf: tf.id,
      bars: candles.bars.length,
      bias: summary.trend,
      rsi: summary.rsi14,
      changePct: summary.changePct5,
      source: candles.source,
    }
  } catch {
    return { tf: tf.id, bars: 0, bias: 'neutral', rsi: null, changePct: null, source: 'none' }
  }
}

export async function runMtfSpecialist(
  ctx: SpecialistContext
): Promise<SpecialistReport> {
  const start = Date.now()
  try {
    const tfList = tfListFor(ctx.timeframe)
    const snaps = await Promise.all(tfList.map((tf) => snapTf(ctx, tf)))
    const haveBars = snaps.filter((s) => s.bars >= 10)
    if (haveBars.length === 0) {
      return degradedReport('mtf', start, 'No multi-timeframe candle data')
    }

    const userPrompt = `Symbol: ${ctx.symbolLabel} (${ctx.symbol})  Working TF: ${ctx.timeframe}
Per-timeframe rule-based snapshots (bias from SMA20/50 + close):
${snaps
  .map(
    (s) =>
      `- ${s.tf.padEnd(4)}: bias=${s.bias} bars=${s.bars} rsi=${s.rsi != null ? s.rsi.toFixed(1) : 'n/a'} 5-bar-change=${s.changePct != null ? s.changePct.toFixed(2) + '%' : 'n/a'} src=${s.source}`
  )
  .join('\n')}

Return ONLY the strict JSON object the system prompt specified.`

    const r = await callSpecialistModel({
      systemPrompt: SYSTEM,
      userPrompt,
      maxTokens: 512,
    })

    // Rule-based vote up front so we can override a confused model.
    const bull = snaps.filter((s) => s.bias === 'bullish').length
    const bear = snaps.filter((s) => s.bias === 'bearish').length
    const ruleVerdict =
      bull > bear ? 'BULLISH' : bear > bull ? 'BEARISH' : 'NEUTRAL'
    const ruleConfidence = clamp(45 + Math.abs(bull - bear) * 12, 0, 85)

    if (!r.ok) {
      return {
        id: 'mtf',
        verdict: ruleVerdict,
        confidence: ruleConfidence,
        headline: `Rule-based fallback: ${bull} bullish / ${bear} bearish TFs`,
        durationMs: Date.now() - start,
        degraded: true,
        error: r.error,
        data: { snaps, bull, bear },
      }
    }

    type ParsedMtf = {
      verdict?: string
      confidence?: number
      headline?: string
      alignment?: string
      agreeingTfs?: string[]
      conflictingTfs?: string[]
      blockers?: string[]
    }
    const parsed = parseJsonish<ParsedMtf>(r.text, {})
    let verdict = normalizeVerdict(parsed.verdict)
    let confidence = clamp(Number(parsed.confidence ?? 50), 0, 100)
    // Model says NEUTRAL but ≥2 TFs lean the same way → take the lean.
    if (verdict === 'NEUTRAL' && ruleVerdict !== 'NEUTRAL' && Math.abs(bull - bear) >= 2) {
      verdict = ruleVerdict
      confidence = Math.max(confidence, ruleConfidence)
    }

    return {
      id: 'mtf',
      verdict,
      confidence,
      headline: String(parsed.headline ?? `${bull}↑ ${bear}↓ TF alignment`),
      durationMs: Date.now() - start,
      blockers: Array.isArray(parsed.blockers)
        ? parsed.blockers.filter((b) => typeof b === 'string').slice(0, 3)
        : undefined,
      data: {
        snaps,
        alignment: parsed.alignment ?? null,
        agreeingTfs: parsed.agreeingTfs ?? [],
        conflictingTfs: parsed.conflictingTfs ?? [],
        bull,
        bear,
      },
    }
  } catch (err) {
    return degradedReport(
      'mtf',
      start,
      err instanceof Error ? err.message : 'unknown error'
    )
  }
}
