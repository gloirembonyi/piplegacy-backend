/**
 * Admin playground - schemas + executors for testing tools and agents in isolation.
 */

import { AGENT_REGISTRY } from '@/lib/admin-agent-registry'
import { getToolByName, listRegisteredToolNames, makeToolContext } from '@/lib/ai-tools/registry'
import type { ToolDeclaration, ToolFieldSchema } from '@/lib/ai-tools/types'
import { AGENT_TOOL_META } from '@/lib/agent-work-ui'
import { fetchLiveGrounding } from '@/lib/agent/live-grounding'
import { runPipeline } from '@/lib/agent/pipeline'
import { planAgentTask } from '@/lib/agent/orchestrator/planner'
import { runSingleSubAgent } from '@/lib/agent/orchestrator/sub-agents'
import type { OrchestratorInput, SubAgentId } from '@/lib/agent/orchestrator/types'
import { runRegimeSpecialist } from '@/lib/agent/specialists/regime'
import { runSmcSpecialist } from '@/lib/agent/specialists/smc'
import { runTechnicalSpecialist } from '@/lib/agent/specialists/technical'
import { runMomentumSpecialist } from '@/lib/agent/specialists/momentum'
import { runMtfSpecialist } from '@/lib/agent/specialists/mtf'
import { runPatternSpecialist } from '@/lib/agent/specialists/pattern'
import { runEventsSpecialist } from '@/lib/agent/specialists/events'
import { runSentimentSpecialist } from '@/lib/agent/specialists/sentiment'
import type { SpecialistId } from '@/lib/agent/pipeline-types'
import type { SpecialistContext } from '@/lib/agent/specialists/helpers'
import { specialistRunOk } from '@/lib/agent/specialists/helpers'
import { runAgent } from '@/lib/agent/run'
import { displaySymbolLabel } from '@/lib/symbols'
import { recordAgentRun } from '@/lib/tool-usage-tracker'

export type PlaygroundFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array'

export type PlaygroundFieldSchema = {
  name: string
  type: PlaygroundFieldType
  description?: string
  required?: boolean
  enum?: string[]
  default?: unknown
  itemsType?: 'string' | 'number'
}

export type PlaygroundEndpointSchema = {
  id: string
  kind: 'tool' | 'agent'
  label: string
  description: string
  category: string
  fields: PlaygroundFieldSchema[]
  contextFields?: PlaygroundFieldSchema[]
  warnings?: string[]
}

export type PlaygroundContext = {
  symbol?: string
  resolution?: string
  mode?: 'chart' | 'insights'
}

export type PlaygroundExecuteResult = {
  ok: boolean
  durationMs: number
  result?: unknown
  error?: string
  trace?: Array<{ tool: string; ok: boolean; durationMs: number; summary?: string; error?: string }>
}

const SPECIALIST_RUNNERS: Record<
  SpecialistId,
  (ctx: SpecialistContext) => Promise<import('@/lib/agent/pipeline-types').SpecialistReport>
> = {
  regime: runRegimeSpecialist,
  smc: runSmcSpecialist,
  technical: runTechnicalSpecialist,
  momentum: runMomentumSpecialist,
  mtf: runMtfSpecialist,
  pattern: runPatternSpecialist,
  events: runEventsSpecialist,
  sentiment: runSentimentSpecialist,
}

const SUB_AGENT_IDS = new Set<SubAgentId>([
  'setup',
  'research',
  'macro',
  'discovery',
  'verification',
  'liquidity',
])

const AGENT_CONTEXT_FIELDS: PlaygroundFieldSchema[] = [
  {
    name: 'message',
    type: 'string',
    description: 'User question that drives routing and tool selection.',
    required: true,
    default: 'Where are entry, stop and target for XAUUSD?',
  },
  {
    name: 'symbol',
    type: 'string',
    description: 'Chart symbol context (e.g. XAUUSD, SPY, BTCUSD).',
    default: 'XAUUSD',
  },
  {
    name: 'resolution',
    type: 'string',
    description: 'Chart resolution: 1, 5, 15, 60, D.',
    default: '60',
    enum: ['1', '5', '15', '60', 'D'],
  },
  {
    name: 'mode',
    type: 'string',
    description: 'chart = embedded chart context; insights = research mode.',
    default: 'insights',
    enum: ['chart', 'insights'],
  },
]

const SPECIALIST_FIELDS: PlaygroundFieldSchema[] = [
  {
    name: 'symbol',
    type: 'string',
    description: 'Symbol to analyze.',
    required: true,
    default: 'XAUUSD',
  },
  {
    name: 'timeframe',
    type: 'string',
    description: 'Working timeframe for the specialist.',
    default: '1h',
    enum: ['5m', '15m', '30m', '1h', '4h', '1d'],
  },
]

const PIPELINE_FIELDS: PlaygroundFieldSchema[] = [
  ...SPECIALIST_FIELDS,
  {
    name: 'fast',
    type: 'boolean',
    description: 'Skip pattern + sentiment specialists (faster).',
    default: false,
  },
  {
    name: 'riskBudgetPct',
    type: 'number',
    description: 'Suggested risk % for position sizing hint.',
    default: 1,
  },
]

function fieldTypeFromSchema(f: ToolFieldSchema): PlaygroundFieldType {
  if (f.type === 'ARRAY') return 'array'
  if (f.type === 'NUMBER') return 'number'
  if (f.type === 'INTEGER') return 'integer'
  if (f.type === 'BOOLEAN') return 'boolean'
  return 'string'
}

function defaultForField(name: string, f: ToolFieldSchema): unknown {
  if (f.enum?.length) return f.enum[0]
  const t = fieldTypeFromSchema(f)
  if (t === 'boolean') return false
  if (t === 'number' || t === 'integer') return undefined
  if (t === 'array') return []
  if (name === 'symbol') return 'XAUUSD'
  if (name === 'query') return 'gold price outlook'
  if (name === 'url') return 'https://www.example.com'
  return ''
}

function declarationToFields(decl: ToolDeclaration): PlaygroundFieldSchema[] {
  const required = new Set(decl.parameters.required ?? [])
  return Object.entries(decl.parameters.properties).map(([name, schema]) => ({
    name,
    type: fieldTypeFromSchema(schema),
    description: schema.description,
    required: required.has(name),
    enum: schema.enum,
    itemsType: schema.items?.type === 'NUMBER' ? 'number' : 'string',
    default: defaultForField(name, schema),
  }))
}

function toolCategory(id: string): string {
  if (id.startsWith('chart_mcp')) return 'chart'
  if (id.startsWith('tradingview')) return 'tradingview'
  if (id.startsWith('agent_') || id === 'run_specialist_confluence') return 'meta'
  if (id.includes('crypto')) return 'crypto'
  if (id.includes('web') || id.includes('search') || id.includes('fetch')) return 'research'
  return 'market'
}

export function getPlaygroundToolSchemas(): PlaygroundEndpointSchema[] {
  const contextFields: PlaygroundFieldSchema[] = [
    {
      name: 'symbol',
      type: 'string',
      description: 'Default symbol when tool args omit symbol.',
      default: 'XAUUSD',
    },
    {
      name: 'resolution',
      type: 'string',
      description: 'Default resolution for candle tools.',
      default: '60',
      enum: ['1', '5', '15', '60', 'D'],
    },
  ]

  return listRegisteredToolNames()
    .map((name): PlaygroundEndpointSchema | null => {
      const tool = getToolByName(name)
      if (!tool) return null
      const meta = AGENT_TOOL_META[name]
      return {
        id: name,
        kind: 'tool',
        label: meta?.label ?? name.replace(/_/g, ' '),
        description: tool.declaration.description,
        category: toolCategory(name),
        fields: declarationToFields(tool.declaration),
        contextFields,
      }
    })
    .filter((s): s is PlaygroundEndpointSchema => s != null)
    .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label))
}

export function getPlaygroundAgentSchemas(): PlaygroundEndpointSchema[] {
  return AGENT_REGISTRY.map((agent) => {
    if (SUB_AGENT_IDS.has(agent.id as SubAgentId)) {
      return {
        id: agent.id,
        kind: 'agent' as const,
        label: agent.label,
        description: agent.description,
        category: agent.kind,
        fields: AGENT_CONTEXT_FIELDS,
      }
    }

    if (agent.id.startsWith('specialist:') && agent.id !== 'specialist:orchestrator') {
      return {
        id: agent.id,
        kind: 'agent' as const,
        label: agent.label,
        description: agent.description,
        category: agent.kind,
        fields: SPECIALIST_FIELDS,
      }
    }

    if (agent.id === 'specialist:orchestrator') {
      return {
        id: agent.id,
        kind: 'agent' as const,
        label: agent.label,
        description: 'Runs all 8 specialists + decision orchestrator (full confluence scan).',
        category: agent.kind,
        fields: PIPELINE_FIELDS,
        warnings: ['Runs 8+ AI calls - may take 30–90s and consume API quota.'],
      }
    }

    if (agent.id === 'manager') {
      return {
        id: agent.id,
        kind: 'agent' as const,
        label: agent.label,
        description: 'Rule-based intent routing - returns plan only (no LLM).',
        category: agent.kind,
        fields: AGENT_CONTEXT_FIELDS,
      }
    }

    if (agent.id === 'main_agent') {
      return {
        id: agent.id,
        kind: 'agent' as const,
        label: agent.label,
        description: 'Full Gemini/DeepSeek agent loop with tool calling.',
        category: agent.kind,
        fields: AGENT_CONTEXT_FIELDS,
        warnings: [
          'Full agent run - may take 15–60s, uses AI keys, and executes multiple tools.',
        ],
      }
    }

    return {
      id: agent.id,
      kind: 'agent' as const,
      label: agent.label,
      description: agent.description,
      category: agent.kind,
      fields: AGENT_CONTEXT_FIELDS,
    }
  })
}

function parseArgs(raw: Record<string, unknown>, fields: PlaygroundFieldSchema[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = raw[f.name]
    if (v === undefined || v === null || v === '') {
      if (f.required && f.default === undefined) continue
      if (f.default !== undefined) out[f.name] = f.default
      continue
    }
    if (f.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isFinite(n)) out[f.name] = n
      continue
    }
    if (f.type === 'integer') {
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isFinite(n)) out[f.name] = Math.trunc(n)
      continue
    }
    if (f.type === 'boolean') {
      out[f.name] = v === true || v === 'true' || v === 1 || v === '1'
      continue
    }
    if (f.type === 'array') {
      if (Array.isArray(v)) {
        out[f.name] = v
        continue
      }
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v)
          if (Array.isArray(parsed)) {
            out[f.name] = parsed
            continue
          }
        } catch {
          out[f.name] = v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          continue
        }
      }
    }
    out[f.name] = String(v)
  }
  return out
}

function truncatePlaygroundResult(value: unknown, depth = 0): unknown {
  if (value == null || depth > 6) return value
  if (Array.isArray(value)) {
    if (value.length > 40) {
      return [...value.slice(0, 20).map((v) => truncatePlaygroundResult(v, depth + 1)), `… ${value.length - 20} more items`]
    }
    return value.map((v) => truncatePlaygroundResult(v, depth + 1))
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'lastBars' && Array.isArray(v) && v.length > 8) {
        out[k] = [...v.slice(0, 5), `… ${v.length - 5} more bars`]
        continue
      }
      if (k === 'bins' && Array.isArray(v) && v.length > 10) {
        out[k] = [...v.slice(0, 6), `… ${v.length - 6} more bins`]
        continue
      }
      out[k] = truncatePlaygroundResult(v, depth + 1)
    }
    return out
  }
  return value
}

function hasErrorResult(result: unknown): string | null {
  if (result && typeof result === 'object' && 'error' in result) {
    const err = (result as { error?: unknown }).error
    if (err != null && String(err).trim()) return String(err)
  }
  return null
}

async function buildOrchestratorInput(
  args: Record<string, unknown>,
  context?: PlaygroundContext
): Promise<OrchestratorInput> {
  const symbol = String(args.symbol ?? context?.symbol ?? 'XAUUSD').trim()
  const grounding = await fetchLiveGrounding({
    symbol,
    symbolLabel: displaySymbolLabel(symbol),
  })
  return {
    message: String(args.message ?? 'Test message'),
    mode: (args.mode as 'chart' | 'insights') ?? context?.mode ?? 'insights',
    symbol,
    symbolLabel: displaySymbolLabel(symbol),
    resolution: String(args.resolution ?? context?.resolution ?? '60'),
    grounding,
    chartState: null,
  }
}

export async function executePlaygroundTool(
  toolId: string,
  rawArgs: Record<string, unknown>,
  context?: PlaygroundContext
): Promise<PlaygroundExecuteResult> {
  const start = Date.now()
  const tool = getToolByName(toolId)
  if (!tool) {
    return { ok: false, durationMs: Date.now() - start, error: `Unknown tool: ${toolId}` }
  }

  const schema = getPlaygroundToolSchemas().find((s) => s.id === toolId)
  const args = parseArgs(rawArgs, schema?.fields ?? [])

  const ctx = makeToolContext({
    defaultSymbol: String(context?.symbol ?? args.symbol ?? 'XAUUSD'),
    defaultResolution: String(context?.resolution ?? '60'),
    sessionKey: 'admin-playground',
    chartState: null,
  })

  try {
    const result = await tool.execute(args, ctx)
    const err = hasErrorResult(result)
    const durationMs = Date.now() - start
    return {
      ok: !err,
      durationMs,
      result: truncatePlaygroundResult(result),
      error: err ?? undefined,
      trace: ctx.trace.map((t) => ({
        tool: t.tool,
        ok: t.ok,
        durationMs: t.durationMs,
        summary: t.summary,
        error: t.error,
      })),
    }
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      trace: ctx.trace.map((t) => ({
        tool: t.tool,
        ok: t.ok,
        durationMs: t.durationMs,
        summary: t.summary,
        error: t.error,
      })),
    }
  }
}

export async function executePlaygroundAgent(
  agentId: string,
  rawArgs: Record<string, unknown>,
  context?: PlaygroundContext
): Promise<PlaygroundExecuteResult> {
  const start = Date.now()

  try {
    if (SUB_AGENT_IDS.has(agentId as SubAgentId)) {
      const input = await buildOrchestratorInput(rawArgs, context)
      const plan = planAgentTask(input)
      const { brief, trace } = await runSingleSubAgent(agentId as SubAgentId, input, plan)
      return {
        ok: brief.ok,
        durationMs: Date.now() - start,
        result: truncatePlaygroundResult({ brief, data: brief.data }),
        trace: trace.map((t) => ({
          tool: t.tool,
          ok: t.ok,
          durationMs: t.durationMs,
          summary: t.summary,
          error: t.error,
        })),
      }
    }

    if (agentId.startsWith('specialist:') && agentId !== 'specialist:orchestrator') {
      const specialistId = agentId.replace('specialist:', '') as SpecialistId
      const runner = SPECIALIST_RUNNERS[specialistId]
      if (!runner) {
        return { ok: false, durationMs: Date.now() - start, error: `Unknown specialist: ${agentId}` }
      }
      const args = parseArgs(rawArgs, SPECIALIST_FIELDS)
      const symbol = String(args.symbol ?? 'XAUUSD').toUpperCase()
      const timeframe = String(args.timeframe ?? '1h')
      const ctx: SpecialistContext = {
        symbol,
        symbolLabel: displaySymbolLabel(symbol),
        timeframe,
        candleCache: new Map(),
      }
      const report = await runner(ctx)
      void recordAgentRun(agentId, specialistRunOk(report))
      return {
        ok: specialistRunOk(report),
        durationMs: Date.now() - start,
        result: truncatePlaygroundResult(report),
        error: report.error,
      }
    }

    if (agentId === 'specialist:orchestrator') {
      const args = parseArgs(rawArgs, PIPELINE_FIELDS)
      const symbol = String(args.symbol ?? 'XAUUSD').toUpperCase()
      const result = await runPipeline({
        symbol,
        timeframe: String(args.timeframe ?? '1h'),
        fast: args.fast === true,
        riskBudgetPct: typeof args.riskBudgetPct === 'number' ? args.riskBudgetPct : 1,
      })
      void recordAgentRun('specialist:orchestrator', true)
      return {
        ok: true,
        durationMs: Date.now() - start,
        result: truncatePlaygroundResult({
          setup: result.setup,
          reports: result.reports,
          durationMs: result.durationMs,
          confluenceScore: result.setup.confluenceScore,
          bias: result.setup.bias,
        }),
      }
    }

    if (agentId === 'manager') {
      const input = await buildOrchestratorInput(rawArgs, context)
      const plan = planAgentTask(input)
      void recordAgentRun('manager', true)
      return {
        ok: true,
        durationMs: Date.now() - start,
        result: truncatePlaygroundResult(plan),
      }
    }

    if (agentId === 'main_agent') {
      const input = await buildOrchestratorInput(rawArgs, context)
      const output = await runAgent({
        mode: input.mode,
        symbol: input.symbol,
        symbolLabel: input.symbolLabel,
        resolution: input.resolution,
        message: input.message,
        history: [],
        chartState: null,
      })
      return {
        ok: output.ok,
        durationMs: Date.now() - start,
        result: truncatePlaygroundResult(
          output.ok
            ? {
                reply: output.response.reply,
                setup: output.response.setup,
                levels: output.response.levels,
                model: output.model,
                iterations: output.iterations,
                tokensUsed: output.tokensUsed,
                audit: output.audit,
              }
            : { error: output.error, status: output.status, model: output.model }
        ),
        error: output.ok ? undefined : output.error,
        trace: output.trace.map((t) => ({
          tool: t.tool,
          ok: t.ok,
          durationMs: t.durationMs,
          summary: t.summary,
          error: t.error,
        })),
      }
    }

    return { ok: false, durationMs: Date.now() - start, error: `Unknown agent: ${agentId}` }
  } catch (err) {
    void recordAgentRun(agentId, false)
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function getPlaygroundCatalog() {
  return {
    tools: getPlaygroundToolSchemas(),
    agents: getPlaygroundAgentSchemas(),
  }
}
