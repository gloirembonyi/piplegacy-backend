/**
 * Shared tool labels/icons + step labels for agent work UI.
 * Each tool gets a unique icon so the agent work timeline is scannable at a glance.
 */

import {
  Activity,
  BarChart3,
  Bitcoin,
  BookOpen,
  CalendarDays,
  CandlestickChart,
  ChartColumn,
  Clock,
  Coins,
  Eraser,
  HelpCircle,
  RefreshCw,
  Flame,
  Gauge,
  Globe,
  Globe2,
  Hash,
  Layers,
  Lightbulb,
  LineChart,
  Monitor,
  Newspaper,
  PenLine,
  Plug,
  Rss,
  Search,
  TrendingUp,
  Zap,
  type LucideIcon,
} from 'lucide-react'

export type ToolEventStatus = 'running' | 'ok' | 'error'

export type AgentToolEvent = {
  callId: string
  tool: string
  args?: Record<string, unknown>
  status: ToolEventStatus
  summary?: string
  error?: string
  durationMs?: number
}

const TOOL_EVENT_STATUSES: ToolEventStatus[] = ['running', 'ok', 'error']

function isToolEventStatus(value: string): value is ToolEventStatus {
  return (TOOL_EVENT_STATUSES as string[]).includes(value)
}

/** Normalize persisted tool rows (status is often plain string from JSON). */
export function coerceAgentToolEvents(
  tools:
    | Array<{
        callId: string
        tool: string
        status: string
        args?: Record<string, unknown>
        summary?: string
        error?: string
        durationMs?: number
      }>
    | undefined
): AgentToolEvent[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    callId: t.callId,
    tool: t.tool,
    args: t.args,
    status: isToolEventStatus(t.status) ? t.status : 'ok',
    summary: t.summary,
    error: t.error,
    durationMs: t.durationMs,
  }))
}

export const AGENT_TOOL_META: Record<string, { label: string; icon: LucideIcon }> = {
  get_quote: { label: 'Live quote', icon: TrendingUp },
  get_quotes_batch: { label: 'Cross-asset snapshot', icon: BarChart3 },
  get_technical_analysis: { label: 'Technical analysis', icon: Activity },
  get_intraday_candles: { label: 'Recent candles', icon: CandlestickChart },
  get_company_news: { label: 'Company news', icon: BookOpen },
  get_market_news: { label: 'Market news', icon: Newspaper },
  search_web: { label: 'Web search', icon: Globe },
  search_internet: { label: 'Internet search', icon: Globe2 },
  search_news: { label: 'News search', icon: Rss },
  fetch_web_page: { label: 'Read web page', icon: BookOpen },
  get_global_market_snapshot: { label: 'Global markets', icon: BarChart3 },
  get_economic_calendar: { label: 'Economic calendar', icon: CalendarDays },
  get_market_sessions: { label: 'Session timing', icon: Clock },
  search_symbols: { label: 'Symbol lookup', icon: Search },
  resolve_symbol: { label: 'Resolve symbol', icon: Hash },
  get_crypto_quote: { label: 'Crypto quote', icon: Bitcoin },
  get_crypto_global: { label: 'Crypto global', icon: Globe2 },
  get_crypto_movers: { label: 'Crypto movers', icon: Flame },
  get_crypto_fear_greed: { label: 'Fear & Greed', icon: Gauge },
  get_orderbook_depth: { label: 'Order-book L2', icon: Layers },
  get_deep_market_data: { label: 'Deep market data', icon: Layers },
  get_volume_profile: { label: 'Volume profile', icon: ChartColumn },
  get_metals_deep_market: { label: 'Metals deep market', icon: Coins },
  research_catalysts: { label: 'Catalyst research', icon: Lightbulb },
  chart_mcp_status: { label: 'Chart ready', icon: Monitor },
  chart_mcp_get_state: { label: 'Read chart state', icon: Monitor },
  chart_mcp_draw_setup: { label: 'Draw on chart', icon: PenLine },
  chart_mcp_clear: { label: 'Clear chart', icon: Eraser },
  tradingview_health_check: { label: 'TradingView MCP', icon: Plug },
  tradingview_sync_chart: { label: 'Sync TV chart', icon: RefreshCw },
  tradingview_draw_setup: { label: 'Draw on TradingView', icon: LineChart },
  tradingview_clear_drawings: { label: 'Clear TV drawings', icon: Eraser },
  agent_todo_write: { label: 'Agent todos', icon: Activity },
  agent_ask_user: { label: 'Ask user', icon: HelpCircle },
  agent_search_tools: { label: 'Search tools', icon: Search },
  agent_load_skill: { label: 'Load skill', icon: BookOpen },
  agent_create_background_task: { label: 'Background task', icon: Zap },
  agent_get_background_task: { label: 'Poll task', icon: RefreshCw },
  agent_list_background_tasks: { label: 'List tasks', icon: Layers },
  run_specialist_confluence: { label: 'Confluence scan', icon: Activity },
}

/** Fallback icon by tool name keyword when registry adds a new tool before meta is updated. */
const TOOL_ICON_FALLBACKS: Array<{ match: RegExp; icon: LucideIcon }> = [
  { match: /candle|intraday|ohlc/i, icon: CandlestickChart },
  { match: /calendar|economic|macro/i, icon: CalendarDays },
  { match: /news|rss/i, icon: Newspaper },
  { match: /web|search/i, icon: Globe },
  { match: /chart|draw|mcp/i, icon: LineChart },
  { match: /volume|profile/i, icon: ChartColumn },
  { match: /metal|gold|xau/i, icon: Coins },
  { match: /crypto|btc|eth/i, icon: Bitcoin },
  { match: /orderbook|depth|book/i, icon: Layers },
  { match: /session|time/i, icon: Clock },
  { match: /quote|price/i, icon: TrendingUp },
  { match: /technical|ta|analysis/i, icon: Activity },
  { match: /catalyst|research/i, icon: Lightbulb },
]

export function toolIcon(tool: string): LucideIcon {
  const direct = AGENT_TOOL_META[tool]?.icon
  if (direct) return direct
  for (const { match, icon } of TOOL_ICON_FALLBACKS) {
    if (match.test(tool)) return icon
  }
  return Zap
}

export function toolLabel(tool: string): string {
  return AGENT_TOOL_META[tool]?.label ?? tool.replace(/_/g, ' ')
}

export const SUB_AGENT_LABELS: Record<string, string> = {
  setup: 'Structure scout',
  research: 'Web scout',
  macro: 'Macro scout',
  discovery: 'Symbol scout',
  verification: 'Level check',
  liquidity: 'Liquidity map',
  'specialist:regime': 'Regime lens',
  'specialist:smc': 'Smart-money lens',
  'specialist:technical': 'Structure lens',
  'specialist:momentum': 'Momentum lens',
  'specialist:mtf': 'Multi-TF lens',
  'specialist:pattern': 'Pattern lens',
  'specialist:events': 'Events lens',
  'specialist:sentiment': 'Sentiment lens',
  'specialist:orchestrator': 'Confluence merge',
  run_specialist_confluence: 'Confluence scan',
}

export function subAgentLabel(agent: string): string {
  return SUB_AGENT_LABELS[agent] ?? agent.replace(/^specialist:/, '').replace(/_/g, ' ')
}

export const INTENT_LABELS: Record<string, string> = {
  setup: 'Trade setup',
  research: 'Market research',
  macro: 'Macro & calendar',
  discovery: 'Symbol discovery',
  reversal: 'Reversal check',
  goal: 'Personal goal + setup',
  conversational: 'Chat',
  undercover: 'Security',
  general: 'General question',
}
