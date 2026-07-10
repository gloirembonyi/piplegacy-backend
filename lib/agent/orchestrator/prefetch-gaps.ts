/**
 * Gap-fill prefetch - runs recommended tools the sub-agents skipped,
 * before the main LLM loop (claw-code-parity "prefetch then synthesize" pattern).
 */

import { getToolByName } from '@/lib/ai-tools/registry'
import { buildTradingSearchQuery } from '@/lib/ai-tools/web-search'
import type { ToolContext, ToolTraceEntry } from '@/lib/ai-tools/types'
import type { AgentPlan } from './types'

const SKIP_AUTO_PREFETCH = new Set([
  'chart_mcp_draw_setup',
  'chart_mcp_clear',
  'tradingview_draw_setup',
  'tradingview_sync_chart',
  'search_symbols',
  'resolve_symbol',
  'run_specialist_confluence',
  'agent_create_background_task',
  'agent_get_background_task',
  'agent_list_background_tasks',
  'agent_todo_write',
  'agent_ask_user',
  'agent_load_skill',
])

const MAX_GAP_PREFETCH = 5

function gapBudgetForPlan(plan: AgentPlan): number {
  if (plan.intent === 'general') return 3
  if (plan.intent === 'setup' || plan.intent === 'reversal' || plan.intent === 'goal') return 5
  if (plan.taskTags.includes('levels') || plan.taskTags.includes('candle_trigger')) return 4
  if (plan.intent === 'research' || plan.intent === 'macro') return 3
  return 3
}

function searchIntentForPlan(plan: AgentPlan): 'setup' | 'research' | 'macro' | 'general' {
  if (plan.intent === 'macro') return 'macro'
  if (plan.intent === 'research') return 'research'
  if (plan.intent === 'general') return 'general'
  return 'setup'
}

export type GapPrefetchInput = {
  symbol?: string
  symbolLabel?: string
  resolution?: string
  message: string
  mode: 'chart' | 'insights'
}

function buildToolArgs(
  toolName: string,
  input: GapPrefetchInput,
  plan: AgentPlan
): Record<string, unknown> | null {
  const { symbol, resolution, message, symbolLabel } = input

  switch (toolName) {
    case 'get_technical_analysis':
      return symbol ? { symbol } : null
    case 'get_intraday_candles':
      return symbol ? { symbol, resolution: resolution ?? '60' } : null
    case 'get_volume_profile':
      return symbol ? { symbol, resolution: resolution ?? '60' } : null
    case 'get_deep_market_data':
      return symbol ? { symbol, resolution: resolution ?? '60' } : null
    case 'get_orderbook_depth':
      return symbol ? { symbol } : null
    case 'get_metals_deep_market':
      return symbol ? { symbol } : null
    case 'get_crypto_fear_greed':
      return {}
    case 'search_web':
    case 'search_internet':
      return {
        query: buildTradingSearchQuery({
          message,
          symbol,
          symbolLabel,
          intent: searchIntentForPlan(plan),
        }),
        limit: 5,
      }
    case 'search_news':
      return { query: message.slice(0, 120) || symbol || 'markets', limit: 6 }
    case 'get_market_news':
      return { limit: 8 }
    case 'get_economic_calendar':
      return { daysAhead: 7, highImpactOnly: true }
    case 'get_quotes_batch':
      return { symbols: ['SPY', 'DXY', 'XAUUSD', 'BTCUSD'] }
    case 'get_global_market_snapshot':
      return { include_crypto: true }
    case 'research_catalysts':
      return symbol || message.trim()
        ? {
            ...(symbol ? { symbol } : {}),
            theme: message.slice(0, 80),
            horizonDays: 14,
          }
        : null
    case 'chart_mcp_status':
      return input.mode === 'chart' ? {} : null
    default:
      return null
  }
}

export async function prefetchRecommendedGaps(
  plan: AgentPlan,
  existingTrace: ToolTraceEntry[],
  input: GapPrefetchInput,
  ctx: ToolContext,
  opts?: { skipTools?: Set<string> }
): Promise<{ trace: ToolTraceEntry[]; summary: string }> {
  const skip = opts?.skipTools ?? new Set<string>()
  const executed = new Set(existingTrace.map((t) => t.tool))
  const gaps = plan.recommendedTools.filter(
    (t) => !executed.has(t) && !SKIP_AUTO_PREFETCH.has(t) && !skip.has(t)
  )

  const mandatory: string[] = []
  if (
    plan.intent === 'setup' ||
    plan.intent === 'reversal' ||
    plan.taskTags.includes('macro_risk')
  ) {
    for (const t of ['get_economic_calendar', 'search_news', 'get_market_news']) {
      if (!executed.has(t) && !skip.has(t) && !gaps.includes(t)) mandatory.push(t)
    }
  }

  const ordered = [...new Set([...mandatory, ...gaps])]

  if (gaps.length === 0 && mandatory.length === 0) {
    return { trace: [], summary: '' }
  }

  const toRun = ordered.slice(0, gapBudgetForPlan(plan))
  const startLen = ctx.trace.length

  await Promise.all(
    toRun.map(async (toolName) => {
      const tool = getToolByName(toolName)
      const args = buildToolArgs(toolName, input, plan)
      if (!tool || !args) return
      try {
        await tool.execute(args, ctx)
      } catch {
        /* trace entry may still be pushed by timed() wrapper */
      }
    })
  )

  const newEntries = ctx.trace.slice(startLen)
  if (newEntries.length === 0) {
    return { trace: [], summary: '' }
  }

  const summary = `Gap-fill prefetch: ${newEntries.map((e) => `${e.tool}${e.ok ? '' : ' (failed)'}`).join(', ')}`
  return { trace: newEntries, summary }
}
