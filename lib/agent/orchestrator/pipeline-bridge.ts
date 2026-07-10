/**
 * Bridge chat agent ↔ 8-specialist scan pipeline (TypeScript on Vercel; Python optional locally).
 * Injects confluence + TradingSetup into the main LLM context and merges into final JSON.
 */

import { runPipelineStreamingWithGrounding } from '@/lib/agent/pipeline'
import { specialistRunOk } from '@/lib/agent/specialists/helpers'
import type { LiveGrounding } from '@/lib/agent/live-grounding'
import type {
  PipelineResult,
  SpecialistId,
  SpecialistReport,
  TradingSetup,
} from '@/lib/agent/pipeline-types'
import type { ChartStateSnapshot } from '@/lib/chart-state'
import type {
  MarketChatLevel,
  MarketChatResponse,
  MarketChatSetup,
} from '@/lib/parse-market-chat-json'
import { formatMarketPrice } from '@/lib/format-market-price'
import { sanitizePublicReply } from '@/lib/agent/orchestrator/defense'
import { renderUserEvidenceSummary, wantsNewsInReply } from '@/lib/agent/orchestrator/user-evidence'
import { isCryptoSymbol } from '@/lib/agent/orchestrator/planner'
import type { AgentPlan, SubAgentBrief, SubAgentId } from './types'

const LEVELS_FAST_PATH_RE =
  /\b(where (are|is)|show me|give me|what (are|is)).{0,40}(entry|stop|target|tp|sl|levels?)\b/i
const CANDLE_TRIGGER_FAST_PATH_RE =
  /\b(what candle|candle (should|can|to|do)|wait for|trigger|confirmation|confirm|signal candle|entry candle|which candle|when (to|should i) enter)\b/i
/** Explicit backward-reference to what's ALREADY drawn - only these phrasings
 * are safe to answer with a verbatim chart echo. Anything else asking for
 * entry/stop/target gets fresh specialist analysis instead of a stale read. */
const CHART_RECALL_RE =
  /\b(again|remind me|what did (i|you) (set|draw|put)|currently (on|showing)|already (drew|drawn|set|on)|on (my|the) chart|existing setup|current setup)\b/i

export type PipelineBridgeEmit = (event: {
  type: string
  agent?: string
  ok?: boolean
  summary?: string
  durationMs?: number
  score?: number
  bias?: string
  blockers?: string[]
  specialistCount?: number
}) => void

/** Tools already covered by the 8-specialist pipeline - skip gap-fill when confluence ran. */
export const PIPELINE_COVERED_TOOLS = new Set([
  'get_technical_analysis',
  'get_intraday_candles',
  'get_volume_profile',
  'get_orderbook_depth',
  'get_metals_deep_market',
  'get_crypto_fear_greed',
  'get_economic_calendar',
])

export function resolutionToTimeframe(resolution?: string): string {
  const r = (resolution ?? '60').trim().toUpperCase()
  if (r === 'D' || r === '1D') return '1d'
  if (r === 'W' || r === '1W') return '1w'
  if (r === 'M' || r === '1M') return '1mo'
  const n = parseInt(r, 10)
  if (n === 1) return '1m'
  if (n === 5) return '5m'
  if (n === 15) return '15m'
  if (n === 30) return '30m'
  if (n === 60) return '1h'
  if (n === 240) return '4h'
  if (n === 720) return '12h'
  return '1h'
}

/**
 * Pick only the specialists this specific question needs instead of always
 * running all 8 - cheaper and faster, and keeps confluence scoring focused
 * on evidence the question actually calls for.
 */
export function selectSpecialistsForChat(plan: AgentPlan, symbol?: string): SpecialistId[] {
  // Core structure: always needed for any entry/stop/target read.
  // technical/momentum/regime are LLM-backed reads of price action; smc and
  // events are rule-based (cheap) - smc gives structure, events is a hard
  // safety veto on news blackout, so both run unconditionally too.
  const select = new Set<SpecialistId>(['technical', 'momentum', 'regime', 'smc', 'events'])

  const wantsSetupStructure =
    plan.intent === 'setup' ||
    plan.intent === 'reversal' ||
    plan.intent === 'goal' ||
    plan.taskTags.includes('levels') ||
    plan.taskTags.includes('entry_timing')

  // MTF confirmation is treated as mandatory before BUY/SELL in the planner's
  // own self-questions - make that real by actually running it.
  if (wantsSetupStructure) select.add('mtf')

  if (plan.taskTags.includes('reversal') || plan.taskTags.includes('candle_trigger')) {
    select.add('pattern')
  }

  if (plan.taskTags.includes('smart_money') || plan.taskTags.includes('macro_risk') || isCryptoSymbol(symbol)) {
    select.add('sentiment')
  }

  return [...select]
}

export function shouldRunSpecialistPipeline(
  plan: AgentPlan,
  opts: { symbol?: string; undercover?: boolean }
): boolean {
  if (opts.undercover || plan.undercoverMode) return false
  if (!opts.symbol?.trim()) return false
  if (!plan.allowToolCalls) return false
  return plan.usePipeline === true
}

export async function runChatSpecialistPipeline(opts: {
  symbol: string
  symbolLabel?: string
  resolution?: string
  grounding: LiveGrounding
  deadlineMs: number
  emit: PipelineBridgeEmit
  /** When provided, dispatch only the specialists this question needs
   *  (selectSpecialistsForChat). Omit for the explicit "full 8-specialist
   *  scan" tool path, which intentionally runs everything. */
  plan?: AgentPlan
}): Promise<PipelineResult | null> {
  const remainingMs = opts.deadlineMs - Date.now()
  if (remainingMs < 18_000) {
    return null
  }

  const symbol = opts.symbol.toUpperCase()
  const timeframe = resolutionToTimeframe(opts.resolution)
  const select = opts.plan ? selectSpecialistsForChat(opts.plan, symbol) : undefined
  // Full requested set when we have budget; tight budget trims to core-only
  // (drop pattern/sentiment if they snuck in) to protect the Vercel timeout.
  const useFast = remainingMs < 35_000
  const effectiveSelect =
    useFast && select ? select.filter((id) => id !== 'pattern' && id !== 'sentiment') : select

  opts.emit({ type: 'confluence_start', agent: symbol })

  try {
    const gen = runPipelineStreamingWithGrounding(
      { symbol, timeframe, fast: useFast, select: effectiveSelect, riskBudgetPct: 1, mode: 'chat' },
      opts.grounding
    )

    let result: PipelineResult | null = null
    for await (const event of gen) {
      if (Date.now() > opts.deadlineMs - 6_000) break

      if (event.type === 'specialist_started') {
        opts.emit({ type: 'sub_agent_start', agent: `specialist:${event.id}` })
      } else if (event.type === 'specialist_done') {
        opts.emit({
          type: 'sub_agent_done',
          agent: `specialist:${event.report.id}`,
          ok: specialistRunOk(event.report),
          summary: event.report.situation ?? `${event.report.verdict} · ${event.report.headline}`,
          durationMs: event.report.durationMs,
        })
      } else if (event.type === 'orchestrator_started') {
        opts.emit({
          type: 'sub_agent_start',
          agent: 'specialist:orchestrator',
        })
      } else if (event.type === 'done') {
        result = event.result
        opts.emit({
          type: 'sub_agent_done',
          agent: 'specialist:orchestrator',
          ok: true,
          summary: `${result.setup.bias} · confluence ${result.setup.confluenceScore}/100`,
          durationMs: result.durationMs,
        })
        opts.emit({
          type: 'confluence',
          score: result.setup.confluenceScore,
          bias: result.setup.bias,
          blockers: result.setup.blockers,
          specialistCount: result.reports.length,
        })
      }
    }
    return result
  } catch (err) {
    console.warn(
      '[pipeline-bridge] specialist scan failed:',
      err instanceof Error ? err.message : err
    )
    opts.emit({
      type: 'confluence',
      score: 0,
      bias: 'HOLD',
      blockers: ['Specialist pipeline failed'],
      specialistCount: 0,
    })
    return null
  }
}

function formatReportLine(r: SpecialistReport): string {
  const flag = r.degraded ? ' (degraded)' : ''
  const block = r.blockers?.length ? ` [${r.blockers.join('; ')}]` : ''
  // Prefer the rich, plain-language situation over the bare verdict tag -
  // the main LLM should reason over real analysis, not just BULLISH/BEARISH.
  const narrative = r.situation?.trim() || r.headline
  return `- ${r.id}: ${r.verdict} (${r.confidence}%) - ${narrative}${block}${flag}`
}

export function renderPipelineBriefForPrompt(result: PipelineResult): string {
  const { setup, reports } = result
  const lines = [
    'SPECIALIST CONFLUENCE (8-agent scan - treat as primary evidence for setup/levels):',
    `Symbol: ${result.symbolLabel} (${result.symbol}) · TF: ${result.timeframe}`,
    `Confluence: ${setup.confluenceScore}/100 · Bias: ${setup.bias}`,
  ]

  if (setup.entry != null) {
    lines.push(
      `Pipeline levels: entry ${setup.entry} · SL ${setup.stopLoss ?? '-'} · TP ${setup.takeProfit ?? '-'} · R:R ${setup.riskRewardRatio?.toFixed(1) ?? '-'}`
    )
  }
  if (setup.blockers.length > 0) {
    lines.push(`Blockers: ${setup.blockers.join('; ')}`)
  }
  lines.push('', 'Specialist votes:')
  for (const r of reports) {
    lines.push(formatReportLine(r))
  }
  lines.push(
    '',
    setup.reasoning,
    '',
    'SYNTHESIS RULE: Anchor your JSON setup to pipeline levels when confluence ≥ 55 and blockers are empty.',
    'If pipeline bias is HOLD or blockers exist, prefer WAIT with triggerZone - do not contradict blockers without citing fresh tool data.',
    'You may refine prices ± small buffer vs pipeline; re-verify vs live grounding quote.',
    'Do NOT re-call get_technical_analysis / get_intraday_candles unless pipeline was degraded - use pipeline evidence above.'
  )
  return lines.join('\n')
}

function levelsFromPipeline(setup: TradingSetup): MarketChatLevel[] {
  const levels: MarketChatLevel[] = []
  if (setup.entry != null) {
    levels.push({ price: setup.entry, label: 'Entry', kind: 'entry' })
  }
  if (setup.stopLoss != null) {
    levels.push({ price: setup.stopLoss, label: 'Stop', kind: 'support' })
  }
  if (setup.takeProfit != null) {
    levels.push({ price: setup.takeProfit, label: 'Target', kind: 'target' })
  }
  return levels
}

function isSpecialistReasoningDump(text: string): boolean {
  return /smc=|momentum=|pattern=|sentiment=|regime=/i.test(text)
}

function shortPlanLine(setup: TradingSetup, reports?: SpecialistReport[]): string {
  if (setup.blockers.length > 0) {
    return setup.blockers.slice(0, 2).join(' · ')
  }
  const regime = reports?.find((r) => r.id === 'regime')
  if (regime?.situation) return regime.situation.slice(0, 140)
  if (regime?.headline && !isSpecialistReasoningDump(regime.headline)) {
    return regime.headline.slice(0, 140)
  }
  const r = setup.reasoning.trim()
  if (!r || isSpecialistReasoningDump(r)) return ''
  const first = r.split(/[.!?\n]/).find((s) => s.trim().length > 8)
  return first?.trim().slice(0, 140) ?? ''
}

function baseChatSetup(
  setup: TradingSetup,
  timeframe: string,
  reports?: SpecialistReport[]
): MarketChatSetup {
  const hasBlockers = setup.blockers.length > 0 || setup.bias === 'HOLD'
  const plan = shortPlanLine(setup, reports)
  return {
    bias: hasBlockers ? 'WAIT' : setup.bias,
    entryType: 'market',
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    confidence: setup.confluenceScore,
    timeframe,
    confirmation: '',
    risks: setup.blockers.slice(0, 3),
    triggerCondition: plan || (hasBlockers ? 'Confirm trigger before entry' : ''),
    validUntil: setup.validUntil ?? 'Next 24h',
    invalidation: setup.stopLoss,
    triggerZone: null,
  }
}

/**
 * Merge institutional pipeline setup into the chat JSON so chart + auto-trader stay aligned.
 * Pipeline wins on levels when confluence ≥ 55; blockers force WAIT.
 */
export function mergePipelineIntoChatResponse(
  response: MarketChatResponse,
  pipeline: PipelineResult,
  opts?: { resolution?: string }
): MarketChatResponse {
  const ps = pipeline.setup
  const tf = ps.timeframe || resolutionToTimeframe(opts?.resolution)
  const merged: MarketChatResponse = {
    ...response,
    levels: [...(response.levels ?? [])],
    zones: [...(response.zones ?? [])],
  }

  const pipelineSetup = baseChatSetup(ps, tf, pipeline.reports)
  const score = ps.confluenceScore
  const hasBlockers = ps.blockers.length > 0 || ps.bias === 'HOLD'

  if (score >= 55 && !hasBlockers && ps.entry != null) {
    merged.setup = {
      ...(merged.setup ?? pipelineSetup),
      ...pipelineSetup,
      triggerCondition:
        merged.setup?.triggerCondition?.trim() || pipelineSetup.triggerCondition,
      triggerZone: merged.setup?.triggerZone ?? pipelineSetup.triggerZone,
      entryType: merged.setup?.entryType ?? pipelineSetup.entryType,
      confidence: Math.max(merged.setup?.confidence ?? 0, score),
    }
    if (merged.levels.length === 0) {
      merged.levels = levelsFromPipeline(ps)
    }
    if (merged.drawIntent == null) {
      merged.drawIntent = true
    }
  } else if (hasBlockers || score < 45) {
    merged.setup = {
      ...(merged.setup ?? pipelineSetup),
      bias: 'WAIT',
      confidence: Math.max(merged.setup?.confidence ?? 0, score),
      entry: ps.entry ?? merged.setup?.entry ?? null,
      stopLoss: ps.stopLoss ?? merged.setup?.stopLoss ?? null,
      takeProfit: ps.takeProfit ?? merged.setup?.takeProfit ?? null,
      risks: [...new Set([...(merged.setup?.risks ?? []), ...ps.blockers])].slice(0, 6),
      triggerCondition:
        ps.blockers.join(' · ') ||
        merged.setup?.triggerCondition ||
        'Awaiting clearer specialist confluence',
    }
    if (merged.drawIntent == null && ps.entry != null) {
      merged.drawIntent = true
    }
  } else if (!merged.setup && ps.entry != null) {
    merged.setup = pipelineSetup
    if (merged.levels.length === 0) {
      merged.levels = levelsFromPipeline(ps)
    }
  }

  return merged
}

/** True only for explicit "what's already on my chart" backward-reference
 * phrasing - the one case where echoing the drawn setup verbatim (instead of
 * running fresh analysis) is actually the right answer. */
export function isChartRecallQuestion(message: string): boolean {
  return CHART_RECALL_RE.test(message)
}

/** Short "where are entry/stop/target?" questions that ALSO explicitly recall
 * what's on the chart - the only case that may skip fresh analysis. Any other
 * levels/setup phrasing must go through the specialist pipeline instead. */
export function canUsePipelineLevelsFastPath(message: string, plan: AgentPlan): boolean {
  if (plan.undercoverMode || plan.intent === 'conversational') return false
  if (CANDLE_TRIGGER_FAST_PATH_RE.test(message)) return false
  if (!plan.taskTags.includes('levels') && plan.intent !== 'setup') return false
  if (!isChartRecallQuestion(message)) return false
  return LEVELS_FAST_PATH_RE.test(message)
}

export function isDirectLevelsQuestion(message: string): boolean {
  return LEVELS_FAST_PATH_RE.test(message)
}

/** Pipeline has enough structure to answer a direct levels question without the main LLM loop. */
export function pipelineReadyForLevelsFastPath(setup: TradingSetup): boolean {
  if (setup.confluenceScore < 35) return false
  const hasEntry = setup.entry != null
  const hasStop = setup.stopLoss != null
  const hasTarget = setup.takeProfit != null
  if (hasEntry && hasStop && hasTarget) return true
  if (hasEntry && (hasStop || hasTarget)) return true
  return false
}

/** Sub-agents that duplicate pipeline data - skip when specialists already ran. */
export function filterSubAgentsAfterPipeline(
  subAgents: SubAgentId[],
  opts: { pipelineRanOk: boolean; message: string; plan: AgentPlan }
): SubAgentId[] {
  if (!opts.pipelineRanOk) return subAgents

  let filtered = subAgents.filter((id) => id !== 'setup')

  if (isDirectLevelsQuestion(opts.message)) {
    filtered = filtered.filter((id) => id !== 'liquidity' && id !== 'verification')
  }

  return filtered
}

/** Prompt block listing tools already executed - prevents duplicate fetches in the main loop. */
export function renderPipelineToolPlanForMainAgent(
  executedTools: string[],
  pipelineRanOk: boolean
): string {
  if (!pipelineRanOk) return ''
  const covered = [...PIPELINE_COVERED_TOOLS]
  const alsoRan = executedTools.filter((t) => !PIPELINE_COVERED_TOOLS.has(t))
  const lines = [
    'DATA ALREADY GATHERED (specialist pipeline + scouts - do NOT re-fetch unless stale):',
    `- Covered by pipeline: ${covered.join(', ')}`,
  ]
  if (alsoRan.length > 0) {
    lines.push(`- Also executed: ${[...new Set(alsoRan)].slice(0, 12).join(', ')}`)
  }
  lines.push(
    '',
    'EXECUTION PLAN for this turn:',
    '1. Synthesize answer from evidence below - prefer ZERO new tool calls.',
    '2. Only call a tool if a critical gap remains (e.g. chart_mcp_draw_setup when levels exist but chart is empty).',
    '3. Never call get_technical_analysis, get_intraday_candles, get_volume_profile, or get_orderbook_depth again this turn.'
  )
  return lines.join('\n')
}

export function buildChartStateLevelsChatResponse(
  chartState: ChartStateSnapshot,
  opts: {
    symbolLabel: string
    grounding: LiveGrounding
  }
): MarketChatResponse | null {
  const active = chartState.activeSetup
  if (!active) return null

  const bias = active.side === 'long' ? 'BUY' : 'SELL'
  const setup: MarketChatSetup = {
    bias,
    entryType: active.pending ? 'limit' : 'market',
    entry: active.entry,
    stopLoss: active.stopLoss,
    takeProfit: active.takeProfit,
    triggerZone: null,
    triggerCondition: active.pending
      ? 'Pending entry - wait for price to reach the entry zone'
      : 'Active setup on chart',
    validUntil: 'While visible on chart',
    invalidation: active.stopLoss,
    confidence: 70,
    timeframe: chartState.resolution ? resolutionToTimeframe(chartState.resolution) : '15m',
    confirmation: `Levels from your chart (${active.source} ${active.side} setup).`,
    risks: [],
  }
  const levels: MarketChatLevel[] = [
    { price: active.entry, label: 'Entry', kind: 'entry' },
    { price: active.stopLoss, label: 'Stop', kind: 'support' },
    { price: active.takeProfit, label: 'Target', kind: 'target' },
  ]

  const quote = opts.grounding.quote
  const replyParts = [
    `### ${opts.symbolLabel} - entry, stop & target (on chart)`,
    '',
    quote
      ? `Live **${quote.price}** (${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%).`
      : '',
    '',
    `- Entry: **${formatMarketPrice(active.entry, opts.symbolLabel)}**`,
    `- Stop: **${formatMarketPrice(active.stopLoss, opts.symbolLabel)}**`,
    `- Target: **${formatMarketPrice(active.takeProfit, opts.symbolLabel)}**`,
    '',
    setup.confirmation,
  ].filter(Boolean)

  return {
    reply: sanitizePublicReply(replyParts.join('\n')),
    setup,
    levels,
    zones: [],
    drawIntent: true,
  }
}

export function buildPipelineLevelsChatResponse(
  pipeline: PipelineResult,
  opts: {
    symbolLabel: string
    resolution?: string
    grounding: LiveGrounding
    userMessage?: string
  }
): MarketChatResponse {
  const ps = pipeline.setup
  const tf = ps.timeframe || resolutionToTimeframe(opts.resolution)
  const setup = baseChatSetup(ps, tf, pipeline.reports)
  const levels = levelsFromPipeline(ps)
  const quote = opts.grounding.quote
  const rr =
    setup.entry != null && setup.stopLoss != null && setup.takeProfit != null
      ? (() => {
          const risk = Math.abs(setup.entry! - setup.stopLoss!)
          const reward = Math.abs(setup.takeProfit! - setup.entry!)
          return risk > 0 ? (reward / risk).toFixed(1) : null
        })()
      : null

  const plan = shortPlanLine(ps, pipeline.reports)
  const replyParts: string[] = []

  if (isDirectLevelsQuestion(opts.userMessage ?? '')) {
    replyParts.push(
      `**${opts.symbolLabel}** - entry, stop & target`,
      '',
      quote
        ? `Price **${quote.price}** (${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%) · **${setup.bias}** · ${ps.confluenceScore}/100 confluence${rr ? ` · R:R ${rr}` : ''}.`
        : `**${setup.bias}** · ${ps.confluenceScore}/100 confluence${rr ? ` · R:R ${rr}` : ''}.`,
      '',
      'Levels are in the table below.'
    )
    if (plan) replyParts.push('', plan)
  } else {
    replyParts.push(
      `### ${opts.symbolLabel} - entry, stop & target`,
      '',
      quote
        ? `Live **${quote.price}** (${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%) · confluence **${ps.confluenceScore}/100** · **${setup.bias}**.`
        : `Confluence **${ps.confluenceScore}/100** · **${setup.bias}**.`
    )
    if (rr) {
      replyParts.push('', `Risk/reward ≈ **${rr}** - see level table below.`)
    } else {
      replyParts.push('', 'Levels are in the table below.')
    }
    if (ps.blockers.length > 0) {
      replyParts.push('', `**Watch:** ${ps.blockers.slice(0, 2).join(' · ')}`)
    }
    if (plan) replyParts.push('', plan)
  }

  return {
    reply: sanitizePublicReply(replyParts.join('\n')),
    setup,
    levels,
    zones: [],
    drawIntent: setup.entry != null,
  }
}

function reportById(reports: SpecialistReport[], id: SpecialistReport['id']): SpecialistReport | undefined {
  return reports.find((r) => r.id === id)
}

/** Reversal vs continuation read from specialist votes - no extra LLM call. */
function buildReversalContinuationRead(
  reports: SpecialistReport[],
  setup: TradingSetup
): string {
  const regime = reportById(reports, 'regime')
  const momentum = reportById(reports, 'momentum')
  const smc = reportById(reports, 'smc')
  const pattern = reportById(reports, 'pattern')

  const regimeSit = regime?.situation ?? regime?.headline ?? ''
  const stall =
    /reversal|stalling|bounce|coiling|compression|range/i.test(regimeSit) ||
    regime?.verdict === 'NEUTRAL'
  const trendDown =
    setup.bias === 'SELL' ||
    regime?.verdict === 'BEARISH' ||
    momentum?.verdict === 'BEARISH'
  const trendUp =
    setup.bias === 'BUY' ||
    regime?.verdict === 'BULLISH' ||
    momentum?.verdict === 'BULLISH'

  if (stall && trendDown) {
    return '**Reversal vs continuation:** Downtrend is mature - price may be stalling (oversold / compression). A bounce is possible, but **continuation lower** remains the base case until you see CHoCH + sweep + rejection on your timeframe.'
  }
  if (stall && trendUp) {
    return '**Reversal vs continuation:** Uptrend is extended - watch for stall / pullback. **Continuation higher** needs a clean retest; reversal needs sweep + close back below structure.'
  }
  if (smc?.headline && /sweep|choch|liquidity|trap/i.test(smc.headline)) {
    return `**Reversal vs continuation:** Smart-money read - ${smc.situation ?? smc.headline}. Treat as **reversal watch** only if rejection confirms; otherwise assume continuation.`
  }
  if (pattern?.headline) {
    return `**Structure:** ${pattern.situation ?? pattern.headline}. Bias **${setup.bias}** (${setup.confluenceScore}/100) - trade with trend unless reversal criteria above are met.`
  }
  if (trendDown) {
    return '**Reversal vs continuation:** Structure still **bearish** - favor **continuation** or sell-the-rally setups; counter-trend longs need explicit CHoCH + sweep + rejection.'
  }
  if (trendUp) {
    return '**Reversal vs continuation:** Structure **bullish** - favor **continuation** or buy-the-dip; shorts need breakdown + retest failure.'
  }
  return `**Outlook:** Mixed structure - bias **${setup.bias}** at ${setup.confluenceScore}/100. Wait for a clear break or reversal signature before committing size.`
}

/** True when we can return a full answer from pipeline + scouts without the main LLM loop. */
export function canSynthesizePipelineWithoutLlm(
  pipeline: PipelineResult,
  plan: AgentPlan
): boolean {
  if (pipeline.setup.confluenceScore < 30) return false
  return (
    plan.intent === 'setup' ||
    plan.intent === 'reversal' ||
    plan.intent === 'goal' ||
    plan.taskTags.includes('levels') ||
    plan.taskTags.includes('entry_timing') ||
    plan.taskTags.includes('reversal')
  )
}

/**
 * Question-aware synthesis - routes to the right reply shape (no one-size-fits-all dump).
 */
export function buildPipelineSynthesisResponse(
  pipeline: PipelineResult,
  opts: {
    symbolLabel: string
    resolution?: string
    grounding: LiveGrounding
    plan: AgentPlan
    subAgentBriefs?: SubAgentBrief[]
    userMessage?: string
  }
): MarketChatResponse {
  const msg = opts.userMessage?.trim() ?? ''
  if (isDirectLevelsQuestion(msg)) {
    return buildPipelineLevelsChatResponse(pipeline, {
      symbolLabel: opts.symbolLabel,
      resolution: opts.resolution,
      grounding: opts.grounding,
      userMessage: msg,
    })
  }
  return buildPipelineAnalysisChatResponse(pipeline, opts)
}

/**
 * Setup / reversal answers when the user did NOT ask a direct levels-only question.
 */
export function buildPipelineAnalysisChatResponse(
  pipeline: PipelineResult,
  opts: {
    symbolLabel: string
    resolution?: string
    grounding: LiveGrounding
    plan: AgentPlan
    subAgentBriefs?: SubAgentBrief[]
    userMessage?: string
  }
): MarketChatResponse {
  const ps = pipeline.setup
  const tf = ps.timeframe || resolutionToTimeframe(opts.resolution)
  const setup = baseChatSetup(ps, tf, pipeline.reports)
  const levels = levelsFromPipeline(ps)
  const quote = opts.grounding.quote
  const events = reportById(pipeline.reports, 'events')
  const isReversalQ =
    opts.plan.intent === 'reversal' || opts.plan.taskTags.includes('reversal')
  const wantsNews = wantsNewsInReply(opts.plan.intent, opts.userMessage)

  const replyParts: string[] = []
  const priceLine = quote
    ? `**${opts.symbolLabel}** at **${quote.price}** (${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%) · **${setup.bias}** · ${ps.confluenceScore}/100 confluence.`
    : `**${opts.symbolLabel}** · **${setup.bias}** · ${ps.confluenceScore}/100 confluence.`

  if (isReversalQ) {
    replyParts.push(`### ${opts.symbolLabel} - reversal or continuation?`, '', priceLine, '')
    replyParts.push(buildReversalContinuationRead(pipeline.reports, ps))
    if (events?.blockers?.length) {
      replyParts.push('', `**Event risk:** ${events.blockers.slice(0, 2).join(' · ')}`)
    }
    const plan = shortPlanLine(ps, pipeline.reports)
    if (plan) replyParts.push('', plan)
  } else {
    replyParts.push(`### ${opts.symbolLabel} - setup`, '', priceLine)
    const plan = shortPlanLine(ps, pipeline.reports)
    if (plan) replyParts.push('', plan)
    if (setup.entry != null) {
      replyParts.push('', 'Entry, stop, and target are in the table below.')
      if (ps.riskRewardRatio != null) {
        replyParts.push(`R:R ≈ **${ps.riskRewardRatio.toFixed(1)}**.`)
      }
    } else if (ps.blockers.length > 0) {
      replyParts.push('', `**WAIT** - ${ps.blockers.slice(0, 2).join(' · ')}`)
    }

    if (wantsNews) {
      const evidence = renderUserEvidenceSummary({
        briefs: opts.subAgentBriefs,
        pipeline,
        intent: opts.plan.intent,
        userMessage: opts.userMessage,
      })
      if (evidence.trim()) replyParts.push('', evidence)
    } else {
      const signals = pipeline.reports
        .filter((r) => r.situation || r.headline)
        .slice(0, 2)
        .map((r) => `- ${r.situation ?? r.headline}`)
      if (signals.length) {
        replyParts.push('', '**Key read:**', ...signals)
      }
    }
  }

  return {
    reply: sanitizePublicReply(replyParts.filter(Boolean).join('\n')),
    setup,
    levels,
    zones: [],
    drawIntent: setup.entry != null && setup.bias !== 'WAIT',
  }
}
