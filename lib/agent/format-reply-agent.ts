/**
 * Client-safe reply formatter - cleans raw model prose for AgentMarkdown.
 *
 * Content-driven only: preserves the AI's structure when it already works,
 * and applies minimal fixes (asterisks, duplicate setup rows, loose bullets).
 */

import { sanitizePublicReply } from '@/lib/agent/orchestrator/defense'
import { scrubNoisyDecimals } from '@/lib/format-market-price'
import {
  needsReplyPolish,
  replyContainsLeakedJson,
  stripEmphasisTokens,
  stripLeakedMarketJson,
  unescapeReplyText,
} from '@/lib/reply-text-cleanup'
import type { MarketChatResponse, MarketChatSetup } from '@/lib/parse-market-chat-json'

export { stripEmphasisTokens } from '@/lib/reply-text-cleanup'

export type ReplyFormatShape =
  | 'conversational'
  | 'setup_with_card'
  | 'setup_narrative'
  | 'structured'
  | 'mixed'

export type FormatReplyOptions = {
  setup?: MarketChatSetup | null
  hasSetupCard?: boolean
  intent?: string
  responseMode?: string
  deterministicOnly?: boolean
  userEmail?: string
  taskTags?: string[]
}

const SETUP_FIELD_LABEL_RES =
  /^(bias|entry\s*type|entry|trigger\s*zone|stop\s*loss|stop|take\s*profit|target|invalidation|confidence|timeframe|confirmation|valid\s*until)\b/i

function isSetupFieldLine(line: string): boolean {
  const trimmed = line.trim()
  const kv = /^([^:|]{2,40}):\s+(.+)$/.exec(trimmed)
  if (!kv) return false
  return SETUP_FIELD_LABEL_RES.test(kv[1].trim())
}

function hasStructuredMarkdown(text: string): boolean {
  return (
    /^#{1,4}\s/m.test(text) ||
    /^\s*[-*•]\s+/m.test(text) ||
    /^\s*\d+[.)]\s+/m.test(text) ||
    /^\s*>\s+/m.test(text) ||
    (/\|.+\|/.test(text) && /[-:]{3,}/.test(text))
  )
}

export function classifyReplyShape(text: string, opts: FormatReplyOptions): ReplyFormatShape {
  if (opts.responseMode === 'conversational' || opts.intent === 'conversational') {
    return 'conversational'
  }
  if (opts.hasSetupCard || (opts.setup && opts.setup.bias)) {
    return 'setup_with_card'
  }
  const setupFieldLines = text.split('\n').filter((l) => l.trim() && isSetupFieldLine(l.trim())).length
  if (setupFieldLines >= 3 && !hasStructuredMarkdown(text)) return 'setup_narrative'
  if (hasStructuredMarkdown(text)) return 'structured'
  return 'mixed'
}

function dedupeSetupFields(lines: string[], shape: ReplyFormatShape): string[] {
  if (shape !== 'setup_with_card') return lines
  return lines.filter((line) => {
    const trimmed = line.trim()
    if (!trimmed) return true
    return !isSetupFieldLine(trimmed)
  })
}

function normalizeLine(line: string): string {
  let trimmed = line.trimEnd()
  const t = trimmed.trim()

  if (t === '---' || t === '***' || t === '___') return ''

  if (/^[*•]\s+/.test(t)) return trimmed.replace(/^\s*[*•]\s+/, '- ')
  if (/^\*\s+\S/.test(t)) return trimmed.replace(/^\s*\*\s+/, '- ')

  trimmed = stripEmphasisTokens(trimmed)

  // "# Title" → "### Title" (renderer supports h2–h4 via ###)
  const h1 = /^#\s+(.+)$/.exec(trimmed.trim())
  if (h1 && !/^##/.test(trimmed.trim())) {
    return `### ${h1[1].trim()}`
  }

  return trimmed
}

function groupSetupNarrative(lines: string[]): string[] {
  const kv: string[] = []
  const prose: string[] = []

  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (isSetupFieldLine(t)) kv.push(t)
    else prose.push(t.startsWith('- ') ? t : t)
  }

  if (kv.length === 0) return lines

  const out: string[] = [...prose]
  if (out.length && kv.length) out.push('')
  out.push(...kv)
  return out
}

function collapseBlankLines(lines: string[]): string[] {
  const out: string[] = []
  let prevBlank = false
  for (const line of lines) {
    const blank = line.trim() === ''
    if (blank && prevBlank) continue
    out.push(line)
    prevBlank = blank
  }
  return out
}

export function needsFormattingPolish(text: string): boolean {
  return needsReplyPolish(text) || replyContainsLeakedJson(text)
}

/**
 * Clean reply text while preserving the model's chosen structure when possible.
 */
export function formatAgentReplyText(text: string, opts: FormatReplyOptions = {}): string {
  if (!text?.trim()) return text

  const shape = classifyReplyShape(text, opts)
  let cleaned = stripLeakedMarketJson(stripEmphasisTokens(unescapeReplyText(text)))
  let lines = cleaned.replace(/\r\n/g, '\n').split('\n')

  lines = dedupeSetupFields(lines, shape)
  lines = lines.map(normalizeLine)
  lines = collapseBlankLines(lines)

  if (shape === 'setup_narrative') {
    lines = groupSetupNarrative(lines)
  }

  let joined = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  joined = stripEmphasisTokens(joined)
  joined = stripLeakedMarketJson(joined)

  if (!joined.trim() && opts.hasSetupCard) {
    if (opts.setup?.confirmation?.trim()) {
      joined = opts.setup.confirmation.trim()
    } else if (opts.setup?.triggerCondition?.trim()) {
      joined = opts.setup.triggerCondition.trim()
    } else {
      joined = 'Trade setup is in the card below - entry, stop, and target are plotted for the chart.'
    }
  }

  return sanitizePublicReply(scrubNoisyDecimals(joined))
}

export function formatMarketChatReplySync(
  response: MarketChatResponse,
  opts: FormatReplyOptions = {}
): MarketChatResponse {
  const hasSetupCard = Boolean(
    opts.hasSetupCard ??
      (response.setup &&
        (response.setup.bias === 'BUY' ||
          response.setup.bias === 'SELL' ||
          response.setup.bias === 'WAIT' ||
          response.setup.entry != null))
  )

  const reply = formatAgentReplyText(response.reply, {
    ...opts,
    setup: response.setup ?? opts.setup,
    hasSetupCard,
  })

  return reply === response.reply ? response : { ...response, reply }
}
