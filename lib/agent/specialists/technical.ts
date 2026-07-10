/**
 * Technical specialist - runs SMA/RSI/ATR/swings on the user's selected
 * timeframe (5m, 15m, 1h, 4h, 1d). Previously hardcoded to daily, which made
 * it blind to intraday moves; this version follows whatever the trader picks
 * in the right rail.
 */

import { fetchSpecialistCandlesForContext } from '@/lib/agent/specialists/candles'
import { computeTechnicalSummary } from '@/lib/ai-tools/technical-indicators'
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
import { attachSituation, buildTechnicalSituation } from '@/lib/agent/specialists/situation'
import type { SpecialistReport } from '@/lib/agent/pipeline-types'

const SYSTEM = `You are a senior technical analyst. Given a fresh technical summary, return ONE strict JSON object:
{"verdict":"BULLISH|BEARISH|NEUTRAL|AVOID","confidence":0..100,"situation":"<=180 chars describing what price IS DOING (trend, range, momentum, key levels)","headline":"<=120 chars","keyLevels":{"support":[number],"resistance":[number]},"momentum":"strong|moderate|weak|exhausted","trendStrength":"strong|moderate|weak","blockers":["short reason if any"]}

The situation field MUST describe price action in plain language - e.g. "15m: sliding lower after rejection at 4050, testing 4020 support" - NOT just "bearish".`

export async function runTechnicalSpecialist(
  ctx: SpecialistContext
): Promise<SpecialistReport> {
  const start = Date.now()
  try {
    const resolution = timeframeToResolution(ctx.timeframe)
    const candles = await fetchSpecialistCandlesForContext(ctx, resolution, 25)
    if (candles.bars.length < 25) {
      // Fallback to daily so we at least give the user macro context.
      const dailyFallback = await fetchSpecialistCandlesForContext(ctx, 'D', 20)
      if (dailyFallback.bars.length < 20) {
        return degradedReport(
          'technical',
          start,
          `Only ${candles.bars.length} bars on ${ctx.timeframe}`
        )
      }
      candles.bars = dailyFallback.bars
      candles.source = dailyFallback.source
      candles.resolution = 'D'
    }
    const summary = computeTechnicalSummary(candles.bars)
    if (!summary) {
      return degradedReport('technical', start, 'Indicator computation failed')
    }

    const userPrompt = `Symbol: ${ctx.symbolLabel} (${ctx.symbol})  Timeframe: ${ctx.timeframe} (${timeframeMinutes(ctx.timeframe)} min/bar)
Bars analysed: ${summary.bars}  Source: ${candles.source}
Last close: ${summary.last.c}
SMA20: ${summary.sma20}  SMA50: ${summary.sma50}  EMA21: ${summary.ema21}
RSI14: ${summary.rsi14}  ATR14: ${summary.atr14}
5-bar return: ${summary.changePct5?.toFixed(2) ?? 'n/a'}%   20-bar return: ${summary.changePct20?.toFixed(2) ?? 'n/a'}%
Trend (rule-based): ${summary.trend}
Recent swing highs: ${summary.recentHighs.slice(-3).join(', ') || 'n/a'}
Recent swing lows: ${summary.recentLows.slice(-3).join(', ') || 'n/a'}
Swing-20 high: ${summary.swingHigh20}  Swing-20 low: ${summary.swingLow20}

Return ONLY the JSON object specified by the system prompt.`

    const r = await callSpecialistModel({
      systemPrompt: SYSTEM,
      userPrompt,
      maxTokens: 512,
    })

    // Rule-based verdict - used as fallback AND to nudge a confused model.
    const ruleBias =
      summary.trend === 'bullish'
        ? 'BULLISH'
        : summary.trend === 'bearish'
          ? 'BEARISH'
          : 'NEUTRAL'
    const ruleConfidence =
      summary.trend === 'bullish' || summary.trend === 'bearish' ? 60 : 35

    if (!r.ok) {
      return attachSituation(
        {
          id: 'technical',
          verdict: ruleBias,
          confidence: ruleConfidence,
          headline: `Rule-based fallback: ${ruleBias} (RSI ${summary.rsi14?.toFixed(0) ?? 'n/a'})`,
          durationMs: Date.now() - start,
          degraded: true,
          error: r.error,
          data: { summary, source: candles.source, resolution: candles.resolution },
        },
        buildTechnicalSituation(ctx, summary)
      )
    }

    type ParsedTech = {
      verdict?: string
      confidence?: number
      headline?: string
      situation?: string
      keyLevels?: { support?: number[]; resistance?: number[] }
      momentum?: string
      trendStrength?: string
      blockers?: string[]
    }
    const parsed = parseJsonish<ParsedTech>(r.text, {})

    // If model said NEUTRAL but rules show a clear trend AND a >0.3% move
    // in the last 5 bars, override toward the rule bias - this is what a
    // human trader would actually call.
    let verdict = normalizeVerdict(parsed.verdict)
    let confidence = clamp(Number(parsed.confidence ?? 50), 0, 100)
    const recentMove = summary.changePct5 ?? 0
    const overrideThreshold = ctx.timeframe === '1d' || ctx.timeframe === '4h' ? 0.8 : 0.25
    if (
      verdict === 'NEUTRAL' &&
      ruleBias !== 'NEUTRAL' &&
      Math.abs(recentMove) >= overrideThreshold
    ) {
      verdict = ruleBias
      confidence = Math.max(confidence, 60)
    }

    return attachSituation(
      {
        id: 'technical',
        verdict,
        confidence,
        headline: String(parsed.headline ?? `${verdict} on ${ctx.timeframe}`),
        durationMs: Date.now() - start,
        blockers: Array.isArray(parsed.blockers)
          ? parsed.blockers.filter((b) => typeof b === 'string').slice(0, 3)
          : undefined,
        data: {
          summary,
          keyLevels: parsed.keyLevels ?? null,
          momentum: parsed.momentum ?? null,
          trendStrength: parsed.trendStrength ?? null,
          source: candles.source,
          resolution: candles.resolution,
        },
      },
      String(parsed.situation ?? '').trim() || buildTechnicalSituation(ctx, summary)
    )
  } catch (err) {
    return degradedReport(
      'technical',
      start,
      err instanceof Error ? err.message : 'unknown error'
    )
  }
}
