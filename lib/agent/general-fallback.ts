/**
 * Synthesize user-facing replies from web research when the main LLM fails
 * on general-knowledge questions (e.g. "what is kigali").
 */

import type { MarketChatResponse } from '@/lib/parse-market-chat-json'
import type { SubAgentBrief } from '@/lib/agent/orchestrator/types'
import { sanitizePublicReply } from '@/lib/agent/orchestrator/defense'

type WebHit = { title?: string; snippet?: string; url?: string; source?: string }

function extractHits(data: unknown): WebHit[] {
  if (!data || typeof data !== 'object') return []
  const d = data as { results?: WebHit[] }
  return Array.isArray(d.results) ? d.results : []
}

export function buildGeneralReplyFromResearch(
  briefs: SubAgentBrief[] | undefined,
  userMessage: string
): MarketChatResponse | null {
  const research = briefs?.find((b) => b.id === 'research')
  if (!research?.data) return null

  const hits: WebHit[] = [
    ...extractHits(research.data.internet),
    ...extractHits(research.data.web),
    ...extractHits(research.data.news),
  ]

  const unique = hits.filter(
    (h, i, arr) =>
      h.title &&
      arr.findIndex((x) => x.title === h.title && x.snippet === h.snippet) === i
  )

  if (unique.length === 0) return null

  const title = userMessage.trim().endsWith('?')
    ? userMessage.trim().slice(0, -1)
    : userMessage.trim()

  const lines = [
    `### ${title.charAt(0).toUpperCase()}${title.slice(1)}`,
    '',
    ...unique.slice(0, 5).map((h) => {
      const snippet = (h.snippet ?? '').trim().slice(0, 280)
      const src = h.source ? ` (${h.source})` : ''
      return snippet
        ? `- **${h.title}**${src}: ${snippet}${snippet.length >= 280 ? '…' : ''}`
        : `- **${h.title}**${src}`
    }),
  ]

  return {
    reply: sanitizePublicReply(lines.join('\n')),
    setup: null,
    levels: [],
    zones: [],
    drawIntent: null,
  }
}
