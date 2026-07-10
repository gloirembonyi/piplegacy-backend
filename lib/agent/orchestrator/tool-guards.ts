/**
 * Pre-tool middleware (claw-code-parity hooks pattern) - deny / rewrite before execution.
 */

import type { ToolTraceEntry } from '@/lib/ai-tools/types'
import type { LiveGrounding } from '@/lib/agent/live-grounding'
import { PIPELINE_COVERED_TOOLS } from '@/lib/agent/orchestrator/pipeline-bridge'
import type { AgentPlan } from './types'

export type ToolGuardInput = {
  name: string
  args: Record<string, unknown>
  plan: AgentPlan
  grounding: LiveGrounding
  trace?: ToolTraceEntry[]
}

export type ToolGuardResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }

const DRAW_TOOLS = new Set(['chart_mcp_draw_setup', 'tradingview_draw_setup'])

/** Tools that should not be called twice in one agent turn when the first call succeeded. */
const DEDUPE_TOOLS = new Set([
  ...PIPELINE_COVERED_TOOLS,
  'get_technical_analysis',
  'get_intraday_candles',
  'get_deep_market_data',
  'get_volume_profile',
  'get_metals_deep_market',
  'get_orderbook_depth',
  'get_market_news',
  'get_economic_calendar',
  'get_market_sessions',
  'search_web',
  'search_internet',
  'search_news',
  'research_catalysts',
  'get_quote',
  'get_crypto_fear_greed',
  'run_specialist_confluence',
])

export function guardToolCall(input: ToolGuardInput): ToolGuardResult {
  const { name, args, plan, grounding, trace } = input

  if (!plan.allowToolCalls) {
    return { ok: false, error: 'Tools are disabled for this turn (conversational / security mode).' }
  }

  if (plan.allowedTools.length > 0 && !plan.allowedTools.includes(name)) {
    return {
      ok: false,
      error: `Tool "${name}" is not allowed for this question. Use allowed tools only.`,
    }
  }

  if (trace && DEDUPE_TOOLS.has(name)) {
    const prior = trace.find((t) => t.tool === name && t.ok)
    if (prior) {
      return {
        ok: false,
        error: `"${name}" already succeeded this turn - use evidence in context (summary: ${prior.summary?.slice(0, 80) ?? 'ok'}).`,
      }
    }
  }

  if (grounding.newsBlackout && DRAW_TOOLS.has(name)) {
    return {
      ok: false,
      error:
        'High-impact news window - chart drawings blocked until after the event. Return WAIT setup in JSON instead.',
    }
  }

  if (
    grounding.marketStatusForSymbol &&
    !grounding.marketStatusForSymbol.isOpen &&
    DRAW_TOOLS.has(name) &&
    args.entryType === 'market'
  ) {
    return {
      ok: false,
      error:
        'Market is closed - use LIMIT/WAIT in JSON; do not queue a market-style chart draw until the session opens.',
    }
  }

  return { ok: true, args }
}
