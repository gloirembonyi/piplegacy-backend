/**
 * Central registry of every runtime path and tool that calls Gemini (or DeepSeek fallback).
 * Used by admin Tools & Agents, live agent work UI, and run audit labels.
 */

export type GeminiConsumerKind = 'chat_runtime' | 'chat_tool' | 'chart_scan' | 'other'

export type GeminiConsumer = {
  id: string
  label: string
  kind: GeminiConsumerKind
  description: string
  /** Active during POST /api/market-chat agent loop */
  inChatLoop: boolean
  /** Active during Chart Analysis /api/bot/scan pipeline */
  inChartScan: boolean
  /** Registered tool name when a tool triggers Gemini indirectly */
  toolName?: string
  file?: string
}

/** LLM call sites during agent runs (not REST data tools). */
export const GEMINI_RUNTIME_CONSUMERS: GeminiConsumer[] = [
  {
    id: 'main_agent',
    label: 'Main agent loop',
    kind: 'chat_runtime',
    description: 'Primary Gemini tool-calling loop in market chat (multi-round).',
    inChatLoop: true,
    inChartScan: false,
    file: 'lib/agent/run.ts',
  },
  {
    id: 'agent',
    label: 'Main agent loop',
    kind: 'chat_runtime',
    description: 'Alias for main agent usage tracking.',
    inChatLoop: true,
    inChartScan: false,
    file: 'lib/agent/run.ts',
  },
  {
    id: 'conversational',
    label: 'Conversational reply',
    kind: 'chat_runtime',
    description: 'Fast Gemini path for greetings and small talk (no tools).',
    inChatLoop: true,
    inChartScan: false,
    file: 'lib/agent/conversational-gemini.ts',
  },
  {
    id: 'sub_agent_summarize',
    label: 'Scout summarizer',
    kind: 'chat_runtime',
    description: 'Gemini summaries for setup / macro / research / liquidity scouts.',
    inChatLoop: true,
    inChartScan: false,
    file: 'lib/agent/orchestrator/sub-agent-summarize.ts',
  },
  {
    id: 'pipeline_reply',
    label: 'Answer composer',
    kind: 'chat_runtime',
    description: 'Gemini rewrites the final reply from scout + pipeline evidence.',
    inChatLoop: true,
    inChartScan: false,
    file: 'lib/agent/pipeline-reply-gemini.ts',
  },
  {
    id: 'format_reply',
    label: 'Reply formatter',
    kind: 'chat_runtime',
    description: 'Optional Gemini polish when deterministic formatting is insufficient.',
    inChatLoop: true,
    inChartScan: false,
    file: 'lib/agent/format-reply-agent.server.ts',
  },
  {
    id: 'specialist',
    label: 'Specialist lens',
    kind: 'chart_scan',
    description: '8 pipeline specialists + orchestrator synthesis (regime, structure, momentum, etc.).',
    inChatLoop: false,
    inChartScan: true,
    file: 'lib/agent/specialists/',
  },
  {
    id: 'suggestion',
    label: 'AI suggestions',
    kind: 'other',
    description: 'Chart suggestion chips (not part of chat agent loop).',
    inChatLoop: false,
    inChartScan: false,
    file: 'lib/ai-suggestions.ts',
  },
  {
    id: 'analyze_chart',
    label: 'Analyze chart API',
    kind: 'other',
    description: 'Standalone /api/analyze-chart vision + analysis route.',
    inChatLoop: false,
    inChartScan: false,
    file: 'app/api/analyze-chart/route.ts',
  },
]

/** Tools that trigger Gemini when invoked (via specialist pipeline). */
export const GEMINI_TOOL_CONSUMERS: GeminiConsumer[] = [
  {
    id: 'tool:run_specialist_confluence',
    label: 'Confluence scan tool',
    kind: 'chat_tool',
    description: 'Runs 8-specialist pipeline on demand when user asks for institutional / confluence scan.',
    inChatLoop: true,
    inChartScan: true,
    toolName: 'run_specialist_confluence',
    file: 'lib/agent/meta-tools/specialist-pipeline-tool.ts',
  },
]

const CHART_SCAN_SPECIALISTS = [
  'specialist:regime',
  'specialist:structure',
  'specialist:smart_money',
  'specialist:momentum',
  'specialist:mtf',
  'specialist:pattern',
  'specialist:events',
  'specialist:sentiment',
  'specialist:orchestrator',
] as const

const SOURCE_LABELS: Record<string, string> = {
  main_agent: 'Main agent',
  agent: 'Main agent',
  conversational: 'Conversational',
  sub_agent_summarize: 'Scout summary',
  pipeline_reply: 'Answer composer',
  format_reply: 'Reply format',
  specialist: 'Specialist lens',
  suggestion: 'Suggestions',
}

export function geminiSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.replace(/_/g, ' ')
}

export function toolUsesGemini(toolName: string): boolean {
  return GEMINI_TOOL_CONSUMERS.some((c) => c.toolName === toolName)
}

export function isGeminiModel(model: string): boolean {
  return model.toLowerCase().includes('gemini')
}

/** Admin-facing list: runtime layers + Gemini-triggering tools + chart-scan specialists. */
export function listGeminiConsumersForAdmin(): {
  runtime: GeminiConsumer[]
  tools: GeminiConsumer[]
  chartScanSpecialists: Array<{ id: string; label: string }>
  dataToolsNote: string
} {
  const runtime = GEMINI_RUNTIME_CONSUMERS.filter(
    (c, i, arr) => arr.findIndex((x) => x.id === c.id) === i && c.id !== 'agent'
  )
  return {
    runtime,
    tools: GEMINI_TOOL_CONSUMERS,
    chartScanSpecialists: CHART_SCAN_SPECIALISTS.map((id) => ({
      id,
      label: id.replace('specialist:', '').replace(/_/g, ' '),
    })),
    dataToolsNote:
      'All other registered tools (quotes, candles, web search, chart MCP draw, etc.) use REST/data APIs only - they do not call Gemini.',
  }
}
