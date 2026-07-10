/**
 * Server-only DeepSeek config. DeepSeek is the FALLBACK AI provider:
 * when every Gemini key in the pool is cooling, the agent loop seamlessly
 * switches to DeepSeek (OpenAI-compatible API + function calling) so the
 * trading agent keeps working with zero perceived downtime.
 *
 * Env vars (server-only):
 *   DEEPSEEK_API_KEY        - primary
 *   DEEPSEEK_API_KEY_2      - backup 1
 *   DEEPSEEK_API_KEY_3      - backup 2
 *   DEEPSEEK_API_KEYS       - comma-separated alternative
 *   DEEPSEEK_API_BASE       - override base URL (default https://api.deepseek.com)
 */

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** Preferred DeepSeek chat model - supports tools / function calling. */
export const DEEPSEEK_CHAT_MODEL = 'deepseek-chat'

/**
 * Tried in order when the primary model returns 503/429/404. Order matters:
 * deepseek-chat first (general purpose + function calling), then reasoner
 * as a last-resort text-only fallback (no tool use).
 */
export const DEEPSEEK_CHAT_MODEL_FALLBACKS = [
  'deepseek-chat',
  'deepseek-reasoner',
] as const

export function getDeepseekBaseUrl(): string {
  const override = process.env.DEEPSEEK_API_BASE?.trim()
  return (override || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '')
}

export function getDeepseekChatUrl(): string {
  return `${getDeepseekBaseUrl()}/v1/chat/completions`
}

function pushUnique(out: string[], key: string | undefined | null): void {
  const trimmed = key?.trim()
  if (trimmed && !out.includes(trimmed)) out.push(trimmed)
}

/** All configured DeepSeek API keys, in priority order. */
export function getDeepseekApiKeys(): string[] {
  const keys: string[] = []

  pushUnique(keys, process.env.DEEPSEEK_API_KEY)
  pushUnique(keys, process.env.DEEPSEEK_API_KEY_2)
  pushUnique(keys, process.env.DEEPSEEK_API_KEY_3)
  pushUnique(keys, process.env.DEEPSEEK_API_KEY_4)

  const csv = process.env.DEEPSEEK_API_KEYS?.trim()
  if (csv) {
    for (const k of csv.split(',')) pushUnique(keys, k)
  }

  // Lowercase legacy alias - accept it for compatibility with .env files
  // that were written with the lowercase form before we standardised.
  pushUnique(keys, process.env.deepseek_api_key as string | undefined)
  pushUnique(keys, process.env.deepseek_api_key_2 as string | undefined)

  return keys
}

export function isDeepseekConfigured(): boolean {
  return getDeepseekApiKeys().length > 0
}
