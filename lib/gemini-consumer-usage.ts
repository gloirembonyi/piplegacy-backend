/**
 * Per-consumer Gemini token stats for admin (avg per chat question + daily totals).
 */

import type { AgentRunAudit } from '@/lib/agent/run-audit'
import {
  GEMINI_RUNTIME_CONSUMERS,
  GEMINI_TOOL_CONSUMERS,
  geminiSourceLabel,
  listGeminiConsumersForAdmin,
} from '@/lib/gemini-consumers'
import { addUsageAmount, readUsageAmount } from '@/lib/rate-limit'

const DAY_SEC = 86_400

function utcDay(offset = 0): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - offset)
  return d.toISOString().slice(0, 10)
}

function tokensKey(consumerId: string, day: string): string {
  return `gemini:consumer:tokens:${consumerId}:${day}`
}

function callsKey(consumerId: string, day: string): string {
  return `gemini:consumer:calls:${consumerId}:${day}`
}

function runsKey(consumerId: string, day: string): string {
  return `gemini:consumer:runs:${consumerId}:${day}`
}

/** Normalize audit / tracking source → consumer id. */
export function normalizeConsumerId(source: string): string {
  if (source === 'agent') return 'main_agent'
  return source
}

/** Persist one Gemini call for a consumer (fire-and-forget safe). */
export async function recordConsumerTokenUsage(
  source: string,
  tokens: number
): Promise<void> {
  const id = normalizeConsumerId(source)
  const day = utcDay(0)
  await addUsageAmount(callsKey(id, day), 1, DAY_SEC)
  if (tokens > 0) {
    await addUsageAmount(tokensKey(id, day), Math.round(tokens), DAY_SEC)
  }
}

/** After an agent run finishes - count which layers participated. */
export async function recordConsumerRunBreakdown(aiCalls: AgentRunAudit['aiCalls']): Promise<void> {
  const day = utcDay(0)
  const used = new Set<string>()
  for (const call of aiCalls) {
    used.add(normalizeConsumerId(call.source))
  }
  await Promise.all(
    [...used].map((id) => addUsageAmount(runsKey(id, day), 1, DAY_SEC))
  )
}

export type ConsumerPeriodUsage = {
  tokens: number
  calls: number
  runs: number
}

async function readPeriodUsage(consumerId: string, days: number): Promise<ConsumerPeriodUsage> {
  let tokens = 0
  let calls = 0
  let runs = 0
  for (let i = 0; i < days; i++) {
    const day = utcDay(i)
    const [t, c, r] = await Promise.all([
      readUsageAmount(tokensKey(consumerId, day)),
      readUsageAmount(callsKey(consumerId, day)),
      readUsageAmount(runsKey(consumerId, day)),
    ])
    tokens += t
    calls += c
    runs += r
  }
  return { tokens, calls, runs }
}

type SampleAgg = {
  tokensInRuns: number
  runCount: number
  callCount: number
  tokensInCalls: number
}

function aggregateFromRecentRuns(recentRuns: AgentRunAudit[]): Map<string, SampleAgg> {
  const map = new Map<string, SampleAgg>()

  const bump = (id: string, runTokens: number, calls: number, callTokens: number) => {
    const prev = map.get(id) ?? {
      tokensInRuns: 0,
      runCount: 0,
      callCount: 0,
      tokensInCalls: 0,
    }
    prev.tokensInRuns += runTokens
    prev.runCount += 1
    prev.callCount += calls
    prev.tokensInCalls += callTokens
    map.set(id, prev)
  }

  for (const run of recentRuns) {
    const bySource = new Map<string, { runTokens: number; calls: number; callTokens: number }>()

    for (const call of run.aiCalls) {
      const id = normalizeConsumerId(call.source)
      const t = call.tokens ?? 0
      const row = bySource.get(id) ?? { runTokens: 0, calls: 0, callTokens: 0 }
      row.runTokens += t
      row.calls += 1
      row.callTokens += t
      bySource.set(id, row)
    }

    const usedConfluence = run.tools.some((t) => t.tool === 'run_specialist_confluence')
    if (usedConfluence) {
      const spec = bySource.get('specialist')
      if (spec && spec.runTokens > 0) {
        bump('tool:run_specialist_confluence', spec.runTokens, spec.calls, spec.callTokens)
        bySource.delete('specialist')
      }
    }

    for (const [id, stats] of bySource) {
      bump(id, stats.runTokens, stats.calls, stats.callTokens)
    }
  }

  return map
}

/** Sum tokens from recent audits (UTC day filter) when Redis counters are still empty. */
function tokensFromRecentRuns(
  recentRuns: AgentRunAudit[],
  consumerId: string,
  maxDays: number
): { tokens: number; calls: number } {
  const allowedDays = new Set<string>()
  for (let i = 0; i < maxDays; i++) allowedDays.add(utcDay(i))

  let tokens = 0
  let calls = 0

  for (const run of recentRuns) {
    const day = run.finishedAt.slice(0, 10)
    if (!allowedDays.has(day)) continue

    let runTokens = 0
    let runCalls = 0
    const bySource = new Map<string, number>()

    for (const call of run.aiCalls) {
      const id = normalizeConsumerId(call.source)
      bySource.set(id, (bySource.get(id) ?? 0) + (call.tokens ?? 0))
      if (id === consumerId) runCalls += 1
    }

    const usedConfluence = run.tools.some((t) => t.tool === 'run_specialist_confluence')
    if (usedConfluence && consumerId === 'tool:run_specialist_confluence') {
      runTokens = bySource.get('specialist') ?? 0
      runCalls = run.aiCalls.filter((c) => normalizeConsumerId(c.source) === 'specialist').length
    } else if (usedConfluence && consumerId === 'specialist') {
      runTokens = 0
      runCalls = 0
    } else {
      runTokens = bySource.get(consumerId) ?? 0
    }

    tokens += runTokens
    calls += runCalls
  }

  return { tokens, calls }
}

export type GeminiConsumerUsageRow = {
  id: string
  label: string
  kind: 'chat_runtime' | 'chat_tool' | 'chart_scan' | 'other'
  description: string
  toolName?: string
  inChatLoop: boolean
  inChartScan: boolean
  /** Avg tokens this layer uses per chat question (when invoked), recent sample */
  avgTokensPerQuestion: number | null
  /** Avg tokens per individual Gemini API call */
  avgTokensPerCall: number | null
  /** Chat questions in sample that used this layer */
  questionsSampled: number
  tokensToday: number
  tokens7d: number
  callsToday: number
  calls7d: number
  runsToday: number
  runs7d: number
}

export type GeminiConsumerUsageReport = {
  dataToolsNote: string
  summary: {
    sampleQuestions: number
    avgTotalTokensPerQuestion: number | null
    tokensToday: number
    tokens7d: number
    geminiCallsToday: number
    geminiCalls7d: number
  }
  rows: GeminiConsumerUsageRow[]
  chartScanSpecialists: Array<{ id: string; label: string; note: string }>
}

function avg(n: number, d: number): number | null {
  if (d <= 0) return null
  return Math.round(n / d)
}

export async function buildGeminiConsumerUsageReport(
  recentRuns: AgentRunAudit[]
): Promise<GeminiConsumerUsageReport> {
  const catalog = listGeminiConsumersForAdmin()
  const sample = aggregateFromRecentRuns(recentRuns)

  const consumerDefs = [
    ...catalog.runtime.map((c) => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      description: c.description,
      toolName: c.toolName,
      inChatLoop: c.inChatLoop,
      inChartScan: c.inChartScan,
    })),
    ...catalog.tools.map((c) => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      description: c.description,
      toolName: c.toolName,
      inChatLoop: c.inChatLoop,
      inChartScan: c.inChartScan,
    })),
  ]

  const seen = new Set<string>()
  const uniqueDefs = consumerDefs.filter((c) => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })

  const rows: GeminiConsumerUsageRow[] = []

  for (const def of uniqueDefs) {
    const [today, last7d] = await Promise.all([
      readPeriodUsage(def.id, 1),
      readPeriodUsage(def.id, 7),
    ])
    const samp = sample.get(def.id)
    const backfillToday = tokensFromRecentRuns(recentRuns, def.id, 1)
    const backfill7d = tokensFromRecentRuns(recentRuns, def.id, 7)

    rows.push({
      ...def,
      avgTokensPerQuestion: samp ? avg(samp.tokensInRuns, samp.runCount) : null,
      avgTokensPerCall: samp ? avg(samp.tokensInCalls, samp.callCount) : null,
      questionsSampled: samp?.runCount ?? 0,
      tokensToday: Math.max(today.tokens, backfillToday.tokens),
      tokens7d: Math.max(last7d.tokens, backfill7d.tokens),
      callsToday: Math.max(today.calls, backfillToday.calls),
      calls7d: Math.max(last7d.calls, backfill7d.calls),
      runsToday: today.runs,
      runs7d: last7d.runs,
    })
  }

  rows.sort((a, b) => b.tokens7d - a.tokens7d || b.tokensToday - a.tokensToday)

  const chatRows = rows.filter((r) => r.inChatLoop)
  let tokensToday = 0
  let tokens7d = 0
  let callsToday = 0
  let calls7d = 0
  for (const r of chatRows) {
    tokensToday += r.tokensToday
    tokens7d += r.tokens7d
    callsToday += r.callsToday
    calls7d += r.calls7d
  }

  const questionsWithTokens = recentRuns.filter((r) => r.totalTokens > 0)
  const avgTotalTokensPerQuestion =
    questionsWithTokens.length > 0
      ? Math.round(
          questionsWithTokens.reduce((n, r) => n + r.totalTokens, 0) /
            questionsWithTokens.length
        )
      : null

  return {
    dataToolsNote: catalog.dataToolsNote,
    summary: {
      sampleQuestions: recentRuns.length,
      avgTotalTokensPerQuestion,
      tokensToday,
      tokens7d,
      geminiCallsToday: callsToday,
      geminiCalls7d: calls7d,
    },
    rows,
    chartScanSpecialists: catalog.chartScanSpecialists.map((s) => ({
      ...s,
      note: 'Tokens roll up under Specialist lens unless confluence tool is used in chat.',
    })),
  }
}

/** Human label for any raw source id (admin tables). */
export function consumerDisplayLabel(id: string): string {
  if (id.startsWith('tool:')) {
    const tool = id.replace('tool:', '')
    return GEMINI_TOOL_CONSUMERS.find((c) => c.toolName === tool)?.label ?? tool
  }
  const runtime = GEMINI_RUNTIME_CONSUMERS.find((c) => c.id === id)
  if (runtime) return runtime.label
  return geminiSourceLabel(id)
}
