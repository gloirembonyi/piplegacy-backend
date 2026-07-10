/**
 * Rule-based multi-timeframe alignment for the main agent tool loop.
 * Compares bias across chart TF + lower/higher TFs so the agent does not
 * emit a 5m signal that fights 4H structure or smart-money context.
 */

import { fetchSpecialistCandles } from '@/lib/agent/specialists/candles'
import { resolutionToTimeframe } from '@/lib/agent/orchestrator/pipeline-bridge'
import { computeTechnicalSummary } from '@/lib/ai-tools/technical-indicators'
import { displaySymbolLabel } from '@/lib/symbols'

export type TfBiasSnap = {
  tf: string
  bias: 'bullish' | 'bearish' | 'neutral' | 'choppy'
  rsi: number | null
  changePct5: number | null
  bars: number
  source: string
}

export type MultiTimeframeAnalysis = {
  symbol: string
  label: string
  chartTimeframe: string
  snapshots: TfBiasSnap[]
  alignment: 'strong' | 'partial' | 'mixed' | 'conflicting'
  dominantBias: 'bullish' | 'bearish' | 'neutral'
  lowerTfBias: TfBiasSnap | null
  higherTfBias: TfBiasSnap | null
  conflictingTfs: string[]
  agreeingTfs: string[]
  recommendation: 'BUY' | 'SELL' | 'WAIT' | 'NEUTRAL'
  headline: string
  guidance: string
}

type TfDef = { id: string; resolution: string; minBars: number }

const ORDERED_TFS: TfDef[] = [
  { id: '5m', resolution: '5', minBars: 30 },
  { id: '15m', resolution: '15', minBars: 25 },
  { id: '30m', resolution: '30', minBars: 20 },
  { id: '1h', resolution: '60', minBars: 20 },
  { id: '4h', resolution: '4h', minBars: 15 },
  { id: '1d', resolution: 'D', minBars: 20 },
]

function tfListFor(chartTf: string): TfDef[] {
  const idx = ORDERED_TFS.findIndex((tf) => tf.id === chartTf)
  if (idx < 0) {
    return [
      { id: '15m', resolution: '15', minBars: 25 },
      { id: '1h', resolution: '60', minBars: 20 },
      { id: '4h', resolution: '4h', minBars: 15 },
      { id: '1d', resolution: 'D', minBars: 20 },
    ]
  }
  const start = Math.max(0, idx - 1)
  const end = Math.min(ORDERED_TFS.length, idx + 3)
  return ORDERED_TFS.slice(start, end)
}

async function snapTf(symbol: string, tf: TfDef): Promise<TfBiasSnap> {
  try {
    const candles = await fetchSpecialistCandles(symbol, tf.resolution, tf.minBars)
    if (candles.bars.length < 10) {
      return {
        tf: tf.id,
        bias: 'neutral',
        rsi: null,
        changePct5: null,
        bars: candles.bars.length,
        source: candles.source,
      }
    }
    const summary = computeTechnicalSummary(candles.bars)
    if (!summary) {
      return {
        tf: tf.id,
        bias: 'neutral',
        rsi: null,
        changePct5: null,
        bars: candles.bars.length,
        source: candles.source,
      }
    }
    return {
      tf: tf.id,
      bias: summary.trend,
      rsi: summary.rsi14 != null ? Number(summary.rsi14.toFixed(1)) : null,
      changePct5:
        summary.changePct5 != null ? Number(summary.changePct5.toFixed(2)) : null,
      bars: candles.bars.length,
      source: candles.source,
    }
  } catch {
    return {
      tf: tf.id,
      bias: 'neutral',
      rsi: null,
      changePct5: null,
      bars: 0,
      source: 'none',
    }
  }
}

function biasScore(bias: TfBiasSnap['bias']): number {
  if (bias === 'bullish') return 1
  if (bias === 'bearish') return -1
  return 0
}

function deriveAlignment(snaps: TfBiasSnap[]): MultiTimeframeAnalysis['alignment'] {
  const scored = snaps.filter((s) => s.bars >= 10)
  if (scored.length < 2) return 'mixed'
  const bulls = scored.filter((s) => s.bias === 'bullish').length
  const bears = scored.filter((s) => s.bias === 'bearish').length
  const total = scored.length
  if (bulls === total || bears === total) return 'strong'
  if (bulls >= total - 1 || bears >= total - 1) return 'partial'
  if (bulls > 0 && bears > 0) return 'conflicting'
  return 'mixed'
}

function dominantFromSnaps(snaps: TfBiasSnap[]): MultiTimeframeAnalysis['dominantBias'] {
  let score = 0
  for (const s of snaps) {
    if (s.bars < 10) continue
    score += biasScore(s.bias)
  }
  if (score >= 2) return 'bullish'
  if (score <= -2) return 'bearish'
  return 'neutral'
}

function recommendationFromAnalysis(
  alignment: MultiTimeframeAnalysis['alignment'],
  chartSnap: TfBiasSnap | undefined,
  higherSnap: TfBiasSnap | null,
  lowerSnap: TfBiasSnap | null
): MultiTimeframeAnalysis['recommendation'] {
  if (alignment === 'conflicting') return 'WAIT'

  const chartBias = chartSnap?.bias ?? 'neutral'
  const htBias = higherSnap?.bias ?? 'neutral'

  // LTF bearish into HTF resistance / bullish zone → wait for alignment
  if (
    lowerSnap &&
    higherSnap &&
    lowerSnap.bias === 'bearish' &&
    (htBias === 'bullish' || htBias === 'neutral') &&
    chartBias === 'bearish'
  ) {
    return 'WAIT'
  }
  if (
    lowerSnap &&
    higherSnap &&
    lowerSnap.bias === 'bullish' &&
    htBias === 'bearish' &&
    chartBias === 'bullish'
  ) {
    return 'WAIT'
  }

  if (alignment === 'strong') {
    if (chartBias === 'bullish') return 'BUY'
    if (chartBias === 'bearish') return 'SELL'
  }

  if (alignment === 'partial') {
    if (chartBias === 'bullish' && htBias !== 'bearish') return 'BUY'
    if (chartBias === 'bearish' && htBias !== 'bullish') return 'SELL'
  }

  return 'NEUTRAL'
}

export async function analyzeMultiTimeframe(opts: {
  symbol: string
  resolution?: string
}): Promise<MultiTimeframeAnalysis> {
  const symbol = opts.symbol.trim()
  const chartTimeframe = resolutionToTimeframe(opts.resolution)
  const tfList = tfListFor(chartTimeframe)
  const snapshots = await Promise.all(tfList.map((tf) => snapTf(symbol, tf)))

  const chartIdx = snapshots.findIndex((s) => s.tf === chartTimeframe)
  const chartSnap = chartIdx >= 0 ? snapshots[chartIdx] : snapshots[0]
  const lowerTfBias = chartIdx > 0 ? snapshots[chartIdx - 1] ?? null : null
  const higherTfBias =
    chartIdx >= 0 && chartIdx < snapshots.length - 1
      ? snapshots[chartIdx + 1] ?? null
      : snapshots[snapshots.length - 1] ?? null

  const alignment = deriveAlignment(snapshots)
  const dominantBias = dominantFromSnaps(snapshots)
  const conflictingTfs = snapshots
    .filter((s) => s.bars >= 10 && chartSnap && s.bias !== chartSnap.bias && s.bias !== 'neutral' && chartSnap.bias !== 'neutral')
    .map((s) => s.tf)
  const agreeingTfs = snapshots
    .filter((s) => s.bars >= 10 && chartSnap && s.bias === chartSnap.bias && s.bias !== 'neutral')
    .map((s) => s.tf)

  const recommendation = recommendationFromAnalysis(
    alignment,
    chartSnap,
    higherTfBias,
    lowerTfBias
  )

  const headline =
    alignment === 'conflicting'
      ? `${displaySymbolLabel(symbol)}: timeframes conflict — prefer WAIT until alignment`
      : `${displaySymbolLabel(symbol)}: ${alignment} ${dominantBias} alignment on ${chartTimeframe}`

  let guidance =
    'Use chart timeframe as primary; cite higher TF for trend context and lower TF for entry timing only when aligned.'
  if (alignment === 'conflicting') {
    guidance =
      'Lower and higher timeframes disagree. Do NOT trade the fast TF alone — wait for structure confirmation or trade in HTF direction after sweep/rejection.'
  } else if (recommendation === 'WAIT') {
    guidance =
      'Immediate TF momentum fights higher-TF structure or smart-money zone — bias WAIT with trigger conditions, not a directional market entry.'
  }

  return {
    symbol,
    label: displaySymbolLabel(symbol),
    chartTimeframe,
    snapshots,
    alignment,
    dominantBias,
    lowerTfBias,
    higherTfBias,
    conflictingTfs: [...new Set(conflictingTfs)],
    agreeingTfs: [...new Set(agreeingTfs)],
    recommendation,
    headline,
    guidance,
  }
}
