/**
 * Server-only reply formatter - optional LLM polish when deterministic cleanup is not enough.
 */

import { callSpecialistModel } from '@/lib/agent/specialists/helpers'
import type { MarketChatResponse } from '@/lib/parse-market-chat-json'
import {
  classifyReplyShape,
  formatAgentReplyText,
  formatMarketChatReplySync,
  needsFormattingPolish,
  type FormatReplyOptions,
} from '@/lib/agent/format-reply-agent'

const FORMAT_AGENT_SYSTEM = `You are the Piplegacy reply formatter. Return ONLY JSON: {"reply":"..."}.

Rewrite presentation only - never change facts, prices, bias, or trade logic.

Use whatever structure fits the draft (do NOT force one template):
- ### headings for distinct topics when helpful
- - dash bullets for lists (NEVER * or •)
- pipe tables only when comparing multiple rows
- > callouts for warnings
- \`prices\` inline (NOT **bold**)

Rules: ZERO asterisks. NO emojis. NO --- rules. NO HTML.
If a setup card shows entry/stop/target, keep reply as narrative + risks only.

Return JSON only. No markdown fences.`

function parseFormatterJson(text: string, fallback: string): string {
  const trimmed = text.trim()
  if (!trimmed) return fallback
  const candidates = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as { reply?: unknown }
      if (typeof parsed.reply === 'string' && parsed.reply.trim()) {
        return parsed.reply.trim()
      }
    } catch {
      /* try next */
    }
  }
  return fallback
}

export async function polishAgentReplyWithModel(
  draft: string,
  opts: FormatReplyOptions = {}
): Promise<string> {
  const shape = classifyReplyShape(draft, opts)
  const userPrompt = [
    `Shape hint: ${shape}`,
    opts.hasSetupCard
      ? 'Setup card is shown separately - omit entry/stop/target/bias fields from reply.'
      : '',
    opts.intent ? `Intent: ${opts.intent}` : '',
    '',
    'DRAFT:',
    draft,
  ]
    .filter(Boolean)
    .join('\n')

  const result = await callSpecialistModel({
    systemPrompt: FORMAT_AGENT_SYSTEM,
    userPrompt,
    maxTokens: 1024,
    temperature: 0.1,
    userEmail: opts.userEmail,
    source: 'format_reply',
  })

  if (!result.ok) return draft

  const polished = parseFormatterJson(result.text, draft)
  const cleaned = formatAgentReplyText(polished, { ...opts, deterministicOnly: true })
  return needsFormattingPolish(cleaned) ? formatAgentReplyText(draft, opts) : cleaned
}

/** Deterministic format, then optional LLM polish (server agent loop only). */
export async function formatMarketChatReply(
  response: MarketChatResponse,
  opts: FormatReplyOptions = {}
): Promise<MarketChatResponse> {
  let current = formatMarketChatReplySync(response, opts)

  if (opts.deterministicOnly || !needsFormattingPolish(current.reply)) {
    return formatMarketChatReplySync(current, opts)
  }

  const polished = await polishAgentReplyWithModel(current.reply, {
    ...opts,
    setup: current.setup,
    hasSetupCard: opts.hasSetupCard ?? Boolean(current.setup),
  })

  current = { ...current, reply: polished }
  return formatMarketChatReplySync(current, opts)
}
