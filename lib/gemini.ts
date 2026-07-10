/**
 * Server-only Gemini config. Import only from API routes / server code.
 *
 * Supports a POOL of API keys for higher free-tier throughput:
 *   GEMINI_API_KEY           - primary
 *   GEMINI_API_KEY_2         - backup 1
 *   GEMINI_API_KEY_3         - backup 2
 *   GEMINI_API_KEY_4         - backup 3
 *   GEMINI_API_KEYS          - comma-separated alternative (single env var)
 *   GOOGLE_GENERATIVE_AI_API_KEY - legacy alias for primary
 *   NEXT_PUBLIC_GEMINI_API_KEY  - dev-only legacy fallback
 *
 * In production set GEMINI_API_KEY{,_2,_3,_4} or GEMINI_API_KEYS only.
 */

/**
 * Chart image analysis. Prefer flash-lite on free tier (separate quota from
 * gemini-2.5-flash). Override with GEMINI_MODEL in .env.local if needed.
 */
export const GEMINI_MODEL =
  process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash'

/**
 * Preferred market-chat / agent model. Probed against your key pool - if
 * gemini-2.5-flash-lite hits 429, set GEMINI_CHAT_MODEL=gemini-2.5-flash in
 * .env.local (see scripts/probe-gemini-models.mjs).
 */
export const GEMINI_CHAT_MODEL =
  process.env.GEMINI_CHAT_MODEL?.trim() || 'gemini-2.5-flash'

/**
 * Tried in order when the primary model returns 503/429/404.
 * Note: gemini-3-flash (no suffix) 404s on v1beta - use gemini-3-flash-preview.
 */
export const GEMINI_CHAT_MODEL_FALLBACKS = [
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
] as const

/** Deduplicated model list for agent loops (primary first). */
export function getGeminiChatModels(): string[] {
  const ordered = [GEMINI_CHAT_MODEL, ...GEMINI_CHAT_MODEL_FALLBACKS]
  return [...new Set(ordered)]
}

/**
 * Lean model chain for the multi-pass agent loop - skips models that usually
 * share the same exhausted quota as gemini-2.5-flash on free tier.
 */
export const GEMINI_AGENT_MODEL_FALLBACKS = [
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
] as const

export function getGeminiAgentModels(): string[] {
  const csv = process.env.GEMINI_AGENT_MODELS?.trim()
  if (csv) {
    return [...new Set(csv.split(',').map((m) => m.trim()).filter(Boolean))]
  }
  const ordered = [GEMINI_CHAT_MODEL, ...GEMINI_AGENT_MODEL_FALLBACKS]
  return [...new Set(ordered)]
}

/** Lean chain for pipeline specialists - flash-lite only unless overridden. */
export function getGeminiSpecialistModels(): string[] {
  const csv = process.env.GEMINI_SPECIALIST_MODELS?.trim()
  if (csv) {
    return [...new Set(csv.split(',').map((m) => m.trim()).filter(Boolean))]
  }
  return [GEMINI_CHAT_MODEL]
}

export function getGeminiGenerateUrl(model: string = GEMINI_MODEL): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
}

function pushUnique(out: string[], key: string | undefined | null): void {
  const trimmed = key?.trim()
  if (trimmed && !out.includes(trimmed)) out.push(trimmed)
}

/**
 * Resolve ALL configured Gemini API keys, in priority order.
 * Use this when you want to rotate / failover across keys.
 */
export function getGeminiApiKeys(): string[] {
  const keys: string[] = []

  pushUnique(keys, process.env.GEMINI_API_KEY)
  pushUnique(keys, process.env.GOOGLE_GENERATIVE_AI_API_KEY)
  pushUnique(keys, process.env.GEMINI_API_KEY_2)
  pushUnique(keys, process.env.GEMINI_API_KEY_3)
  pushUnique(keys, process.env.GEMINI_API_KEY_4)
  pushUnique(keys, process.env.GEMINI_API_KEY_5)

  const csv = process.env.GEMINI_API_KEYS?.trim()
  if (csv) {
    for (const k of csv.split(',')) pushUnique(keys, k)
  }

  if (!keys.length && process.env.NODE_ENV !== 'production') {
    const legacy = process.env.NEXT_PUBLIC_GEMINI_API_KEY?.trim()
    if (legacy) {
      console.warn(
        '[gemini] Using NEXT_PUBLIC_GEMINI_API_KEY on the server. Move the value to GEMINI_API_KEY in .env.local.'
      )
      keys.push(legacy)
    }
  }

  return keys
}

/** Returns the highest-priority key (or undefined if none configured). */
export function getGeminiApiKey(): string | undefined {
  return getGeminiApiKeys()[0]
}

export function isGeminiConfigured(): boolean {
  return getGeminiApiKeys().length > 0
}

/**
 * Tiny in-memory round-robin counter so two concurrent requests don't
 * always start on the same key. Resets per Node process.
 */
let rotationOffset = 0
export function nextGeminiKeyOffset(): number {
  rotationOffset = (rotationOffset + 1) % 1024
  return rotationOffset
}
