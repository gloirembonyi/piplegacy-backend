/**
 * Session memory - compact recap of recent turns injected into the agent prompt
 * so chart / insights agents stay coherent across messages in the same scope.
 *
 * Long threads: older turns collapse into a brief summary; last N turns stay verbatim
 * (claw-code-parity compaction pattern, rule-based - no extra LLM call).
 */

import type { StoredChatMessage } from '@/lib/user-types'

function compactLine(content: string, maxLen = 120): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, maxLen)
}

/** Rule-based summary of older turns (no LLM). */
function summarizeOlderTurns(messages: StoredChatMessage[]): string[] {
  const lines: string[] = []
  const topics = new Set<string>()
  let lastBias: string | null = null
  let userQuestions = 0

  for (const m of messages) {
    if (m.role === 'user') userQuestions++
    const c = m.content.toLowerCase()
    if (/\b(setup|entry|stop|target|long|short)\b/.test(c)) topics.add('levels/setup')
    if (/\b(news|fed|cpi|macro|calendar)\b/.test(c)) topics.add('macro/news')
    if (/\b(reversal|trap|fakeout)\b/.test(c)) topics.add('reversal')
    if (/\b(education|learn|how to|what is)\b/.test(c)) topics.add('education')
    if (m.setup && typeof m.setup === 'object') {
      const s = m.setup as { bias?: string }
      if (s.bias) lastBias = s.bias
    }
  }

  if (userQuestions > 0) {
    lines.push(`Earlier in thread: ${userQuestions} user message(s).`)
  }
  if (topics.size > 0) {
    lines.push(`Topics covered: ${[...topics].join(', ')}.`)
  }
  if (lastBias) {
    lines.push(`Last discussed bias: ${lastBias}.`)
  }
  return lines
}

export function buildSessionMemoryBlock(
  messages: StoredChatMessage[],
  opts?: { maxTurns?: number; maxChars?: number; verbatimTail?: number; compactAfter?: number }
): string {
  const maxTurns = opts?.maxTurns ?? 16
  const maxChars = opts?.maxChars ?? 2_800
  const verbatimTail = opts?.verbatimTail ?? 4
  const compactAfter = opts?.compactAfter ?? 10

  const filtered = messages.filter((m) => m.content?.trim()).slice(-maxTurns)
  if (filtered.length === 0) return ''

  const lines: string[] = [
    'SESSION MEMORY (this conversation scope - stay consistent with prior turns):',
  ]
  let used = lines[0].length

  if (filtered.length > compactAfter) {
    const older = filtered.slice(0, -verbatimTail)
    const summary = summarizeOlderTurns(older)
    for (const s of summary) {
      if (used + s.length > maxChars) break
      lines.push(s)
      used += s.length
    }
    lines.push('')
    used += 1
  }

  const recent = filtered.slice(-verbatimTail)
  for (const m of recent) {
    const prefix = m.role === 'user' ? 'User' : 'Agent'
    let line = `- ${prefix}: ${compactLine(m.content, 280)}`
    if (m.setup && typeof m.setup === 'object') {
      const s = m.setup as {
        bias?: string
        entry?: number | null
        stopLoss?: number | null
        takeProfit?: number | null
      }
      if (s.bias) line += ` [prior setup: ${s.bias}`
      if (s.entry != null) line += ` entry ${s.entry}`
      if (s.stopLoss != null) line += ` SL ${s.stopLoss}`
      if (s.takeProfit != null) line += ` TP ${s.takeProfit}`
      if (s.bias) line += ']'
    }
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length
  }

  lines.push(
    'Do not contradict prior levels/setups unless new live data invalidates them.'
  )
  return lines.join('\n')
}

/** Merge client-sent history with server-stored messages (dedupe by content tail). */
export function mergeChatHistories(
  clientHistory: { role: 'user' | 'assistant'; content: string }[],
  stored: StoredChatMessage[]
): { role: 'user' | 'assistant'; content: string }[] {
  if (stored.length === 0) return clientHistory
  if (clientHistory.length >= stored.length) return clientHistory

  const fromStored = stored.map((m) => ({
    role: m.role,
    content: m.content,
  }))

  return fromStored.length > clientHistory.length ? fromStored : clientHistory
}
