/**
 * Client-safe text cleanup for agent replies (no server dependencies).
 */

export function unescapeReplyText(text: string): string {
  if (!text.includes('\\n') && !text.includes('\\"') && !text.includes('\\t')) {
    return text
  }
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
}

function titleCaseLabel(raw: string): string {
  const t = raw.trim().replace(/\s+/g, ' ')
  if (!t) return t
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
}

/** Normalize emphasis the UI cannot render (*, **). */
export function stripEmphasisTokens(text: string): string {
  return text
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/^\*([^*\n]{1,48})\*:\s*/gm, (_, label: string) => `${titleCaseLabel(label)}: `)
    .replace(/(^|\s)\*([^*\n]+?)\*(\s|$|[.,;:!?])/g, '$1$2$3')
    .replace(/^\*\s*(.+)$/gm, '- $1')
}

export const BANNED_REPLY_PATTERN_RES = [
  /\*\*[^*\n]+\*\*/,
  /(?:^|\s)\*[^*\n]+\*(?:\s|:|$)/,
  /^\s*[*•]\s+/m,
  /[\u{1F300}-\u{1FAFF}]/u,
  /```(?:json)?/i,
  /^\s*[\[{][\s\S]*?"(?:bias|entryType|stopLoss|takeProfit|drawIntent)"\s*:/m,
  /^\s*"(?:bias|entryType|entry|stopLoss|takeProfit|triggerZone|invalidation|kind|drawIntent)"\s*:/m,
]

const MARKET_JSON_KEY_RE =
  /"(?:bias|entryType|entry|stopLoss|takeProfit|triggerZone|invalidation|drawIntent|drawing\s*request|levels|zones|kind|top|bottom|price)"\s*:/i

/** True when a JSON blob belongs in setup/levels/zones - not user-facing prose. */
export function looksLikeMarketDataJson(blob: string): boolean {
  const t = blob.trim()
  if (!t) return false
  if (!(t.startsWith('{') || t.startsWith('['))) return false
  return MARKET_JSON_KEY_RE.test(t)
}

/** Remove setup/zone/level JSON the model leaked into the reply string. */
export function stripLeakedMarketJson(text: string): string {
  if (!text?.trim()) return text

  let out = text.replace(/\r\n/g, '\n')

  out = out.replace(/```(?:json)?\s*([\s\S]*?)```/gi, (full, inner: string) =>
    looksLikeMarketDataJson(inner) ? '\n' : full
  )

  const chars: string[] = []
  let i = 0
  while (i < out.length) {
    if (out[i] === '{') {
      let depth = 0
      let j = i
      for (; j < out.length; j++) {
        if (out[j] === '{') depth++
        else if (out[j] === '}') {
          depth--
          if (depth === 0) {
            j++
            break
          }
        }
      }
      const blob = out.slice(i, j)
      if (looksLikeMarketDataJson(blob)) {
        i = j
        continue
      }
    }
    chars.push(out[i]!)
    i++
  }
  out = chars.join('')

  out = out
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      if (t === '{' || t === '}' || t === '},' || t === '],' || t === '[' || t === ']') return false
      if (/^[\[{]/.test(t) && MARKET_JSON_KEY_RE.test(t)) return false
      if (/^"?(?:bias|entryType|entry|stopLoss|takeProfit|triggerZone|invalidation|confidence|drawIntent|drawing\s*request)"?\s*:/i.test(t)) {
        return false
      }
      if (/^"(?:kind|label|top|bottom|price)"\s*:/.test(t)) return false
      return true
    })
    .join('\n')

  return out.replace(/\n{3,}/g, '\n\n').trim()
}

export function replyContainsLeakedJson(text: string): boolean {
  if (!text?.trim()) return false
  if (/```(?:json)?/i.test(text) && MARKET_JSON_KEY_RE.test(text)) return true
  if (looksLikeMarketDataJson(text.trim())) return true
  return stripLeakedMarketJson(text) !== text.trim()
}

export function needsReplyPolish(text: string): boolean {
  if (!text?.trim()) return false
  return BANNED_REPLY_PATTERN_RES.some((re) => re.test(text))
}
