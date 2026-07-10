/**
 * Shared types for the agentic tool layer used by /api/market-chat.
 *
 * Tools are pure functions that fetch market data (quotes, candles, news,
 * calendar, web). They are described with a JSON-Schema-like `parameters`
 * object so Gemini can call them via function-calling.
 */

export type ToolParameterSchema = {
  type: 'OBJECT'
  properties: Record<string, ToolFieldSchema>
  required?: string[]
}

export type ToolFieldSchema = {
  type: 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY'
  description?: string
  enum?: string[]
  items?: { type: 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' }
}

export type ToolDeclaration = {
  name: string
  description: string
  parameters: ToolParameterSchema
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolContext
) => Promise<unknown>

export type ToolContext = {
  defaultSymbol?: string
  defaultResolution?: string
  /** Session id for todos / background tasks. */
  sessionKey?: string
  /** Live chart canvas snapshot from the client (drawings + active setup). */
  chartState?: import('@/lib/chart-state').ChartStateSnapshot | null
  /** Trace each tool call so the API can return it to the UI. */
  trace: ToolTraceEntry[]
  /** Server-only: live grounding for on-demand specialist pipeline. */
  grounding?: import('@/lib/agent/live-grounding').LiveGrounding
  /** Server-only: stream specialist pipeline progress to the UI. */
  onPipelineEvent?: (event: Record<string, unknown>) => void
  /** Server-only: store pipeline result when run via run_specialist_confluence. */
  pipelineResultSlot?: { current: import('@/lib/agent/pipeline-types').PipelineResult | null }
  /** Server-only: agent deadline for pipeline budget. */
  deadlineMs?: number
}

export type ToolTraceEntry = {
  tool: string
  args: Record<string, unknown>
  ok: boolean
  durationMs: number
  summary?: string
  error?: string
}

export type ToolDefinition = {
  declaration: ToolDeclaration
  execute: ToolExecutor
}
