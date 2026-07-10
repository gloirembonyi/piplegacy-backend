/**
 * Sub-agents - parallel data gatherers invoked by the manager before the main loop.
 * Tool selection is driven by the manager plan (task tags + recommendedTools),
 * not a fixed static batch.
 */

import { getToolByName, makeToolContext } from '@/lib/ai-tools/registry'
import { buildNewsSearchQuery, buildTradingSearchQuery } from '@/lib/ai-tools/web-search'
import type { ToolTraceEntry } from '@/lib/ai-tools/types'
import { recordAgentRun, recordToolCall } from '@/lib/tool-usage-tracker'
import { fetchSpecialistCandles } from '@/lib/agent/specialists/candles'
import { analyzeSmcFromBars, type SmcAnalysisResult } from '@/lib/agent/specialists/smc'
import { optimalSmcResolutions } from '@/lib/agent/orchestrator/timeframe-policy'
import { isCryptoSymbol, planAgentTask, toolsForSubAgent } from './planner'
import { isOffChartGeneralKnowledge } from './question-understanding'
import { summarizeSubAgentWithGemini } from './sub-agent-summarize'
import type { AgentPlan, OrchestratorInput, SubAgentBrief, SubAgentId } from './types'

function isMetalSymbol(symbol?: string): boolean {
  if (!symbol) return false
  return /XAU|XAG|GOLD|SILVER/i.test(symbol)
}

function summarizeSetup(data: Record<string, unknown>, trace: ToolTraceEntry[]): string {
  const ta = data.technical as {
    trend?: string
    rsi14?: number
    swingHigh20?: number
    swingLow20?: number
    available?: boolean
    error?: string
  } | null
  const vp = data.volumeProfile as { pocPrice?: number; available?: boolean } | null
  const dm = data.deepMarket as {
    volumeAnalysis?: { poc?: number }
    pendingOrdersProxy?: { imbalanceLabel?: string }
    orderTiming?: { bestFillWindow?: string }
  } | null
  const candles = data.intraday as { barsReturned?: number; count?: number } | null
  const sessions = data.sessions as {
    activeSessions?: string[]
    liquidity?: string
    nextSession?: { name?: string; opensIn?: string } | null
  } | null
  const calendar = data.calendar as { count?: number } | null

  const parts: string[] = ['Setup scout:']
  if (sessions?.activeSessions?.length) {
    parts.push(`${sessions.activeSessions.join('+')} open`)
    if (sessions.liquidity) parts.push(`liquidity=${sessions.liquidity}`)
    if (sessions.nextSession?.opensIn) parts.push(`next ${sessions.nextSession.opensIn}`)
  }
  if (calendar?.count != null) parts.push(`calendar ${calendar.count} events`)
  if (ta?.trend) parts.push(`trend=${ta.trend}`)
  if (ta?.rsi14 != null) parts.push(`RSI=${ta.rsi14.toFixed(1)}`)
  if (ta?.swingHigh20 != null) parts.push(`swingH=${ta.swingHigh20.toFixed(2)}`)
  if (ta?.swingLow20 != null) parts.push(`swingL=${ta.swingLow20.toFixed(2)}`)
  if (vp?.pocPrice != null) parts.push(`POC=${vp.pocPrice.toFixed(2)}`)
  if (dm?.volumeAnalysis?.poc != null) parts.push(`deep POC=${dm.volumeAnalysis.poc.toFixed(2)}`)
  if (dm?.pendingOrdersProxy?.imbalanceLabel) parts.push(dm.pendingOrdersProxy.imbalanceLabel)
  if (dm?.orderTiming?.bestFillWindow) parts.push(`fill: ${dm.orderTiming.bestFillWindow.slice(0, 40)}`)
  const barCount = candles?.barsReturned ?? candles?.count
  if (barCount != null) parts.push(`${barCount} bars`)

  if (parts.length > 1) return parts.join(' · ')

  const okTools = trace.filter((t) => t.ok).map((t) => t.summary).filter(Boolean)
  if (okTools.length) return `Setup scout: ${okTools.slice(0, 2).join(' · ')}`

  const err = trace.find((t) => !t.ok)?.error ?? ta?.error
  if (err) return `Setup scout: ${err}`

  return 'Setup scout: no structure data'
}

function subAgentSucceeded(trace: ToolTraceEntry[], data: Record<string, unknown>): boolean {
  if (trace.some((t) => t.ok)) return true
  return Object.values(data).some(
    (v) => v && typeof v === 'object' && !('error' in (v as object))
  )
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ReturnType<typeof makeToolContext>
): Promise<Record<string, unknown> | null> {
  const tool = getToolByName(name)
  if (!tool) return null
  const start = Date.now()
  const traceBefore = ctx.trace.length
  try {
    const result = await tool.execute(args, ctx)
    const pushed = ctx.trace.length > traceBefore
    if (!pushed) {
      const ok = !(result && typeof result === 'object' && 'error' in result)
      ctx.trace.push({
        tool: name,
        args,
        ok,
        durationMs: Date.now() - start,
        error: ok ? undefined : String((result as { error?: unknown }).error ?? 'failed'),
        summary: ok ? undefined : String((result as { error?: unknown }).error ?? 'failed'),
      })
      void recordToolCall(name, ok)
    }
    if (result && typeof result === 'object') return result as Record<string, unknown>
    return { value: result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.trace.push({
      tool: name,
      args,
      ok: false,
      durationMs: Date.now() - start,
      error: msg,
    })
    void recordToolCall(name, false)
    return { error: msg }
  }
}

function buildSetupToolArgs(
  toolName: string,
  symbol: string,
  resolution: string,
  mode: OrchestratorInput['mode']
): Record<string, unknown> | null {
  switch (toolName) {
    case 'get_technical_analysis':
      return { symbol, resolution: 'D' }
    case 'get_intraday_candles':
      return { symbol, resolution }
    case 'get_volume_profile':
      return { symbol, resolution }
    case 'get_deep_market_data':
      return { symbol, resolution }
    case 'get_orderbook_depth':
      return { symbol }
    case 'get_metals_deep_market':
      return { symbol }
    case 'get_crypto_fear_greed':
      return {}
    case 'get_economic_calendar':
      return { daysAhead: 7, highImpactOnly: true }
    case 'chart_mcp_status':
      return mode === 'chart' ? {} : null
    default:
      return null
  }
}

async function runSetupSubAgent(
  input: OrchestratorInput,
  plan: AgentPlan
): Promise<{ brief: SubAgentBrief; trace: ToolTraceEntry[] }> {
  const start = Date.now()
  const symbol = input.symbol?.trim() ?? ''
  const resolution = input.resolution ?? '60'
  const ctx = makeToolContext({ defaultSymbol: symbol, defaultResolution: resolution })

  const data: Record<string, unknown> = {}

  if (!symbol) {
    const [sessions, calendar] = await Promise.all([
      runTool('get_market_sessions', {}, ctx),
      runTool('get_economic_calendar', { daysAhead: 7, highImpactOnly: true }, ctx),
    ])
    data.sessions = sessions
    data.calendar = calendar

    const fallbackSummary = summarizeSetup(data, ctx.trace)
    const summary = await summarizeSubAgentWithGemini({
      agentId: 'setup',
      data,
      trace: ctx.trace,
      userMessage: input.message,
      symbolLabel: input.symbolLabel ?? symbol,
      fallback: fallbackSummary,
    })

    return {
      brief: {
        id: 'setup',
        ok: subAgentSucceeded(ctx.trace, data),
        durationMs: Date.now() - start,
        summary,
        data,
      },
      trace: ctx.trace,
    }
  }

  let toolNames = toolsForSubAgent('setup', plan)
  if (plan.taskTags.includes('levels')) {
    toolNames = ['get_technical_analysis', 'get_intraday_candles', 'get_quote']
  } else if (toolNames.length === 0) {
    toolNames = ['get_technical_analysis', 'get_intraday_candles', 'get_deep_market_data']
    if (isCryptoSymbol(symbol)) toolNames.push('get_crypto_fear_greed')
    if (input.mode === 'chart') toolNames.push('chart_mcp_status')
  }

  const tasks = toolNames
    .filter((t) => t !== 'chart_mcp_draw_setup')
    .map((name) => {
      const args = buildSetupToolArgs(name, symbol, resolution, input.mode)
      return args ? runTool(name, args, ctx) : Promise.resolve(null)
    })

  const settled = await Promise.all(tasks)

  toolNames
    .filter((t) => t !== 'chart_mcp_draw_setup')
    .forEach((name, i) => {
      const key =
        name === 'get_technical_analysis'
          ? 'technical'
          : name === 'get_intraday_candles'
            ? 'intraday'
            : name === 'get_volume_profile'
              ? 'volumeProfile'
              : name === 'get_deep_market_data'
                ? 'deepMarket'
                : name === 'get_orderbook_depth'
                ? 'orderbook'
                : name === 'get_metals_deep_market'
                  ? 'metalsDeep'
                  : name === 'chart_mcp_status'
                    ? 'chartStatus'
                    : name.replace(/^get_/, '')
      data[key] = settled[i]
    })

  const fallbackSetup = summarizeSetup(data, ctx.trace)
  const summary = await summarizeSubAgentWithGemini({
    agentId: 'setup',
    data,
    trace: ctx.trace,
    userMessage: input.message,
    symbolLabel: input.symbolLabel ?? symbol,
    fallback: fallbackSetup,
  })

  return {
    brief: {
      id: 'setup',
      ok: subAgentSucceeded(ctx.trace, data),
      durationMs: Date.now() - start,
      summary,
      data,
    },
    trace: ctx.trace,
  }
}

async function runResearchSubAgent(
  input: OrchestratorInput,
  plan: AgentPlan
): Promise<{ brief: SubAgentBrief; trace: ToolTraceEntry[] }> {
  const start = Date.now()
  const symbol = input.symbol ?? ''
  const ctx = makeToolContext({ defaultSymbol: input.symbol, defaultResolution: input.resolution })

  const isGeneral =
    plan.intent === 'general' ||
    isOffChartGeneralKnowledge(input.message, plan.intent, {
      symbol: input.symbol,
      mode: input.mode,
    })

  if (isGeneral) {
    const query = input.message.trim().slice(0, 160)
    const internet = await runTool('search_internet', { query, limit: 6 }, ctx)
    const internetCount = (internet as { count?: number } | null)?.count ?? 0
    const data = { internet, web: null, news: null, query }
    const fallback = `Research scout: 1 web search · ${internetCount} hits`
    const summary = await summarizeSubAgentWithGemini({
      agentId: 'research',
      data,
      trace: ctx.trace,
      userMessage: input.message,
      symbolLabel: input.symbolLabel ?? symbol,
      fallback,
    })
    return {
      brief: {
        id: 'research',
        ok: internetCount > 0,
        durationMs: Date.now() - start,
        summary,
        data,
      },
      trace: ctx.trace,
    }
  }

  const planned = toolsForSubAgent('research', plan)
  const isMarketNewsQ = /moving|news|today|headline|catalyst|what'?s happening/i.test(
    input.message
  )
  const runInternet =
    !isMarketNewsQ &&
    (planned.length === 0 || planned.includes('search_internet') || plan.intent === 'general')
  const runWeb =
    planned.includes('search_web') ||
    planned.includes('search_internet') ||
    (planned.length === 0 && !isMarketNewsQ && plan.intent !== 'general')
  const runNews =
    planned.includes('search_news') ||
    isMarketNewsQ ||
    (planned.length === 0 && plan.intent === 'macro')
  const runCatalysts = planned.includes('research_catalysts')
  const runTa =
    planned.includes('get_technical_analysis') ||
    (symbol && planned.length === 0 && plan.intent !== 'general')

  const searchIntent =
    plan.intent === 'general' ? ('general' as const) : ('research' as const)
  const query = buildTradingSearchQuery({
    message: input.message,
    symbol: input.symbol,
    symbolLabel: input.symbolLabel,
    intent: searchIntent,
  })
  const newsQuery = buildNewsSearchQuery(
    plan.intent === 'general'
      ? buildTradingSearchQuery({
          message: input.message,
          symbol: input.symbol,
          symbolLabel: input.symbolLabel,
          intent: 'general',
        })
      : buildTradingSearchQuery({
          message: input.message,
          symbol: input.symbol,
          symbolLabel: input.symbolLabel,
          intent: 'catalyst',
        }),
    input.message
  )

  const tasks: Array<Promise<Record<string, unknown> | null>> = []
  if (runInternet) tasks.push(runTool('search_internet', { query, limit: 8 }, ctx))
  if (runWeb) tasks.push(runTool('search_web', { query, limit: 8 }, ctx))
  if (runNews) tasks.push(runTool('search_news', { query: newsQuery, limit: 6 }, ctx))
  if (runCatalysts && (symbol || input.message.trim())) {
    tasks.push(
      runTool(
        'research_catalysts',
        {
          ...(symbol ? { symbol } : {}),
          theme: input.message.slice(0, 80),
          horizonDays: 14,
        },
        ctx
      )
    )
  }
  if (runTa && symbol) {
    tasks.push(runTool('get_technical_analysis', { symbol, resolution: 'D' }, ctx))
    if (isMetalSymbol(symbol) && (planned.length === 0 || planned.includes('get_metals_deep_market'))) {
      tasks.push(runTool('get_metals_deep_market', { symbol }, ctx))
    }
  }

  const settled = await Promise.all(tasks)
  let idx = 0
  const internet = runInternet ? settled[idx++] : null
  const web = runWeb ? settled[idx++] : null
  const news = runNews ? settled[idx++] : null
  const catalysts = runCatalysts ? settled[idx++] : null
  const technical = runTa && symbol ? settled[idx++] : null

  const internetCount = (internet as { count?: number } | null)?.count ?? 0
  const webCount = (web as { count?: number } | null)?.count ?? 0
  const newsCount = (news as { count?: number } | null)?.count ?? 0
  const provider =
    (internet as { searchProvider?: string } | null)?.searchProvider ??
    (web as { searchProvider?: string } | null)?.searchProvider ??
    'web'

  const catalystOk =
    Boolean(catalysts && typeof catalysts === 'object' && !('error' in catalysts))
  const technicalOk =
    Boolean(technical && typeof technical === 'object' && !('error' in technical))

  const data = { internet, web, news, catalysts, technical, query, newsQuery }
  const fallback = `Research scout: ${provider} ${internetCount + webCount} hits · news ${newsCount}${technical ? ' · TA' : ''}`
  const summary = await summarizeSubAgentWithGemini({
    agentId: 'research',
    data,
    trace: ctx.trace,
    userMessage: input.message,
    symbolLabel: input.symbolLabel ?? symbol,
    fallback,
  })

  return {
    brief: {
      id: 'research',
      ok: internetCount + webCount + newsCount > 0 || catalystOk || technicalOk,
      durationMs: Date.now() - start,
      summary,
      data,
    },
    trace: ctx.trace,
  }
}

async function runMacroSubAgent(
  input: OrchestratorInput,
  plan: AgentPlan
): Promise<{ brief: SubAgentBrief; trace: ToolTraceEntry[] }> {
  const start = Date.now()
  const ctx = makeToolContext({ defaultSymbol: input.symbol, defaultResolution: input.resolution })
  const macroQuery = buildTradingSearchQuery({
    message: input.message,
    symbol: input.symbol,
    symbolLabel: input.symbolLabel,
    intent: 'macro',
  })

  const planned = toolsForSubAgent('macro', plan)
  const tasks: Array<Promise<Record<string, unknown> | null>> = []

  if (planned.length === 0 || planned.includes('get_market_sessions')) {
    tasks.push(runTool('get_market_sessions', {}, ctx))
  }
  if (planned.length === 0 || planned.includes('get_market_news')) {
    tasks.push(runTool('get_market_news', { limit: 8 }, ctx))
  }
  if (planned.length === 0 || planned.includes('get_economic_calendar')) {
    tasks.push(runTool('get_economic_calendar', { daysAhead: 7, highImpactOnly: true }, ctx))
  }
  if (planned.length === 0 || planned.includes('get_quotes_batch')) {
    tasks.push(
      runTool('get_quotes_batch', { symbols: ['SPY', 'DXY', 'XAUUSD', 'BTCUSD'].filter(Boolean) }, ctx)
    )
  }
  if (planned.length === 0 || planned.includes('search_web')) {
    tasks.push(runTool('search_web', { query: macroQuery, limit: 4 }, ctx))
  }

  const settled = await Promise.all(tasks)
  const sessions =
    settled.find((r) => r && typeof r === 'object' && 'activeSessions' in r) ?? null
  const marketNews =
    settled.find((r) => r && typeof r === 'object' && ('news' in r || 'articles' in r)) ?? null
  const calendar =
    settled.find((r) => r && typeof r === 'object' && 'events' in r) ?? null
  const web = settled.find((r) => r && typeof r === 'object' && 'count' in r && !('events' in r)) ?? null

  const calCount = (calendar as { count?: number } | null)?.count ?? 0
  const webCount = (web as { count?: number } | null)?.count ?? 0
  const sessionCount = (sessions as { activeSessions?: string[] } | null)?.activeSessions?.length ?? 0

  const data = { sessions, marketNews, calendar, web, macroQuery }
  const fallback = `Macro scout: ${sessionCount} sessions · calendar ${calCount} events · web ${webCount} hits`
  const summary = await summarizeSubAgentWithGemini({
    agentId: 'macro',
    data,
    trace: ctx.trace,
    userMessage: input.message,
    symbolLabel: input.symbolLabel ?? input.symbol,
    fallback,
  })

  return {
    brief: {
      id: 'macro',
      ok: subAgentSucceeded(ctx.trace, data),
      durationMs: Date.now() - start,
      summary,
      data,
    },
    trace: ctx.trace,
  }
}

async function runDiscoverySubAgent(
  input: OrchestratorInput,
  plan: AgentPlan
): Promise<{ brief: SubAgentBrief; trace: ToolTraceEntry[] }> {
  const start = Date.now()
  const ctx = makeToolContext({ defaultSymbol: input.symbol, defaultResolution: input.resolution })
  const query = input.message.slice(0, 120)

  const planned = toolsForSubAgent('discovery', plan)
  const tasks: Array<Promise<Record<string, unknown> | null>> = []

  if (planned.length === 0 || planned.includes('search_symbols')) {
    tasks.push(runTool('search_symbols', { query }, ctx))
  }
  if (planned.length === 0 || planned.includes('resolve_symbol')) {
    tasks.push(runTool('resolve_symbol', { symbol: query.slice(0, 40) }, ctx))
  }
  if (planned.length === 0 || planned.includes('search_web')) {
    tasks.push(runTool('search_web', { query, limit: 6 }, ctx))
  }
  if (planned.includes('get_quotes_batch')) {
    tasks.push(runTool('get_quotes_batch', { symbols: ['SPY', 'EURUSD', 'BTCUSD'] }, ctx))
  }

  const settled = await Promise.all(tasks)
  const symbols = settled.find((r) => r && 'results' in r) ?? settled[0]
  const resolved = settled.find((r) => r && 'symbol' in r && !('results' in r))
  const web = settled.find((r) => r && 'count' in r)

  const symCount = (symbols as { results?: unknown[]; count?: number } | null)?.results?.length ??
    (symbols as { count?: number } | null)?.count ?? 0
  const webCount = (web as { count?: number } | null)?.count ?? 0

  return {
    brief: {
      id: 'discovery',
      ok: subAgentSucceeded(ctx.trace, { symbols, resolved, web }),
      durationMs: Date.now() - start,
      summary: `Discovery scout: ${symCount} symbols · web ${webCount} hits`,
      data: { symbols, resolved, web, query },
    },
    trace: ctx.trace,
  }
}

async function runVerificationSubAgent(
  input: OrchestratorInput,
  plan: AgentPlan
): Promise<{ brief: SubAgentBrief; trace: ToolTraceEntry[] }> {
  const start = Date.now()
  const symbol = input.symbol?.trim() ?? ''
  const ctx = makeToolContext({ defaultSymbol: symbol, defaultResolution: input.resolution ?? '60' })

  if (!symbol) {
    return {
      brief: {
        id: 'verification',
        ok: false,
        durationMs: Date.now() - start,
        summary: 'Verification scout: no symbol to verify',
        data: {},
      },
      trace: ctx.trace,
    }
  }

  const planned = toolsForSubAgent('verification', plan)
  const tasks: Array<Promise<Record<string, unknown> | null>> = []

  if (planned.length === 0 || planned.includes('get_quote')) {
    tasks.push(runTool('get_quote', { symbol }, ctx))
  }
  if (planned.length === 0 || planned.includes('get_technical_analysis')) {
    tasks.push(runTool('get_technical_analysis', { symbol, resolution: 'D' }, ctx))
  }
  if (planned.length === 0 || planned.includes('get_market_sessions')) {
    tasks.push(runTool('get_market_sessions', {}, ctx))
  }
  if (planned.includes('get_intraday_candles')) {
    tasks.push(runTool('get_intraday_candles', { symbol, resolution: input.resolution ?? '60' }, ctx))
  }
  if (planned.includes('get_economic_calendar')) {
    tasks.push(runTool('get_economic_calendar', { daysAhead: 3, highImpactOnly: true }, ctx))
  }

  const settled = await Promise.all(tasks)
  const quote = settled.find((r) => r && 'price' in r) ?? null
  const ta = settled.find((r) => r && 'trend' in r) ?? null
  const price = (quote as { price?: number } | null)?.price
  const trend = (ta as { trend?: string } | null)?.trend

  return {
    brief: {
      id: 'verification',
      ok: subAgentSucceeded(ctx.trace, { quote, ta }),
      durationMs: Date.now() - start,
      summary: `Verification scout: ${price != null ? `price ${price}` : 'no quote'}${trend ? ` · ${trend}` : ''}`,
      data: { quote, ta, settled },
    },
    trace: ctx.trace,
  }
}

async function runLiquiditySubAgent(
  input: OrchestratorInput,
  plan: AgentPlan
): Promise<{ brief: SubAgentBrief; trace: ToolTraceEntry[] }> {
  const start = Date.now()
  const symbol = input.symbol?.trim() ?? ''
  const ctx = makeToolContext({ defaultSymbol: symbol, defaultResolution: input.resolution })

  if (!symbol) {
    const sessions = await runTool('get_market_sessions', {}, ctx)
    return {
      brief: {
        id: 'liquidity',
        ok: Boolean(sessions && !('error' in sessions)),
        durationMs: Date.now() - start,
        summary: 'Liquidity scout: session timing only (no symbol)',
        data: { sessions, timeframeNote: 'Pick a symbol for structure + liquidity map' },
      },
      trace: ctx.trace,
    }
  }

  const tfPlan = optimalSmcResolutions(input.resolution)
  const minBars = tfPlan.minBars

  const [primaryCandles, htfCandles, volumeProfile, sessions, orderbook] = await Promise.all([
    fetchSpecialistCandles(symbol, tfPlan.primary, minBars),
    fetchSpecialistCandles(symbol, tfPlan.htf, Math.max(25, minBars - 5)),
    runTool('get_volume_profile', { symbol, resolution: tfPlan.primary }, ctx),
    runTool('get_market_sessions', {}, ctx),
    isCryptoSymbol(symbol)
      ? runTool('get_orderbook_depth', { symbol }, ctx)
      : Promise.resolve(null),
  ])

  const primaryAnalysis = analyzeSmcFromBars(primaryCandles.bars)
  const htfAnalysis = analyzeSmcFromBars(htfCandles.bars)

  const serializeAnalysis = (a: SmcAnalysisResult | null) =>
    a
      ? {
          verdict: a.verdict,
          confidence: a.confidence,
          headline: a.headline,
          blockers: a.blockers,
          confirmed: a.confirmed,
          speculative: a.speculative,
          liquidityPools: a.liquidityPools,
          swings: a.swings,
        }
      : null

  const data: Record<string, unknown> = {
    timeframeNote: tfPlan.note,
    primary: {
      resolution: tfPlan.primaryLabel,
      bars: primaryCandles.bars.length,
      source: primaryCandles.source,
      analysis: serializeAnalysis(primaryAnalysis),
    },
    htf: {
      resolution: tfPlan.htfLabel,
      bars: htfCandles.bars.length,
      source: htfCandles.source,
      analysis: serializeAnalysis(htfAnalysis),
    },
    volumeProfile,
    sessions,
    orderbook,
  }

  const parts: string[] = ['Liquidity scout:']
  if (primaryAnalysis) {
    parts.push(`${primaryAnalysis.verdict} ${primaryAnalysis.confidence}% @ ${tfPlan.primaryLabel}`)
    parts.push(primaryAnalysis.headline.slice(0, 80))
    if (primaryAnalysis.confirmed.length) {
      parts.push(`${primaryAnalysis.confirmed.length} confirmed`)
    }
    if (primaryAnalysis.liquidityPools.length) {
      parts.push(`${primaryAnalysis.liquidityPools.length} pools`)
    }
  } else {
    parts.push(`insufficient ${tfPlan.primaryLabel} bars (${primaryCandles.bars.length})`)
  }
  if (htfAnalysis && htfAnalysis.verdict !== primaryAnalysis?.verdict) {
    parts.push(`HTF ${htfAnalysis.verdict}`)
  }
  const vp = volumeProfile as { pocPrice?: number } | null
  if (vp?.pocPrice != null) parts.push(`POC ${vp.pocPrice.toFixed(2)}`)

  const fallbackSummary = parts.join(' · ')
  const summary = await summarizeSubAgentWithGemini({
    agentId: 'liquidity',
    data,
    trace: ctx.trace,
    userMessage: input.message,
    symbolLabel: input.symbolLabel ?? symbol,
    fallback: fallbackSummary,
  })

  return {
    brief: {
      id: 'liquidity',
      ok: Boolean(primaryAnalysis || htfAnalysis),
      durationMs: Date.now() - start,
      summary,
      data,
    },
    trace: ctx.trace,
  }
}

const RUNNERS: Record<
  SubAgentId,
  (input: OrchestratorInput, plan: AgentPlan) => Promise<{ brief: SubAgentBrief; trace: ToolTraceEntry[] }>
> = {
  setup: runSetupSubAgent,
  research: runResearchSubAgent,
  macro: runMacroSubAgent,
  discovery: runDiscoverySubAgent,
  verification: runVerificationSubAgent,
  liquidity: runLiquiditySubAgent,
}

export async function runSubAgentsParallel(
  ids: SubAgentId[],
  input: OrchestratorInput,
  plan: AgentPlan
): Promise<{ briefs: SubAgentBrief[]; trace: ToolTraceEntry[] }> {
  if (ids.length === 0) return { briefs: [], trace: [] }

  const settled = await Promise.allSettled(ids.map((id) => RUNNERS[id](input, plan)))

  const briefs: SubAgentBrief[] = []
  const trace: ToolTraceEntry[] = []

  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      briefs.push(s.value.brief)
      trace.push(...s.value.trace)
      void recordAgentRun(s.value.brief.id, s.value.brief.ok)
    } else {
      briefs.push({
        id: ids[i],
        ok: false,
        durationMs: 0,
        summary: s.reason instanceof Error ? s.reason.message : 'Sub-agent failed',
        data: {},
      })
      void recordAgentRun(ids[i], false)
    }
  })

  return { briefs, trace }
}

/** Run one sub-agent in isolation (admin playground). */
export async function runSingleSubAgent(
  id: SubAgentId,
  input: OrchestratorInput,
  plan?: AgentPlan
): Promise<{ brief: SubAgentBrief; trace: ToolTraceEntry[] }> {
  const runner = RUNNERS[id]
  if (!runner) throw new Error(`Unknown sub-agent: ${id}`)
  const effectivePlan = plan ?? planAgentTask(input)
  try {
    const result = await runner(input, effectivePlan)
    void recordAgentRun(result.brief.id, result.brief.ok)
    return result
  } catch (err) {
    void recordAgentRun(id, false)
    throw err
  }
}
