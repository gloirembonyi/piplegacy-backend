/**
 * Trader-grade context: sessions, events, MTF, SMC (liquidity / inducement /
 * sweeps), and a GO vs WAIT decision matrix for the main agent loop.
 */

import { analyzeSmcFromBars, type SmcAnalysisResult } from '@/lib/agent/specialists/smc'
import { fetchSpecialistCandles } from '@/lib/agent/specialists/candles'
import { optimalSmcResolutions } from '@/lib/agent/orchestrator/timeframe-policy'
import { resolutionToTimeframe } from '@/lib/agent/orchestrator/pipeline-bridge'
import { analyzeMultiTimeframe } from '@/lib/ai-tools/multi-timeframe-analysis'
import { fetchEconomicCalendar } from '@/lib/economic-calendar'
import {
  formatOpensIn,
  getActiveSessionNames,
  getMarketLiquidity,
  getMarketStatusForSymbol,
  getMinutesUntilNextSession,
  isForexMarketOpen,
  isUsStockMarketOpen,
} from '@/lib/market-sessions'
import { displaySymbolLabel } from '@/lib/symbols'

export type SerializedSmc = {
  resolution: string
  verdict: string
  confidence: number
  headline: string
  blockers: string[]
  confirmed: Array<{ kind: string; level: number; detail: string }>
  speculative: Array<{ kind: string; level?: number; detail: string }>
  liquidityPools: Array<{ kind: string; level: number; detail: string }>
  inducement: Array<{ kind: string; level: number; detail: string }>
  sweeps: Array<{ kind: string; level: number; detail: string }>
  stopHuntRisk: 'high' | 'medium' | 'low'
  fakeOutRisk: 'high' | 'medium' | 'low'
}

export type TradeContextDecision = {
  action: 'GO_BUY' | 'GO_SELL' | 'WAIT' | 'NEUTRAL'
  confidence: number
  reasons: string[]
  watchFor: string[]
  blockers: string[]
}

export type LiquidityInducementAnalysis = {
  symbol: string
  label: string
  timeframeNote: string
  primary: SerializedSmc | null
  htf: SerializedSmc | null
  summary: string
}

export type TradeContextAssessment = {
  symbol: string
  label: string
  chartTimeframe: string
  serverTimeUtc: string
  session: {
    activeSessions: string[]
    liquidity: string
    killzone: string | null
    marketOpen: boolean
    symbolStatus: string | null
    nextSession: { name: string; opensIn: string; minutesUntil: number } | null
  }
  nextEvent: {
    event: string
    currency: string
    impact: string
    minutesUntil: number | null
    opensIn: string | null
  } | null
  newsBlackout: boolean
  multiTimeframe: Awaited<ReturnType<typeof analyzeMultiTimeframe>>
  smartMoney: LiquidityInducementAnalysis
  decision: TradeContextDecision
  traderNote: string
}

function serializeSmc(resolution: string, analysis: SmcAnalysisResult | null): SerializedSmc | null {
  if (!analysis) return null
  const inducement = analysis.signals
    .filter((s) => s.kind.startsWith('inducement'))
    .map((s) => ({ kind: s.kind, level: s.level, detail: s.detail }))
  const sweeps = analysis.signals
    .filter((s) => s.kind.includes('liquidity-sweep'))
    .map((s) => ({ kind: s.kind, level: s.level, detail: s.detail }))
  const poolCount = analysis.liquidityPools.length
  const hasInducement = inducement.length > 0
  const hasSweep = sweeps.length > 0
  const fakeOutRisk: SerializedSmc['fakeOutRisk'] =
    hasInducement && !hasSweep ? 'high' : hasInducement ? 'medium' : 'low'
  const stopHuntRisk: SerializedSmc['stopHuntRisk'] =
    poolCount >= 2 && !hasSweep ? 'high' : poolCount >= 1 ? 'medium' : hasSweep ? 'low' : 'medium'

  return {
    resolution,
    verdict: analysis.verdict,
    confidence: analysis.confidence,
    headline: analysis.headline,
    blockers: analysis.blockers,
    confirmed: analysis.confirmed.map((c) => ({
      kind: c.kind,
      level: c.level,
      detail: c.detail,
    })),
    speculative: analysis.speculative.map((s) => ({
      kind: s.kind,
      level: s.level,
      detail: s.detail,
    })),
    liquidityPools: analysis.liquidityPools,
    inducement,
    sweeps,
    stopHuntRisk,
    fakeOutRisk,
  }
}

/** ICT-style killzone label (UTC). */
function currentKillzone(now = new Date()): string | null {
  const h = now.getUTCHours()
  const m = now.getUTCMinutes()
  const mins = h * 60 + m
  if (mins >= 7 * 60 && mins < 10 * 60) return 'London open (07:00–10:00 UTC) — Judas swing / sweep risk'
  if (mins >= 13 * 60 + 30 && mins < 16 * 60) return 'NY open (13:30–16:00 UTC) — data + liquidity grab window'
  if (mins >= 0 && mins < 3 * 60) return 'Asia open (00:00–03:00 UTC) — thin liquidity, fake moves common'
  return null
}

function relevantCurrencies(symbol: string): string[] {
  const s = symbol.toUpperCase()
  const fxMatch = s.match(/([A-Z]{3})[_./]?([A-Z]{3})$/)
  if (fxMatch) return [fxMatch[1], fxMatch[2]]
  if (/XAU|GOLD|XAG|SILVER/.test(s)) return ['USD']
  if (/BTC|ETH|SOL|BINANCE|COINBASE/.test(s)) return ['USD']
  return ['USD']
}

async function fetchNextHighImpactEvent(symbol: string): Promise<{
  event: string
  currency: string
  impact: string
  minutesUntil: number | null
} | null> {
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  const horizon = new Date(now.getTime() + 48 * 3600 * 1000).toISOString().split('T')[0]
  const past = new Date(now.getTime() - 6 * 3600 * 1000).toISOString().split('T')[0]
  const cal = await fetchEconomicCalendar(past, horizon)
  const currencies = new Set(relevantCurrencies(symbol))
  const upcoming = cal.data
    .filter((e) => {
      const impact = (e.impact ?? '').toLowerCase()
      if (!impact.includes('high')) return false
      return currencies.has((e.currency ?? 'USD').toUpperCase())
    })
    .map((e) => {
      const iso = `${e.date}T${(e.time ?? '00:00').length === 5 ? e.time : `${e.time}:00`}:00Z`
      const ts = Date.parse(iso)
      const minutesUntil = Number.isFinite(ts)
        ? Math.round((ts - Date.now()) / 60000)
        : null
      return { ...e, minutesUntil }
    })
    .filter((e) => e.minutesUntil == null || e.minutesUntil > -30)
    .sort((a, b) => (a.minutesUntil ?? 9999) - (b.minutesUntil ?? 9999))
  const top = upcoming[0]
  if (!top) return null
  return {
    event: top.event ?? 'High-impact event',
    currency: top.currency ?? 'USD',
    impact: top.impact ?? 'high',
    minutesUntil: top.minutesUntil,
  }
}

export async function analyzeLiquidityAndInducement(opts: {
  symbol: string
  resolution?: string
}): Promise<LiquidityInducementAnalysis> {
  const symbol = opts.symbol.trim()
  const tfPlan = optimalSmcResolutions(opts.resolution)
  const [primaryCandles, htfCandles] = await Promise.all([
    fetchSpecialistCandles(symbol, tfPlan.primary, tfPlan.minBars),
    fetchSpecialistCandles(symbol, tfPlan.htf, Math.max(25, tfPlan.minBars - 5)),
  ])

  const primaryRaw = analyzeSmcFromBars(primaryCandles.bars)
  const htfRaw = analyzeSmcFromBars(htfCandles.bars)
  const primary = serializeSmc(tfPlan.primaryLabel, primaryRaw)
  const htf = serializeSmc(tfPlan.htfLabel, htfRaw)

  const parts: string[] = []
  if (primary) {
    parts.push(`${tfPlan.primaryLabel} ${primary.verdict} ${primary.confidence}%`)
    if (primary.sweeps.length) parts.push(`${primary.sweeps.length} sweep(s)`)
    if (primary.inducement.length) parts.push(`inducement @ ${primary.inducement[0]?.level.toFixed(2)}`)
    if (primary.liquidityPools.length) parts.push(`${primary.liquidityPools.length} pool(s)`)
    if (primary.fakeOutRisk === 'high') parts.push('fake-out risk HIGH')
  }
  if (htf && htf.verdict !== primary?.verdict) {
    parts.push(`HTF ${htf.verdict}`)
  }

  return {
    symbol,
    label: displaySymbolLabel(symbol),
    timeframeNote: tfPlan.note,
    primary,
    htf,
    summary: parts.length ? parts.join(' · ') : 'Insufficient bar data for SMC',
  }
}

function buildDecision(opts: {
  mtf: Awaited<ReturnType<typeof analyzeMultiTimeframe>>
  smc: LiquidityInducementAnalysis
  sessionLiquidity: string
  newsBlackout: boolean
  killzone: string | null
  nextEventMinutes: number | null
}): TradeContextDecision {
  const reasons: string[] = []
  const watchFor: string[] = []
  const blockers: string[] = []

  if (opts.newsBlackout) {
    blockers.push('High-impact news window — avoid market entries')
    watchFor.push('Wait until event passes and structure confirms direction')
  }
  if (opts.nextEventMinutes != null && opts.nextEventMinutes >= 0 && opts.nextEventMinutes < 45) {
    blockers.push(`High-impact event in ~${opts.nextEventMinutes}m`)
    watchFor.push('Post-event sweep + BOS/CHoCH before entering')
  }
  if (opts.sessionLiquidity === 'Low') {
    blockers.push('Low session liquidity — spreads widen, stop hunts more likely')
    watchFor.push('London/NY overlap or next major session open for cleaner execution')
  }
  if (opts.killzone) {
    watchFor.push(opts.killzone)
  }

  if (opts.mtf.alignment === 'conflicting') {
    blockers.push('Multi-timeframe conflict — lower TF fights higher TF structure')
    watchFor.push(
      `Wait for alignment: ${opts.mtf.conflictingTfs.join(', ') || 'conflicting TFs'} must agree`
    )
  }
  if (opts.mtf.recommendation === 'WAIT') {
    blockers.push('MTF recommends WAIT until structure aligns')
  }

  const p = opts.smc.primary
  const h = opts.smc.htf
  if (p?.fakeOutRisk === 'high') {
    blockers.push('Inducement / fake-out detected without confirmed sweep')
    watchFor.push('Liquidity sweep + close back before trusting breakout direction')
  }
  if (p?.stopHuntRisk === 'high') {
    watchFor.push('Price may hunt equal highs/lows before the real move — place stops beyond pools')
  }
  if (p?.blockers.length) {
    for (const b of p.blockers.slice(0, 2)) blockers.push(b)
  }
  if (p?.sweeps.length) {
    reasons.push(`Confirmed sweep: ${p.sweeps[0]?.detail}`)
  }
  if (p?.liquidityPools.length) {
    watchFor.push(
      `Liquidity pools at ${p.liquidityPools
        .slice(0, 2)
        .map((pool) => pool.level.toFixed(2))
        .join(', ')} — expect stop hunt before reversal`
    )
  }
  if (h && h.verdict !== p?.verdict && h.verdict !== 'NEUTRAL') {
    watchFor.push(`HTF (${h.resolution}) bias ${h.verdict} — do not fade without sweep confirmation`)
  }

  if (blockers.length >= 2 || opts.mtf.alignment === 'conflicting') {
    return {
      action: 'WAIT',
      confidence: 55,
      reasons: reasons.length ? reasons : ['Multiple context blockers — patience is the edge'],
      watchFor: watchFor.slice(0, 5),
      blockers: blockers.slice(0, 6),
    }
  }

  const smcBias = p?.verdict ?? 'NEUTRAL'
  const mtfRec = opts.mtf.recommendation

  if (mtfRec === 'BUY' && smcBias === 'BULLISH' && blockers.length === 0) {
    return {
      action: 'GO_BUY',
      confidence: Math.min(85, (p?.confidence ?? 50) + 10),
      reasons: [
        ...reasons,
        `MTF ${opts.mtf.alignment} bullish`,
        p?.headline ?? 'SMC supports longs',
      ].filter(Boolean),
      watchFor: watchFor.slice(0, 3),
      blockers,
    }
  }
  if (mtfRec === 'SELL' && smcBias === 'BEARISH' && blockers.length === 0) {
    return {
      action: 'GO_SELL',
      confidence: Math.min(85, (p?.confidence ?? 50) + 10),
      reasons: [
        ...reasons,
        `MTF ${opts.mtf.alignment} bearish`,
        p?.headline ?? 'SMC supports shorts',
      ].filter(Boolean),
      watchFor: watchFor.slice(0, 3),
      blockers,
    }
  }

  if (blockers.length === 1) {
    return {
      action: 'WAIT',
      confidence: 50,
      reasons,
      watchFor: watchFor.slice(0, 5),
      blockers,
    }
  }

  return {
    action: 'NEUTRAL',
    confidence: 45,
    reasons: reasons.length ? reasons : ['Mixed signals — need confirmation candle + session timing'],
    watchFor: watchFor.slice(0, 5),
    blockers,
  }
}

export async function assessTradeContext(opts: {
  symbol: string
  resolution?: string
}): Promise<TradeContextAssessment> {
  const symbol = opts.symbol.trim()
  const now = new Date()
  const chartTimeframe = resolutionToTimeframe(opts.resolution)

  const [mtf, smc, nextEvent] = await Promise.all([
    analyzeMultiTimeframe({ symbol, resolution: opts.resolution }),
    analyzeLiquidityAndInducement({ symbol, resolution: opts.resolution }),
    fetchNextHighImpactEvent(symbol),
  ])

  const activeSessions = getActiveSessionNames(now)
  const liquidity = getMarketLiquidity(now)
  const killzone = currentKillzone(now)
  const symbolStatus = getMarketStatusForSymbol(symbol)
  const nextSession = getMinutesUntilNextSession(now)
  const newsBlackout =
    nextEvent?.minutesUntil != null &&
    nextEvent.minutesUntil >= 0 &&
    nextEvent.minutesUntil <= 30

  const decision = buildDecision({
    mtf,
    smc,
    sessionLiquidity: liquidity,
    newsBlackout,
    killzone,
    nextEventMinutes: nextEvent?.minutesUntil ?? null,
  })

  const traderNote =
    decision.action === 'WAIT'
      ? `Trader read: WAIT — ${decision.blockers[0] ?? 'context not clean'}. Watch: ${decision.watchFor[0] ?? 'structure confirmation'}.`
      : decision.action.startsWith('GO_')
        ? `Trader read: ${decision.action.replace('_', ' ')} when trigger hits — session ${activeSessions.join('+') || 'closed'}, MTF ${mtf.alignment}.`
        : `Trader read: stay flat until session + structure align.`

  return {
    symbol,
    label: displaySymbolLabel(symbol),
    chartTimeframe,
    serverTimeUtc: now.toISOString(),
    session: {
      activeSessions,
      liquidity,
      killzone,
      marketOpen: isForexMarketOpen(now) || isUsStockMarketOpen(now),
      symbolStatus: symbolStatus?.label ?? null,
      nextSession: nextSession
        ? {
            name: nextSession.name,
            opensIn: formatOpensIn(nextSession.minutes),
            minutesUntil: nextSession.minutes,
          }
        : null,
    },
    nextEvent: nextEvent
      ? {
          event: nextEvent.event,
          currency: nextEvent.currency,
          impact: nextEvent.impact,
          minutesUntil: nextEvent.minutesUntil,
          opensIn:
            nextEvent.minutesUntil != null && nextEvent.minutesUntil >= 0
              ? formatOpensIn(nextEvent.minutesUntil)
              : null,
        }
      : null,
    newsBlackout,
    multiTimeframe: mtf,
    smartMoney: smc,
    decision,
    traderNote,
  }
}
