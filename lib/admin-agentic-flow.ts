/**
 * Step definitions for the admin agentic flow diagram.
 * Mirrors lib/agent/run.ts orchestration and client wiring.
 */

export type FlowLayer =
  | 'client'
  | 'api'
  | 'setup'
  | 'parallel'
  | 'ai'
  | 'tools'
  | 'chart'
  | 'output'
  | 'admin'

export type FlowStep = {
  id: string
  layer: FlowLayer
  title: string
  detail: string
  file: string
  /** Stream event type emitted at this stage, if any */
  event?: string
  /** Tool or agent ids highlighted in this step */
  highlights?: string[]
  parallelGroup?: 'pipeline' | 'scouts' | 'both'
}

export const FLOW_LAYER_META: Record<
  FlowLayer,
  { label: string; color: string; bg: string; border: string }
> = {
  client: {
    label: 'Client UI',
    color: 'text-sky-800',
    bg: 'bg-sky-50',
    border: 'border-sky-200',
  },
  api: {
    label: 'API',
    color: 'text-[#1A3D63]',
    bg: 'bg-[#F6FAFD]',
    border: 'border-[#B3CFE5]',
  },
  setup: {
    label: 'Agent setup',
    color: 'text-violet-800',
    bg: 'bg-violet-50',
    border: 'border-violet-200',
  },
  parallel: {
    label: 'Parallel prefetch',
    color: 'text-indigo-800',
    bg: 'bg-indigo-50',
    border: 'border-indigo-200',
  },
  ai: {
    label: 'AI loop',
    color: 'text-[#0A1931]',
    bg: 'bg-[#E8F1F8]',
    border: 'border-[#1A3D63]/30',
  },
  tools: {
    label: 'Tool registry',
    color: 'text-emerald-800',
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
  },
  chart: {
    label: 'Chart MCP',
    color: 'text-amber-800',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
  },
  output: {
    label: 'Response',
    color: 'text-teal-800',
    bg: 'bg-teal-50',
    border: 'border-teal-200',
  },
  admin: {
    label: 'Admin telemetry',
    color: 'text-slate-700',
    bg: 'bg-slate-50',
    border: 'border-slate-200',
  },
}

export const AGENTIC_FLOW_STEPS: FlowStep[] = [
  {
    id: 'user-message',
    layer: 'client',
    title: 'User sends a question',
    detail:
      'Trader types in the chart agent panel (or insights chat). Message may include attached chart screenshots.',
    file: 'components/markets/chart-chat-panel.tsx',
  },
  {
    id: 'chart-state',
    layer: 'client',
    title: 'Build live chart snapshot',
    detail:
      'ChartDrawingsProvider supplies drawings, active setup (entry/SL/TP), user vs AI counts. Snapshot is built per message.',
    file: 'lib/chart-state.ts → buildChartStateSnapshot()',
    highlights: ['chart_mcp_get_state'],
  },
  {
    id: 'start-run',
    layer: 'client',
    title: 'Start agent run',
    detail:
      'agent-run-context.startRun() stores scope, symbol, resolution, history, images, and chartState. Work UI resets for streaming.',
    file: 'components/markets/agent-run-context.tsx',
    event: 'open',
  },
  {
    id: 'stream-post',
    layer: 'client',
    title: 'Open NDJSON stream',
    detail:
      'streamAgent() POSTs to /api/market-chat with Accept: application/x-ndjson. Events parsed line-by-line on the client.',
    file: 'lib/agent-stream.ts',
  },
  {
    id: 'auth-limits',
    layer: 'api',
    title: 'Auth + plan limits',
    detail:
      'Session required. Hourly/daily chat caps enforced via plan-usage before the agent starts.',
    file: 'app/api/market-chat/route.ts',
  },
  {
    id: 'parse-run',
    layer: 'api',
    title: 'Parse chartState → runAgent',
    detail:
      'Server sanitizes chartState (max 80 drawings), merges conversation memory, then calls runAgent() with onEvent for streaming.',
    file: 'lib/agent/run.ts → runAgent()',
  },
  {
    id: 'key-pool',
    layer: 'setup',
    title: 'Load AI key pool',
    detail:
      'Gemini keys primary; DeepSeek fallback when Gemini exhausted. getActiveKeys() skips keys in cooldown after 429/401.',
    file: 'lib/gemini-keypool.ts',
    highlights: ['gemini', 'deepseek'],
  },
  {
    id: 'grounding',
    layer: 'setup',
    title: 'Live market grounding',
    detail:
      'fetchLiveGrounding() loads live quote, session timing, and calendar blackout for the symbol before planning.',
    file: 'lib/agent/live-grounding.ts',
    event: 'grounding',
    highlights: ['get_quote', 'get_market_sessions', 'get_economic_calendar'],
  },
  {
    id: 'planner',
    layer: 'setup',
    title: 'Manager planner',
    detail:
      'planAgentTask() classifies intent (setup, research, general…), picks sub-agent scouts, recommendedTools, and effort level.',
    file: 'lib/agent/orchestrator/planner.ts',
    event: 'planning',
    highlights: ['manager'],
  },
  {
    id: 'pipeline',
    layer: 'parallel',
    title: '8-specialist pipeline (optional)',
    detail:
      'For setup-ish intents: regime, SMC, technical, momentum, MTF, pattern, events, sentiment run in parallel → confluence merge.',
    file: 'lib/agent/orchestrator/pipeline-bridge.ts',
    event: 'confluence',
    highlights: [
      'specialist:regime',
      'specialist:smc',
      'specialist:technical',
      'specialist:momentum',
      'specialist:mtf',
      'specialist:pattern',
      'specialist:events',
      'specialist:sentiment',
      'specialist:orchestrator',
    ],
    parallelGroup: 'pipeline',
  },
  {
    id: 'scouts',
    layer: 'parallel',
    title: 'Sub-agent scouts (optional)',
    detail:
      'Parallel tool-only scouts prefetch data: setup, research, macro, discovery, verification, liquidity (Smart Money).',
    file: 'lib/agent/orchestrator/sub-agents.ts',
    event: 'sub_agent_done',
    highlights: ['setup', 'research', 'macro', 'discovery', 'verification', 'liquidity'],
    parallelGroup: 'scouts',
  },
  {
    id: 'gap-prefetch',
    layer: 'parallel',
    title: 'Gap-fill prefetch',
    detail:
      'prefetchRecommendedGaps() runs tools scouts skipped. Pipeline-covered tools skipped when confluence already ran.',
    file: 'lib/agent/orchestrator/prefetch-gaps.ts',
    parallelGroup: 'both',
  },
  {
    id: 'prompt-build',
    layer: 'ai',
    title: 'Assemble model prompt',
    detail:
      'System prompt + chart state block + grounding + plan + sub-agent briefs + pipeline brief + history + user message (+ images).',
    file: 'lib/agent/trading-knowledge.ts + buildChartStatePromptBlock()',
  },
  {
    id: 'allowlist',
    layer: 'ai',
    title: 'Tool allowlist',
    detail:
      'buildAllowedTools(plan, mode): core + internet + meta always; chart_mcp_* in chart mode; crypto/deep tools when intent requires.',
    file: 'lib/agent/orchestrator/tool-policy.ts',
  },
  {
    id: 'llm-call',
    layer: 'ai',
    title: 'Gemini / DeepSeek round-trip',
    detail:
      'callAiWithPoolRetry() sends function declarations. Model returns tool calls or final JSON. Max 12 tools, 12 rounds, 110s.',
    file: 'lib/agent/run.ts → callAiWithPoolRetry()',
    event: 'thinking',
  },
  {
    id: 'tool-exec',
    layer: 'tools',
    title: 'Execute tool from registry',
    detail:
      'getToolByName() → guardToolCall() → execute. 43 tools: market data, web, crypto, meta agent_*, chart MCP, TradingView MCP.',
    file: 'lib/ai-tools/registry.ts',
    event: 'tool_call',
    highlights: [
      'get_technical_analysis',
      'search_web',
      'research_catalysts',
      'chart_mcp_draw_setup',
    ],
  },
  {
    id: 'tool-result',
    layer: 'tools',
    title: 'Stream tool result',
    detail:
      'Result appended to conversation as functionResponse. recordToolCall() + recordAdminError() on failure. Client may apply chart payload live.',
    file: 'lib/ai-tools/registry.ts timed()',
    event: 'tool_result',
  },
  {
    id: 'chart-apply-live',
    layer: 'chart',
    title: 'Live chart drawing (optional)',
    detail:
      'chart_mcp_draw_setup returns drawing payload → chart-chat-panel calls applyChartMcpPayload() → ChartDrawingsProvider updates canvas.',
    file: 'lib/chart-mcp/client-apply.ts',
    highlights: ['chart_mcp_draw_setup', 'chart_mcp_clear'],
  },
  {
    id: 'finalize',
    layer: 'output',
    title: 'Parse + polish + reflect',
    detail:
      'Parse MarketChatResponse JSON → formatMarketChatReply → mergePipelineIntoChatResponse → reflectOnResponse (up to 2 retries).',
    file: 'lib/agent/format-reply-agent.server.ts + reflect.ts',
    event: 'reflecting',
    highlights: ['main_agent'],
  },
  {
    id: 'stream-final',
    layer: 'output',
    title: 'Stream final to client',
    detail:
      'final event carries reply, setup (entry/SL/TP), levels, zones, drawIntent. done closes the stream.',
    file: 'lib/agent-stream.ts',
    event: 'final',
  },
  {
    id: 'chart-apply-final',
    layer: 'chart',
    title: 'Apply setup from final JSON',
    detail:
      'If drawIntent: true, applyFromSetup() draws entry/SL/TP from parsed setup even without a live MCP tool call.',
    file: 'components/markets/chart-drawings-context.tsx',
  },
  {
    id: 'user-sees',
    layer: 'client',
    title: 'User sees reply + chart',
    detail:
      'Chat shows streaming work steps, setup card, and updated chart overlays. Conversation saved via /api/user/conversations.',
    file: 'components/markets/chart-chat-panel.tsx',
  },
  {
    id: 'admin-track',
    layer: 'admin',
    title: 'Admin telemetry (async)',
    detail:
      'recordAiKeyUsageFromResponse, recordAgentRun(main_agent), recordToolCall per tool. Visible on /admin/ai and /admin/agents.',
    file: 'lib/ai-usage-tracker.ts + lib/tool-usage-tracker.ts',
  },
]

export const TOOL_GROUP_SUMMARY = [
  {
    id: 'market',
    label: 'Core market (24)',
    examples: ['get_quote', 'get_technical_analysis', 'get_deep_market_data', 'research_catalysts'],
  },
  {
    id: 'meta',
    label: 'Agent meta (7)',
    examples: ['agent_todo_write', 'agent_load_skill', 'agent_create_background_task'],
  },
  {
    id: 'chart',
    label: 'Chart MCP (4)',
    examples: ['chart_mcp_get_state', 'chart_mcp_draw_setup', 'chart_mcp_clear'],
  },
  {
    id: 'tv',
    label: 'TradingView MCP (4)',
    examples: ['tradingview_sync_chart', 'tradingview_draw_setup'],
  },
] as const
