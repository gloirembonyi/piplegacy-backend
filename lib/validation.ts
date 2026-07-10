import { FINNHUB_SYMBOL_RE, normalizeSymbol } from '@/lib/symbols'

export function parseSymbolList(
  input: string,
  max = 20
): string[] | null {
  const symbols = input
    .split(',')
    .map((s) => normalizeSymbol(s))
    .filter(Boolean)

  if (symbols.length === 0 || symbols.length > max) return null
  if (!symbols.every((s) => FINNHUB_SYMBOL_RE.test(s))) return null
  return [...new Set(symbols)]
}

export const MAX_CHART_IMAGE_CHARS = 1_500_000

const MAX_CHAT_MESSAGE = 2000
const MAX_CHAT_HISTORY = 10
const MAX_CHAT_HISTORY_CONTENT = 4000

export type ChatHistoryItem = { role: 'user' | 'assistant'; content: string }

export function parseChatHistory(input: unknown): ChatHistoryItem[] {
  if (!Array.isArray(input)) return []
  const out: ChatHistoryItem[] = []
  for (const item of input.slice(-MAX_CHAT_HISTORY)) {
    if (
      item &&
      typeof item === 'object' &&
      (item.role === 'user' || item.role === 'assistant') &&
      typeof item.content === 'string' &&
      item.content.trim().length > 0 &&
      item.content.length <= MAX_CHAT_HISTORY_CONTENT
    ) {
      out.push({ role: item.role, content: item.content.trim() })
    }
  }
  return out
}

export function isValidChatMessage(message: unknown): message is string {
  return (
    typeof message === 'string' &&
    message.trim().length >= 1 &&
    message.trim().length <= MAX_CHAT_MESSAGE
  )
}

export function isValidChartImagePayload(image: unknown): image is string {
  return (
    typeof image === 'string' &&
    image.startsWith('data:image/') &&
    image.includes('base64,') &&
    image.length <= MAX_CHART_IMAGE_CHARS &&
    image.length >= 200
  )
}

const MAX_CHAT_IMAGES = 3
const MAX_CHAT_IMAGE_CHARS = 1_500_000
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export type ChatImage = { mimeType: string; data: string }

/**
 * Parse and validate base64 image attachments from the chat request.
 * Strips the `data:...;base64,` prefix and returns clean { mimeType, data }.
 */
export function parseChatImages(input: unknown): ChatImage[] {
  if (!Array.isArray(input)) return []
  const out: ChatImage[] = []
  for (const item of input.slice(0, MAX_CHAT_IMAGES)) {
    if (!item || typeof item !== 'object') continue
    const raw = (item as { dataUrl?: unknown; data?: unknown; mimeType?: unknown })
    let mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : ''
    let data = ''

    if (typeof raw.dataUrl === 'string') {
      const url = raw.dataUrl
      if (url.length > MAX_CHAT_IMAGE_CHARS || !url.startsWith('data:image/')) continue
      const semi = url.indexOf(';base64,')
      if (semi < 0) continue
      mimeType = url.slice(5, semi)
      data = url.slice(semi + ';base64,'.length)
    } else if (typeof raw.data === 'string' && mimeType) {
      data = raw.data
    }

    if (!ALLOWED_IMAGE_MIMES.has(mimeType)) continue
    if (!data || data.length < 100 || data.length > MAX_CHAT_IMAGE_CHARS) continue
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) continue

    out.push({ mimeType, data })
  }
  return out
}
