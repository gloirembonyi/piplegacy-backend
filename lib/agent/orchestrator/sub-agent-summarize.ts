/**
 * Gemini summaries for sub-agent scout briefs (replaces string-concat summaries).
 */

import {
  callSpecialistModel,
  parseJsonish,
} from '@/lib/agent/specialists/helpers'
import type { ToolTraceEntry } from '@/lib/ai-tools/types'
import type { SubAgentId } from './types'

const AGENT_LABELS: Record<SubAgentId, string> = {
  setup: 'Structure scout',
  research: 'Web & news scout',
  macro: 'Macro scout',
  discovery: 'Symbol scout',
  verification: 'Price verification scout',
  liquidity: 'Smart-money liquidity scout',
}

const SYSTEM = `You are a trading desk summarizer. Given raw scout data JSON, write ONE strict JSON object:
{"summary":"<=160 chars - what was found, plain English, no tool names","headline":"<=80 chars key takeaway"}

Be specific with numbers (RSI, price, swing levels, headlines). If data is empty, say what is missing.`

function trimJson(data: unknown, maxLen = 4000): string {
  const s = JSON.stringify(data, null, 0)
  if (s.length <= maxLen) return s
  return `${s.slice(0, maxLen)}…`
}

export async function summarizeSubAgentWithGemini(opts: {
  agentId: SubAgentId
  data: Record<string, unknown>
  trace: ToolTraceEntry[]
  userMessage: string
  symbolLabel?: string
  fallback: string
}): Promise<string> {
  if (
    process.env.AGENT_SCOUT_DETERMINISTIC === '1' ||
    process.env.AGENT_SCOUT_DETERMINISTIC === 'true' ||
    opts.fallback.trim().length >= 48
  ) {
    return opts.fallback
  }

  const toolLines = opts.trace
    .filter((t) => t.ok && t.summary)
    .slice(0, 6)
    .map((t) => `${t.tool}: ${t.summary}`)
    .join('\n')

  const userPrompt = `Scout: ${AGENT_LABELS[opts.agentId]}
User question: "${opts.userMessage.slice(0, 120)}"
Symbol: ${opts.symbolLabel ?? 'n/a'}
Tool results:
${toolLines || '(none)'}
Data JSON:
${trimJson(opts.data)}

Return ONLY the JSON object.`

  const r = await callSpecialistModel({
    systemPrompt: SYSTEM,
    userPrompt,
    maxTokens: 256,
    temperature: 0.2,
    source: 'sub_agent_summarize',
  })

  if (r.ok) {
    const parsed = parseJsonish<{ summary?: string; headline?: string }>(r.text, {})
    const summary = parsed.summary?.trim()
    if (summary) return summary
    if (parsed.headline?.trim()) return parsed.headline.trim()
  }

  return opts.fallback
}
