/**
 * Per-turn agent run audit - tools, AI calls, token totals for admin visibility.
 */

import { geminiSourceLabel } from '@/lib/gemini-consumers'
import {
  recordConsumerRunBreakdown,
  recordConsumerTokenUsage,
} from '@/lib/gemini-consumer-usage'
import { getRedis } from '@/lib/redis'
import type { ToolTraceEntry } from '@/lib/ai-tools/types'

export type AiCallStreamEvent = {
  type: 'ai_call'
  source: string
  label: string
  model: string
  tokens: number
}

type AiCallEmitHandler = (ev: AiCallStreamEvent) => void

let currentAiCallEmit: AiCallEmitHandler | null = null

export function setRunAiCallEmit(handler: AiCallEmitHandler | null): void {
  currentAiCallEmit = handler
}

const RECENT_MAX = 40
const META_TTL_SEC = 7 * 86_400
const RECENT_LIST_KEY = 'admin:agent-runs:recent'

export type AgentRunAuditTool = {
  tool: string
  ok: boolean
  durationMs: number
  summary?: string
}

export type AgentRunAuditAiCall = {
  source: string
  model: string
  tokens: number
  estimated?: boolean
}

export type AgentRunAudit = {
  id: string
  startedAt: string
  finishedAt: string
  ok: boolean
  userEmail?: string
  symbol?: string
  messagePreview: string
  intent?: string
  model?: string
  iterations?: number
  durationMs: number
  tools: AgentRunAuditTool[]
  aiCalls: AgentRunAuditAiCall[]
  specialistRuns: string[]
  totalTokens: number
  toolCallCount: number
}

const localRecent: AgentRunAudit[] = []
let currentBuilder: RunAuditBuilder | null = null

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class RunAuditBuilder {
  readonly id = newId()
  readonly startedAt = new Date().toISOString()
  readonly tools: AgentRunAuditTool[] = []
  readonly aiCalls: AgentRunAuditAiCall[] = []
  readonly specialistRuns: string[] = []

  constructor(
    readonly meta: {
      userEmail?: string
      symbol?: string
      message: string
      intent?: string
    }
  ) {}

  recordTool(entry: ToolTraceEntry): void {
    if (this.tools.some((t) => t.tool === entry.tool && t.ok === entry.ok && t.summary === entry.summary)) {
      return
    }
    this.tools.push({
      tool: entry.tool,
      ok: entry.ok,
      durationMs: entry.durationMs,
      summary: entry.summary?.slice(0, 120),
    })
  }

  recordTools(trace: ToolTraceEntry[]): void {
    for (const e of trace) this.recordTool(e)
  }

  recordAiCall(input: {
    source: string
    model: string
    tokens: number
    estimated?: boolean
  }): void {
    if (input.tokens > 0) {
      this.aiCalls.push({
        source: input.source,
        model: input.model,
        tokens: input.tokens,
        estimated: input.estimated,
      })
    }
    void recordConsumerTokenUsage(input.source, input.tokens)
    currentAiCallEmit?.({
      type: 'ai_call',
      source: input.source,
      label: geminiSourceLabel(input.source),
      model: input.model,
      tokens: input.tokens,
    })
  }

  recordSpecialist(id: string): void {
    if (!this.specialistRuns.includes(id)) {
      this.specialistRuns.push(id)
    }
  }

  finalize(input: {
    ok: boolean
    model?: string
    iterations?: number
    totalTokens: number
    trace: ToolTraceEntry[]
  }): AgentRunAudit {
    for (const e of input.trace) this.recordTool(e)
    const finishedAt = new Date().toISOString()
    const audit: AgentRunAudit = {
      id: this.id,
      startedAt: this.startedAt,
      finishedAt,
      ok: input.ok,
      userEmail: this.meta.userEmail,
      symbol: this.meta.symbol,
      messagePreview: this.meta.message.trim().slice(0, 100),
      intent: this.meta.intent,
      model: input.model,
      iterations: input.iterations,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(this.startedAt)),
      tools: this.tools,
      aiCalls: this.aiCalls,
      specialistRuns: this.specialistRuns,
      totalTokens: input.totalTokens,
      toolCallCount: this.tools.length,
    }
    void persistRunAudit(audit)
    void recordConsumerRunBreakdown(this.aiCalls)
    return audit
  }
}

export function startRunAudit(meta: {
  userEmail?: string
  symbol?: string
  message: string
  intent?: string
}): RunAuditBuilder {
  const b = new RunAuditBuilder(meta)
  currentBuilder = b
  return b
}

export function getCurrentRunAudit(): RunAuditBuilder | null {
  return currentBuilder
}

export function clearCurrentRunAudit(): void {
  currentBuilder = null
  currentAiCallEmit = null
}

async function persistRunAudit(audit: AgentRunAudit): Promise<void> {
  const payload = JSON.stringify(audit)
  const redis = getRedis()
  if (redis) {
    try {
      await redis.lpush(RECENT_LIST_KEY, payload)
      await redis.ltrim(RECENT_LIST_KEY, 0, RECENT_MAX - 1)
      await redis.expire(RECENT_LIST_KEY, META_TTL_SEC)
      return
    } catch (err) {
      console.warn('[run-audit] redis persist failed:', err)
    }
  }
  localRecent.unshift(audit)
  if (localRecent.length > RECENT_MAX) {
    localRecent.length = RECENT_MAX
  }
}

export async function getRecentAgentRuns(limit = 15): Promise<AgentRunAudit[]> {
  const redis = getRedis()
  if (redis) {
    try {
      const rows = await redis.lrange<string>(RECENT_LIST_KEY, 0, Math.max(0, limit - 1))
      const out: AgentRunAudit[] = []
      for (const row of rows) {
        try {
          const parsed = typeof row === 'string' ? (JSON.parse(row) as AgentRunAudit) : row
          if (parsed?.id) out.push(parsed)
        } catch {
          /* skip */
        }
      }
      if (out.length > 0) return out
    } catch {
      /* fall through */
    }
  }
  return localRecent.slice(0, limit)
}
