/**
 * Price-action situation strings for pipeline specialists -
 * describe what price IS DOING, not just bullish/bearish labels.
 */

import type { SpecialistReport } from '@/lib/agent/pipeline-types'
import type { SpecialistContext } from '@/lib/agent/specialists/helpers'

export function attachSituation(
  report: SpecialistReport,
  situation: string
): SpecialistReport {
  const sit = situation.trim().slice(0, 240)
  if (!sit) return report
  return {
    ...report,
    situation: sit,
    headline: sit.length >= 24 ? sit.slice(0, 140) : report.headline,
    data: { ...(report.data ?? {}), situation: sit },
  }
}

export function buildRegimeSituation(
  state: string,
  opts: {
    rangePct?: number
    distFromSmaInAtr?: number
    bbwPctile?: number
    timeframe: string
  }
): string {
  const tf = opts.timeframe
  switch (state) {
    case 'compression':
      return `${tf}: Volatility compressing (BB width ~${opts.bbwPctile ?? '?'}th pctile) - price coiling, breakout pending`
    case 'trending_up':
      return `${tf}: Uptrend - price holding above moving averages, directional push higher`
    case 'trending_down':
      return `${tf}: Downtrend - price below moving averages, selling pressure dominant`
    case 'extension_up':
      return `${tf}: Extended UP ~${opts.distFromSmaInAtr?.toFixed(1) ?? '?'} ATR from mean - late chase risk, wait for pullback`
    case 'extension_down':
      return `${tf}: Extended DOWN ~${Math.abs(opts.distFromSmaInAtr ?? 0).toFixed(1)} ATR from mean - bounce possible but trend still heavy`
    case 'reversal_up':
      return `${tf}: Down move stalling - last bars showing buyer response after selloff`
    case 'reversal_down':
      return `${tf}: Up move stalling - last bars showing seller response after rally`
    case 'sideways':
      return `${tf}: Range-bound chop (~${opts.rangePct?.toFixed(1) ?? '?'}% range) - no clear trend edge`
    default:
      return `${tf}: Regime ${state.replace(/_/g, ' ')}`
  }
}

export function buildTechnicalSituation(
  ctx: SpecialistContext,
  summary: {
    trend?: string
    rsi14?: number | null
    changePct5?: number | null
    changePct20?: number | null
    last?: { c: number }
    swingHigh20?: number | null
    swingLow20?: number | null
    atr14?: number | null
  }
): string {
  const tf = ctx.timeframe
  const chg5 = summary.changePct5 ?? 0
  const dir =
    chg5 > 0.15 ? 'pushing higher' : chg5 < -0.15 ? 'sliding lower' : 'flat/choppy'
  const rsi = summary.rsi14 != null ? `RSI ${summary.rsi14.toFixed(0)}` : 'RSI n/a'
  const struct =
    summary.trend === 'bullish'
      ? 'above key averages'
      : summary.trend === 'bearish'
        ? 'below key averages'
        : 'mixed structure'
  const swings =
    summary.swingLow20 != null && summary.swingHigh20 != null
      ? `range ${summary.swingLow20.toFixed(2)}–${summary.swingHigh20.toFixed(2)}`
      : ''
  return `${tf}: Price ${dir} (${chg5 >= 0 ? '+' : ''}${chg5.toFixed(2)}% / 5 bars), ${struct}, ${rsi}${swings ? ` · ${swings}` : ''}`
}

export function buildMomentumSituation(
  ctx: SpecialistContext,
  rule: { why?: string; verdict?: string },
  ind: { recentDirection?: number; brokeOutUp?: boolean; brokeOutDown?: boolean }
): string {
  const tf = ctx.timeframe
  if (ind.brokeOutUp) return `${tf}: Breakout UP - momentum expanding above recent range`
  if (ind.brokeOutDown) return `${tf}: Breakout DOWN - momentum expanding below recent range`
  const dir =
    (ind.recentDirection ?? 0) > 0
      ? 'short-term bars net bullish'
      : (ind.recentDirection ?? 0) < 0
        ? 'short-term bars net bearish'
        : 'mixed bar direction'
  return `${tf}: ${dir}${rule.why ? ` - ${rule.why}` : ''}`
}
