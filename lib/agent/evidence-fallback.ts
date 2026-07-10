import { buildGeneralReplyFromResearch } from '@/lib/agent/general-fallback'

/**
 * Deterministic synthesis from scout evidence when the main LLM fails or stalls.
 * Preserves gathered data - never returns a generic "try again" if facts exist.
 */

import type { LiveGrounding } from '@/lib/agent/live-grounding'
import type { ChartStateSnapshot } from '@/lib/chart-state'
import { isDirectLevelsQuestion } from '@/lib/agent/orchestrator/user-evidence'
import { renderUserEvidenceSummary } from '@/lib/agent/orchestrator/user-evidence'
import type { AgentPlan, SubAgentBrief } from '@/lib/agent/orchestrator/types'
import { sanitizePublicReply } from '@/lib/agent/orchestrator/defense'
import {
  synthesizeReplyFromSetup,
  type MarketChatLevel,
  type MarketChatResponse,
  type MarketChatSetup,
} from '@/lib/parse-market-chat-json'
import { syncSetupFromLevels, isSessionSetupQuestion, isSetupRequestQuestion, isLiquidityPoolQuestion } from '@/lib/setup-reply-format'
import { formatMarketPrice, roundMarketPrice } from '@/lib/format-market-price'

const GENERIC_REPLIES = new Set([
  'I could not generate a response. Please try again.',
  'I could not parse the response. Please try again.',
  'Empty response.',
])

const DIRECTION_SELL_RE =
  /\b(going to|will (it|gold|price|silver)|should i|is it|can i|is .{0,16} going).{0,32}(sell|short|drop|fall|decline|dump|go down|bearish|lower|crash)\b|\b(sell|short).{0,24}(gold|xau|silver|xag|now|today|here|it|this)\b/i
const DIRECTION_BUY_RE =
  /\b(going to|will (it|gold|price|silver)|should i|is it|can i|is .{0,16} going).{0,32}(buy|long|rise|rally|go up|bullish|higher|moon)\b|\b(buy|long).{0,24}(gold|xau|silver|xag|now|today|here|it|this)\b/i

/** Max stop distance as fraction of price - avoids 20d swing stops far from entry. */
const MAX_STOP_RISK_PCT = 0.028

export function isGenericOrEmptyReply(reply: string | null | undefined): boolean {
  const t = (reply ?? '').trim()
  if (!t) return true
  if (GENERIC_REPLIES.has(t)) return true
  return t.toLowerCase().includes('could not generate')
}

type TechnicalBlock = {
  trend?: string
  rsi14?: number
  swingHigh20?: number
  swingLow20?: number
  atr14?: number
  available?: boolean
  error?: string
}

type LiquidityAnalysis = {
  verdict?: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence?: number
  headline?: string
  blockers?: string[]
  confirmed?: Array<{ detail?: string; level?: number }>
  liquidityPools?: Array<{ kind?: string; detail?: string; level?: number }>
}

function readLiquidityBrief(briefs: SubAgentBrief[] | undefined): {
  primary: LiquidityAnalysis | null
  htf: LiquidityAnalysis | null
  summary: string | null
} {
  const brief = briefs?.find((b) => b.id === 'liquidity')
  if (!brief?.data) return { primary: null, htf: null, summary: brief?.summary ?? null }

  const primary = (brief.data.primary as { analysis?: LiquidityAnalysis } | undefined)?.analysis ?? null
  const htf = (brief.data.htf as { analysis?: LiquidityAnalysis } | undefined)?.analysis ?? null
  return { primary, htf, summary: brief.summary ?? null }
}

function userMessageBias(message: string): 'BUY' | 'SELL' | null {
  if (DIRECTION_SELL_RE.test(message)) return 'SELL'
  if (DIRECTION_BUY_RE.test(message)) return 'BUY'
  return null
}

function smcVerdictBias(analysis: LiquidityAnalysis | null): 'BUY' | 'SELL' | 'WAIT' {
  if (analysis?.verdict === 'BULLISH') return 'BUY'
  if (analysis?.verdict === 'BEARISH') return 'SELL'
  return 'WAIT'
}

function resolveTradeBias(
  userMessage: string,
  ta: TechnicalBlock | null,
  liquidity: { primary: LiquidityAnalysis | null; htf: LiquidityAnalysis | null }
): 'BUY' | 'SELL' | 'WAIT' {
  const asked = userMessageBias(userMessage)
  const trend = trendBias(ta)
  const smcPrimary = smcVerdictBias(liquidity.primary)
  const smcHtf = smcVerdictBias(liquidity.htf)

  if (asked === 'SELL' && (trend === 'SELL' || smcPrimary === 'SELL' || smcHtf === 'SELL')) return 'SELL'
  if (asked === 'BUY' && (trend === 'BUY' || smcPrimary === 'BUY' || smcHtf === 'BUY')) return 'BUY'
  if (smcPrimary !== 'WAIT' && smcPrimary === trend) return smcPrimary
  if (smcPrimary !== 'WAIT' && trend === 'WAIT') return smcPrimary
  if (asked && trend === asked) return asked
  if (trend !== 'WAIT') return trend
  if (smcPrimary !== 'WAIT') return smcPrimary
  if (asked) return asked
  return 'WAIT'
}

function capStopAbove(price: number, stop: number, atr: number | undefined): number {
  const maxStop = atr != null ? price + atr * 2.2 : price * (1 + MAX_STOP_RISK_PCT)
  const capped = Math.min(stop, maxStop)
  return roundMarketPrice(Math.max(capped, price * 1.0015))
}

function capStopBelow(price: number, stop: number, atr: number | undefined): number {
  const minStop = atr != null ? price - atr * 2.2 : price * (1 - MAX_STOP_RISK_PCT)
  const capped = Math.max(stop, minStop)
  return roundMarketPrice(Math.min(capped, price * 0.9985))
}

function nearestPoolStop(
  price: number,
  pools: Array<{ level?: number }> | undefined,
  side: 'above' | 'below'
): number | null {
  if (!pools?.length) return null
  const levels = pools
    .map((p) => p.level)
    .filter((l): l is number => typeof l === 'number' && Number.isFinite(l))
  if (!levels.length) return null
  if (side === 'above') {
    const above = levels.filter((l) => l > price * 1.001).sort((a, b) => a - b)
    return above[0] != null ? roundMarketPrice(above[0] * 1.0012) : null
  }
  const below = levels.filter((l) => l < price * 0.999).sort((a, b) => b - a)
  return below[0] != null ? roundMarketPrice(below[0] * 0.9988) : null
}

function formatSmartMoneySection(
  liquidity: { primary: LiquidityAnalysis | null; htf: LiquidityAnalysis | null; summary: string | null },
  bias: 'BUY' | 'SELL' | 'WAIT'
): string {
  const lines: string[] = []
  const p = liquidity.primary
  const h = liquidity.htf

  if (p?.headline || p?.verdict) {
    const flow =
      p.verdict === 'BEARISH'
        ? 'Smart money leaning **out / short** (distribution, sell-side liquidity)'
        : p.verdict === 'BULLISH'
          ? 'Smart money leaning **in / long** (accumulation, buy-side demand)'
          : 'Smart money **neutral** - wait for sweep or BOS confirmation'
    lines.push(`**Smart money:** ${flow}${p.confidence != null ? ` · ${p.confidence}% confidence` : ''}`)
    if (p.headline) lines.push(`- ${p.headline}`)
    if (p.confirmed?.length) {
      for (const c of p.confirmed.slice(0, 2)) {
        if (c.detail) lines.push(`- Confirmed: ${c.detail}`)
      }
    }
  } else if (liquidity.summary && !/scout|ms\)/i.test(liquidity.summary)) {
    lines.push(`**Smart money:** ${liquidity.summary}`)
  }

  if (h?.verdict && h.verdict !== p?.verdict) {
    lines.push(
      `- Higher timeframe: ${h.verdict.toLowerCase()}${h.headline ? ` - ${h.headline.slice(0, 90)}` : ''}`
    )
  }

  if (bias === 'SELL') {
    lines.push('- Bias: **sell-side** read - look for rejection after buy-side liquidity is taken.')
  } else if (bias === 'BUY') {
    lines.push('- Bias: **buy-side** read - look for hold above demand / sell-side sweep.')
  }

  return lines.join('\n')
}

function readTechnical(briefs: SubAgentBrief[] | undefined): TechnicalBlock | null {
  for (const id of ['setup', 'research', 'liquidity'] as const) {
    const brief = briefs?.find((b) => b.id === id)
    const ta = brief?.data?.technical
    if (ta && typeof ta === 'object' && !(ta as TechnicalBlock).error) {
      return ta as TechnicalBlock
    }
  }
  return null
}

function trendBias(ta: TechnicalBlock | null): 'BUY' | 'SELL' | 'WAIT' {
  const t = (ta?.trend ?? '').toLowerCase()
  if (t.includes('bear') || t === 'down' || t === 'downtrend') return 'SELL'
  if (t.includes('bull') || t === 'up' || t === 'uptrend') return 'BUY'
  return 'WAIT'
}

function deriveLevels(
  price: number | undefined,
  ta: TechnicalBlock | null,
  bias: 'BUY' | 'SELL' | 'WAIT',
  liquidity?: LiquidityAnalysis | null
): { entry: number | null; stopLoss: number | null; takeProfit: number | null } {
  const swingH = ta?.swingHigh20
  const swingL = ta?.swingLow20
  const atr = ta?.atr14
  const pools = liquidity?.liquidityPools

  if (!price || bias === 'WAIT') {
    return { entry: price ?? null, stopLoss: swingH ?? null, takeProfit: swingL ?? null }
  }

  if (bias === 'SELL') {
    const entry = roundMarketPrice(price)
    let stop =
      nearestPoolStop(price, pools, 'above') ??
      (swingH != null
        ? roundMarketPrice(Math.max(swingH, price * 1.002))
        : atr != null
          ? roundMarketPrice(price + atr * 1.5)
          : roundMarketPrice(price * 1.008))
    stop = capStopAbove(price, stop, atr)
    const target =
      swingL != null
        ? roundMarketPrice(swingL)
        : atr != null
          ? roundMarketPrice(price - atr * 2.5)
          : roundMarketPrice(price * 0.985)
    return { entry, stopLoss: stop, takeProfit: target }
  }

  const entry = roundMarketPrice(price)
  let stop =
    nearestPoolStop(price, pools, 'below') ??
    (swingL != null
      ? roundMarketPrice(Math.min(swingL, price * 0.998))
      : atr != null
        ? roundMarketPrice(price - atr * 1.5)
        : roundMarketPrice(price * 0.992))
  stop = capStopBelow(price, stop, atr)
  const target =
    swingH != null
      ? roundMarketPrice(swingH)
      : atr != null
        ? roundMarketPrice(price + atr * 2.5)
        : roundMarketPrice(price * 1.015)
  return { entry, stopLoss: stop, takeProfit: target }
}

function confidenceFromTa(
  ta: TechnicalBlock | null,
  bias: 'BUY' | 'SELL' | 'WAIT',
  smc?: LiquidityAnalysis | null
): number {
  if (bias === 'WAIT') return 35
  let score = 52
  const rsi = ta?.rsi14
  if (rsi != null) {
    if (bias === 'SELL' && rsi < 45) score += 8
    if (bias === 'BUY' && rsi > 55) score += 8
    if (bias === 'SELL' && rsi > 70) score -= 10
    if (bias === 'BUY' && rsi < 30) score -= 10
  }
  if (ta?.swingHigh20 != null && ta.swingLow20 != null) score += 6
  if (smc?.confidence != null) {
    const smcAligned =
      (bias === 'SELL' && smc.verdict === 'BEARISH') ||
      (bias === 'BUY' && smc.verdict === 'BULLISH')
    if (smcAligned) score += Math.min(12, Math.round(smc.confidence / 12))
    if (
      (bias === 'SELL' && smc.verdict === 'BULLISH') ||
      (bias === 'BUY' && smc.verdict === 'BEARISH')
    ) {
      score -= 8
    }
  }
  if (smc?.confirmed?.length) score += 4
  return Math.min(82, Math.max(30, score))
}

const SESSION_SETUP_RE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|tomorrow|next week|when market opens|session open|london open|ny open|asia open|give setup|setup for|new setup|fresh setup|plan for)\b/i

/** Scout fast path = instant levels only. Full setup / timing questions need the main LLM. */
export function shouldUseScoutFastPath(
  plan: AgentPlan,
  briefs: SubAgentBrief[],
  hasImages: boolean,
  userMessage: string,
  chartState?: ChartStateSnapshot | null
): boolean {
  if (!shouldSynthesizeFromScoutsOnly(plan, briefs, hasImages)) return false
  if (!isDirectLevelsQuestion(userMessage)) return false
  if (SESSION_SETUP_RE.test(userMessage)) return false
  if (isLiquidityPoolQuestion(userMessage)) return false
  if (chartState?.hasTradeSetup) return false
  return true
}

/** Liquidity-only questions - answer pools from scout data, not a full trade setup. */
export function shouldUseLiquidityFastPath(
  plan: AgentPlan,
  briefs: SubAgentBrief[],
  hasImages: boolean,
  userMessage: string
): boolean {
  if (hasImages || !plan.allowToolCalls || plan.skipPrefetch) return false
  if (plan.responseMode === 'conversational') return false
  if (!isLiquidityPoolQuestion(userMessage)) return false
  if (isDirectLevelsQuestion(userMessage) || isSetupRequestQuestion(userMessage)) return false

  const liquidityBrief = briefs.find((b) => b.id === 'liquidity')
  const setupBrief = briefs.find((b) => b.id === 'setup')
  if (!liquidityBrief?.ok && !setupBrief?.ok) return false

  const { primary } = readLiquidityBrief(briefs)
  const ta = readTechnical(briefs)
  return Boolean(
    primary?.liquidityPools?.length ||
      primary?.headline ||
      ta?.swingHigh20 != null ||
      ta?.swingLow20 != null
  )
}

/** Broad setup / session questions - scouts have data; synthesize with Gemini (not main-loop template). */
export function shouldUseScoutSetupSynthesis(
  plan: AgentPlan,
  briefs: SubAgentBrief[],
  hasImages: boolean,
  userMessage: string,
  chartState?: ChartStateSnapshot | null
): boolean {
  if (shouldUseScoutFastPath(plan, briefs, hasImages, userMessage, chartState)) return false
  if (hasImages || !plan.allowToolCalls || plan.skipPrefetch) return false
  if (plan.responseMode === 'conversational') return false
  if (isLiquidityPoolQuestion(userMessage) && !isSetupRequestQuestion(userMessage)) return false
  if (
    chartState?.hasTradeSetup &&
    !isSetupRequestQuestion(userMessage) &&
    !isSessionSetupQuestion(userMessage) &&
    !isDirectLevelsQuestion(userMessage)
  ) {
    return false
  }

  const setupIntent =
    plan.intent === 'setup' ||
    plan.intent === 'reversal' ||
    plan.taskTags.includes('levels') ||
    isSessionSetupQuestion(userMessage) ||
    isSetupRequestQuestion(userMessage)

  if (!setupIntent) return false
  return shouldSynthesizeFromScoutsOnly(plan, briefs, hasImages)
}

export function shouldSynthesizeFromScoutsOnly(
  plan: AgentPlan,
  briefs: SubAgentBrief[],
  hasImages: boolean
): boolean {
  if (hasImages || !plan.allowToolCalls || plan.skipPrefetch) return false
  if (plan.responseMode === 'conversational') return false

  const actionable =
    plan.intent === 'setup' ||
    plan.intent === 'reversal' ||
    plan.intent === 'goal' ||
    plan.taskTags.includes('levels') ||
    plan.taskTags.includes('entry_timing') ||
    plan.taskTags.includes('smart_money')

  if (!actionable) return false

  const setupBrief = briefs.find((b) => b.id === 'setup')
  const liquidityBrief = briefs.find((b) => b.id === 'liquidity')
  if (!setupBrief?.ok && !liquidityBrief?.ok) return false

  const ta = readTechnical(briefs)
  const { primary } = readLiquidityBrief(briefs)
  return Boolean(
    (ta && (ta.trend || ta.swingHigh20 != null || ta.swingLow20 != null)) ||
      primary?.verdict ||
      primary?.headline
  )
}

export type EvidenceFallbackInput = {
  userMessage: string
  symbolLabel?: string
  grounding: LiveGrounding
  plan: AgentPlan
  subAgentBriefs?: SubAgentBrief[]
  chartState?: ChartStateSnapshot | null
  reason?: string
  /** When true, reply is a compact draft - Gemini synthesis should expand it. */
  minimalReply?: boolean
}

function poolSideFromKind(kind: string | undefined, detail: string | undefined): 'buy' | 'sell' | null {
  const text = `${kind ?? ''} ${detail ?? ''}`.toLowerCase()
  if (/equal-low|lows|buy.?side|demand|below|ssl/.test(text)) return 'buy'
  if (/equal-high|highs|sell.?side|supply|above/.test(text)) return 'sell'
  return null
}

function userAsksBuySide(message: string): boolean {
  return /\bbuy.?side\b/i.test(message)
}

function userAsksSellSide(message: string): boolean {
  return /\bsell.?side\b/i.test(message)
}

/** Answer buy-side / sell-side liquidity questions from scout SMC data. */
export function buildLiquidityPoolChatResponse(
  input: EvidenceFallbackInput
): MarketChatResponse | null {
  const briefs = input.subAgentBriefs ?? []
  const liquidity = readLiquidityBrief(briefs)
  const ta = readTechnical(briefs)
  const quote = input.grounding.quote
  const symbol = input.symbolLabel ?? 'this market'
  const msg = input.userMessage

  const asksBuy = userAsksBuySide(msg)
  const asksSell = userAsksSellSide(msg)
  const asksBoth = !asksBuy && !asksSell

  const pools = [
    ...(liquidity.primary?.liquidityPools ?? []),
    ...(liquidity.htf?.liquidityPools ?? []),
  ]

  const levels: MarketChatLevel[] = []
  const seen = new Set<number>()

  const addLevel = (price: number, label: string) => {
    const rounded = roundMarketPrice(price)
    if (seen.has(rounded)) return
    seen.add(rounded)
    levels.push({ price: rounded, label, kind: 'liquidity' })
  }

  for (const p of pools) {
    if (typeof p.level !== 'number' || !Number.isFinite(p.level)) continue
    const side = poolSideFromKind(p.kind, p.detail)
    if (side === 'buy' && (asksBuy || asksBoth)) {
      addLevel(p.level, p.detail?.slice(0, 48) || 'Buy-side liquidity')
    } else if (side === 'sell' && (asksSell || asksBoth)) {
      addLevel(p.level, p.detail?.slice(0, 48) || 'Sell-side liquidity')
    }
  }

  if ((asksBuy || asksBoth) && ta?.swingLow20 != null) {
    addLevel(ta.swingLow20, 'Buy-side liquidity (20-bar swing low)')
  }
  if ((asksSell || asksBoth) && ta?.swingHigh20 != null) {
    addLevel(ta.swingHigh20, 'Sell-side liquidity (20-bar swing high)')
  }

  if (levels.length === 0 && !liquidity.primary?.headline && !ta?.swingHigh20 && !ta?.swingLow20) {
    return null
  }

  levels.sort((a, b) => b.price - a.price)

  const priceLine = quote
    ? `**${symbol}** at **${quote.price}** (${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%).`
    : `**${symbol}**`

  const heading = asksBuy
    ? `### ${symbol} - buy-side liquidity`
    : asksSell
      ? `### ${symbol} - sell-side liquidity`
      : `### ${symbol} - liquidity pools`

  const replyLines: string[] = [heading, '', priceLine, '']

  if (asksBuy || asksBoth) {
    const buyLevels = levels.filter((l) => /buy|low|demand/i.test(l.label ?? ''))
    if (buyLevels.length) {
      replyLines.push('**Buy-side liquidity** (stop clusters below - price often sweeps these before reversing up):')
      for (const l of buyLevels.slice(0, 4)) {
        replyLines.push(`- **${formatMarketPrice(l.price, symbol ?? '')}** - ${l.label}`)
      }
      replyLines.push('')
    }
  }

  if (asksSell || asksBoth) {
    const sellLevels = levels.filter((l) => /sell|high|supply/i.test(l.label ?? ''))
    if (sellLevels.length) {
      replyLines.push('**Sell-side liquidity** (stop clusters above - price often sweeps these before reversing down):')
      for (const l of sellLevels.slice(0, 4)) {
        replyLines.push(`- **${formatMarketPrice(l.price, symbol ?? '')}** - ${l.label}`)
      }
      replyLines.push('')
    }
  }

  if (liquidity.primary?.headline) {
    replyLines.push(`- **Structure:** ${liquidity.primary.headline}`)
  }
  if (liquidity.primary?.confirmed?.length) {
    for (const c of liquidity.primary.confirmed.slice(0, 2)) {
      if (c.detail) replyLines.push(`- Confirmed: ${c.detail}`)
    }
  }

  if (input.chartState?.hasTradeSetup && input.chartState.activeSetup) {
    const a = input.chartState.activeSetup
    replyLines.push(
      '',
      `Your **${a.side}** trade setup (E ${formatMarketPrice(a.entry, symbol ?? '')}, SL ${formatMarketPrice(a.stopLoss, symbol ?? '')}, TP ${formatMarketPrice(a.takeProfit, symbol ?? '')}) stays on the chart - these are separate liquidity pool levels.`
    )
  }

  if (levels.length === 0) {
    replyLines.push('', 'No clean equal-high/low pools in recent structure - watch the nearest swing high/low for liquidity.')
  }

  return {
    reply: sanitizePublicReply(replyLines.join('\n')),
    setup: null,
    levels: levels.slice(0, 8),
    zones: [],
    drawIntent: levels.length > 0,
  }
}

/** Build a full MarketChatResponse from scout + grounding facts (no LLM). */
export function buildEvidenceFallbackResponse(
  input: EvidenceFallbackInput
): MarketChatResponse | null {
  const briefs = input.subAgentBriefs ?? []
  if (briefs.length === 0 && !input.grounding.quote) return null

  const ta = readTechnical(briefs)
  const liquidity = readLiquidityBrief(briefs)
  const quote = input.grounding.quote
  const price = quote?.price
  const symbol = input.symbolLabel ?? 'this market'
  let bias = resolveTradeBias(input.userMessage, ta, liquidity)

  const rsi = ta?.rsi14
  if (rsi != null && rsi < 32 && bias === 'SELL') bias = 'WAIT'
  if (rsi != null && rsi > 68 && bias === 'BUY') bias = 'WAIT'

  const { entry, stopLoss, takeProfit } = deriveLevels(price, ta, bias, liquidity.primary)
  const confidence = confidenceFromTa(ta, bias, liquidity.primary)
  const sessionSetup = isSessionSetupQuestion(input.userMessage)
  const marketClosed = input.grounding.marketStatusForSymbol?.isOpen === false

  let activeSetupNote: string | undefined
  if (input.chartState?.hasTradeSetup && input.chartState.activeSetup) {
    const a = input.chartState.activeSetup
    if (SESSION_SETUP_RE.test(input.userMessage) || /\b(new|fresh|another|replace|update)\b/i.test(input.userMessage)) {
      activeSetupNote = `Chart already has a ${a.side} setup (E ${a.entry}, SL ${a.stopLoss}, TP ${a.takeProfit}). Clear it on the card or chart toolbar to replace - or treat this as an update.`
    }
  }

  const dayMatch = input.userMessage.match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|weekend)\b/i
  )
  const validUntil = dayMatch?.[1]
    ? `Through ${dayMatch[1]} session - re-validate at open`
    : sessionSetup
      ? 'Next major session open'
      : 'Next 24h'

  const setup: MarketChatSetup = {
    bias: entry != null && stopLoss != null && takeProfit != null ? bias : 'WAIT',
    entryType: sessionSetup || marketClosed || bias === 'WAIT' ? 'limit' : 'market',
    entry,
    triggerZone: null,
    triggerCondition:
      sessionSetup && dayMatch?.[1]
        ? `Activate on ${dayMatch[1]} - wait for session open + structure confirmation (retest or sweep first)`
        : bias === 'WAIT'
          ? 'Wait for structure confirmation before entry'
          : ta?.trend
            ? `${ta.trend} structure - verify on your timeframe before sizing`
            : '',
    validUntil,
    invalidation: bias === 'SELL' ? stopLoss : bias === 'BUY' ? stopLoss : null,
    stopLoss,
    takeProfit,
    confidence,
    timeframe: input.plan.intent === 'setup' ? '15m' : '1h',
    confirmation: ta?.trend
      ? `Trend: ${ta.trend}${rsi != null ? ` · RSI ${rsi.toFixed(1)}` : ''}${liquidity.primary?.verdict ? ` · SMC ${liquidity.primary.verdict.toLowerCase()}` : ''}`
      : liquidity.primary?.headline?.slice(0, 100) ?? '',
    risks: input.grounding.newsBlackout
      ? ['High-impact news window - reduce size or wait']
      : liquidity.primary?.blockers?.length
        ? liquidity.primary.blockers.slice(0, 2)
        : ['Based on pre-fetched structure - verify live before trading'],
  }

  const levels: MarketChatLevel[] = []
  if (entry != null) levels.push({ price: entry, label: 'Entry', kind: 'entry' })
  if (stopLoss != null) levels.push({ price: stopLoss, label: 'Stop', kind: 'resistance' })
  if (takeProfit != null) levels.push({ price: takeProfit, label: 'Target', kind: 'target' })
  if (ta?.swingHigh20 != null) {
    levels.push({ price: roundMarketPrice(ta.swingHigh20), label: 'Swing high', kind: 'resistance' })
  }
  if (ta?.swingLow20 != null) {
    levels.push({ price: roundMarketPrice(ta.swingLow20), label: 'Swing low', kind: 'support' })
  }

  const priceLine = quote
    ? `**${symbol}** at **${quote.price}** (${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%).`
    : `**${symbol}**`

  const smcSection = formatSmartMoneySection(liquidity, bias)

  const evidence = renderUserEvidenceSummary({
    briefs,
    intent: input.plan.intent,
    userMessage: input.userMessage,
    symbolLabel: input.symbolLabel,
    taskTags: input.plan.taskTags,
    compact: input.plan.taskTags.includes('levels'),
  })

  const contextBullets: string[] = []
  if (ta?.trend) {
    contextBullets.push(`Trend **${ta.trend}**${rsi != null ? ` · RSI ${rsi.toFixed(1)}` : ''}`)
  }

  const replyBody = synthesizeReplyFromSetup(setup, levels, symbol, {
    userMessage: input.userMessage,
    symbol: input.symbolLabel,
    priceLine,
    smartMoneySection: smcSection,
    contextBullets,
    activeSetupNote,
    proseLevelsOnlyInCard:
      input.minimalReply === true || isDirectLevelsQuestion(input.userMessage),
  })

  const intro =
    !input.minimalReply &&
    input.reason &&
    !input.reason.toLowerCase().includes('round-trip')
      ? `Analysis from gathered data (${input.reason.replace(/scout|pipeline|tool/gi, 'market data')}):`
      : ''

  const replyParts = intro ? [intro, '', replyBody] : [replyBody]
  if (!input.minimalReply && evidence.trim() && !replyBody.includes('### Context')) {
    replyParts.unshift(evidence)
  }

  return {
    reply: sanitizePublicReply(replyParts.filter(Boolean).join('\n\n')),
    setup: syncSetupFromLevels(setup, levels) ?? setup,
    levels: levels.slice(0, 8),
    zones: [],
    drawIntent: setup.bias === 'BUY' || setup.bias === 'SELL',
  }
}

/** Prefer evidence draft, then research bullets, then null. */
export function resolveEvidenceFallback(
  input: EvidenceFallbackInput
): MarketChatResponse | null {
  const evidence = buildEvidenceFallbackResponse(input)
  if (evidence && !isGenericOrEmptyReply(evidence.reply)) return evidence

  if (input.plan.intent === 'general') {
    return buildGeneralReplyFromResearch(input.subAgentBriefs, input.userMessage)
  }

  return evidence
}
