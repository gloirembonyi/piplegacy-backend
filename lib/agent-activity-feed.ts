/**
 * Dynamic user-facing activity feed - built from live agent events (tools,
 * scouts, MCP) instead of a static pre-planned checklist that can appear stuck.
 */

import type { AgentSpinnerPhase } from '@/lib/agent-spinner-verbs'
import { subAgentLabel, toolLabel } from '@/lib/agent-work-ui'
import type { AgentToolEvent } from '@/lib/agent-work-ui'
import type { StepStatus } from '@/lib/agent-work-state'

export type UserActivityKind =
  | 'grounding'
  | 'plan'
  | 'sub_agent'
  | 'tool'
  | 'pipeline'
  | 'think'
  | 'reflect'
  | 'compose'
  | 'wait'

export type UserActivity = {
  id: string
  kind: UserActivityKind
  label: string
  detail?: string
  status: StepStatus
  phase: AgentSpinnerPhase
  /** ms timestamp when activity started (client-side ordering) */
  at: number
}

const WEB_TOOLS = new Set(['search_web', 'search_internet', 'search_news', 'fetch_web_page'])
const CHART_MCP_TOOLS = new Set(['chart_mcp_status', 'chart_mcp_draw_setup', 'chart_mcp_clear'])
const TV_MCP_TOOLS = new Set([
  'tradingview_health_check',
  'tradingview_sync_chart',
  'tradingview_draw_setup',
  'tradingview_clear_drawings',
])

/** User-safe label for a tool call - impressive but not overly technical. */
export function userActivityLabelForTool(tool: string, args?: Record<string, unknown>): string {
  if (WEB_TOOLS.has(tool)) {
    const q = typeof args?.query === 'string' ? args.query.trim() : ''
    if (q.length > 0 && q.length <= 48) return `Searching the web · "${q}"`
    return 'Searching the internet'
  }
  if (CHART_MCP_TOOLS.has(tool)) {
    if (tool === 'chart_mcp_draw_setup') return 'Drawing entry, stop & target on chart'
    if (tool === 'chart_mcp_clear') return 'Clearing chart overlays'
    return 'Connecting to chart engine'
  }
  if (TV_MCP_TOOLS.has(tool)) {
    return 'Syncing with TradingView'
  }
  if (tool === 'get_technical_analysis') return 'Reading trend, momentum & structure'
  if (tool === 'get_intraday_candles') return 'Scanning recent price action'
  if (tool === 'get_volume_profile') return 'Mapping volume profile & POC'
  if (tool === 'get_orderbook_depth') return 'Reading order-book depth'
  if (tool === 'get_metals_deep_market') return 'Pulling institutional metals data'
  if (tool === 'get_economic_calendar') return 'Checking economic calendar'
  if (tool === 'get_market_news' || tool === 'get_company_news') return 'Scanning market headlines'
  if (tool === 'research_catalysts') return 'Researching upcoming catalysts'
  if (tool === 'get_quotes_batch') return 'Snapshotting cross-asset prices'
  if (tool === 'get_crypto_fear_greed') return 'Reading crypto sentiment'
  if (tool === 'get_deep_market_data') return 'Deep market structure scan'
  if (tool === 'chart_mcp_get_state') return 'Reading chart overlays & active setup'
  if (tool === 'get_quote') return 'Checking live price vs setup'

  return toolLabel(tool)
}

export function userActivityLabelForSubAgent(agent: string): string {
  if (agent === 'setup') return 'Scanning structure, candles & volume'
  if (agent === 'research') return 'Research scout · web & news'
  if (agent === 'macro') return 'Macro scout · calendar & drivers'
  if (agent === 'liquidity') return 'Smart-money liquidity scan'
  if (agent === 'verification') return 'Verifying live price & setup'
  if (agent === 'discovery') return 'Finding the right symbol'
  if (agent.startsWith('specialist:')) {
    return `${subAgentLabel(agent)} analysis`
  }
  return subAgentLabel(agent)
}

export function userActivityPhaseForTool(tool: string): AgentSpinnerPhase {
  if (WEB_TOOLS.has(tool)) return 'tool'
  if (CHART_MCP_TOOLS.has(tool) || TV_MCP_TOOLS.has(tool)) return 'tool'
  return 'tool'
}

export function upsertUserActivity(
  activities: UserActivity[],
  id: string,
  patch: Omit<UserActivity, 'id' | 'at'> & { at?: number }
): UserActivity[] {
  const idx = activities.findIndex((a) => a.id === id)
  const at = patch.at ?? (idx >= 0 ? activities[idx].at : Date.now())
  const next: UserActivity = {
    id,
    at,
    kind: patch.kind,
    label: patch.label,
    detail: patch.detail,
    status: patch.status,
    phase: patch.phase,
  }
  if (idx >= 0) {
    const copy = [...activities]
    copy[idx] = { ...copy[idx], ...next, at: copy[idx].at }
    return copy
  }
  return [...activities, next]
}

export function completeActivitiesExcept(
  activities: UserActivity[],
  exceptId?: string
): UserActivity[] {
  return activities.map((a) => {
    if (a.id === exceptId) return a
    if (a.status === 'running') return { ...a, status: 'done' as const }
    return a
  })
}

export function completeAllActivities(activities: UserActivity[]): UserActivity[] {
  return activities.map((a) =>
    a.status === 'running' ? { ...a, status: 'done' as const } : a
  )
}

/** Build activity list from recorded tool trace (replay mode). */
export function activitiesFromTools(tools: AgentToolEvent[]): UserActivity[] {
  return tools.map((t, i) => ({
    id: t.callId || `tool-${i}`,
    kind: 'tool' as const,
    label: userActivityLabelForTool(t.tool, t.args),
    detail: t.summary ?? t.error,
    status: (t.status === 'running' ? 'running' : t.status === 'ok' ? 'done' : 'error') as StepStatus,
    phase: userActivityPhaseForTool(t.tool),
    at: i,
  }))
}

/** What to show in the header + progress list (live). */
export function deriveLiveActivities(
  activities: UserActivity[],
  opts?: { maxVisible?: number }
): UserActivity[] {
  const max = opts?.maxVisible ?? 12
  const running = activities.filter((a) => a.status === 'running')
  const done = activities.filter((a) => a.status !== 'running')
  const tail = done.slice(-Math.max(0, max - running.length - 1))
  return [...tail, ...running].slice(-max)
}

export function currentRunningActivity(activities: UserActivity[]): UserActivity | null {
  for (let i = activities.length - 1; i >= 0; i--) {
    if (activities[i].status === 'running') return activities[i]
  }
  return null
}

export function spinnerPhaseFromActivity(activity: UserActivity | null): AgentSpinnerPhase {
  if (!activity) return 'thinking'
  return activity.phase
}
