/**
 * Tool allowlist for the main agent loop (claw-code-parity: role-based tool sets).
 */

import type { AgentPlan } from './types'

/** Always available when tools are allowed - lightweight + internet MCP surface. */
export const CORE_AGENT_TOOLS = [
  'get_quote',
  'get_quotes_batch',
  'get_global_market_snapshot',
  'get_market_sessions',
  'search_symbols',
  'resolve_symbol',
] as const

/** Internet / research MCP-style tools. */
export const INTERNET_AGENT_TOOLS = [
  'search_web',
  'search_internet',
  'search_news',
  'fetch_web_page',
  'research_catalysts',
  'get_company_news',
  'get_market_news',
] as const

export const CRYPTO_AGENT_TOOLS = [
  'get_crypto_quote',
  'get_crypto_global',
  'get_crypto_movers',
  'get_crypto_fear_greed',
  'get_orderbook_depth',
] as const

export const CHART_AGENT_TOOLS = [
  'chart_mcp_get_state',
  'chart_mcp_status',
  'chart_mcp_draw_setup',
  'chart_mcp_clear',
] as const

export const TRADINGVIEW_AGENT_TOOLS = [
  'tradingview_health_check',
  'tradingview_sync_chart',
  'tradingview_draw_setup',
  'tradingview_clear_drawings',
] as const

/** Harness tools (claw-code-parity). */
export const META_AGENT_TOOLS = [
  'agent_todo_write',
  'agent_ask_user',
  'agent_search_tools',
  'agent_load_skill',
  'agent_create_background_task',
  'agent_get_background_task',
  'agent_list_background_tasks',
  'run_specialist_confluence',
] as const

export function buildAllowedTools(
  plan: AgentPlan,
  mode: 'chart' | 'insights'
): string[] {
  if (!plan.allowToolCalls) return []

  const set = new Set<string>([
    ...CORE_AGENT_TOOLS,
    ...INTERNET_AGENT_TOOLS,
    ...META_AGENT_TOOLS,
    ...plan.recommendedTools,
  ])

  if (mode === 'chart') {
    for (const t of CHART_AGENT_TOOLS) set.add(t)
    for (const t of TRADINGVIEW_AGENT_TOOLS) set.add(t)
  } else {
    set.add('chart_mcp_status')
  }

  const wantsCrypto = plan.recommendedTools.some((t) =>
    /crypto|orderbook|fear_greed/i.test(t)
  )
  if (
    wantsCrypto ||
    plan.intent === 'research' ||
    plan.taskTags.includes('web_research')
  ) {
    for (const t of CRYPTO_AGENT_TOOLS) set.add(t)
  }

  if (
    plan.intent === 'setup' ||
    plan.intent === 'reversal' ||
    plan.taskTags.includes('levels') ||
    plan.recommendedTools.includes('get_metals_deep_market')
  ) {
    set.add('get_deep_market_data')
    set.add('get_metals_deep_market')
    set.add('get_volume_profile')
    set.add('get_orderbook_depth')
  }

  if (
    plan.taskTags.includes('confluence_scan') ||
    plan.recommendedTools.includes('run_specialist_confluence')
  ) {
    set.add('run_specialist_confluence')
  }

  return [...set]
}
