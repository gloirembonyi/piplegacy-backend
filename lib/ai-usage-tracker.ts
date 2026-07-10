import { createHash } from 'crypto'
import { recordConsumerTokenUsage } from '@/lib/gemini-consumer-usage'
import { getCurrentRunAudit } from '@/lib/agent/run-audit'
import { addUsageAmount, readUsageAmount } from '@/lib/rate-limit'
import { getRedis } from '@/lib/redis'
import type { AiProvider } from '@/lib/gemini-keypool'

const DAY_SEC = 86_400
const RECENT_MAX = 50
const META_TTL_SEC = 7 * DAY_SEC

function utcDay(offset = 0): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - offset)
  return d.toISOString().slice(0, 10)
}

function usageKey(
  kind: 'tokens' | 'prompt' | 'completion' | 'requests' | 'failed',
  provider: AiProvider,
  keySuffix: string,
  day: string
): string {
  return `ai:${kind}:${provider}:${keySuffix}:${day}`
}

function userTokensKey(email: string, day: string): string {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)
  return `ai:user:${hash}:tokens:${day}`
}

function userLastCallKey(email: string): string {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)
  return `ai:user:${hash}:last`
}

function lastUsedKey(provider: AiProvider, keySuffix: string): string {
  return `ai:last:${provider}:${keySuffix}`
}

const RECENT_LIST_KEY = 'ai:recent'

const localLastUsed = new Map<string, AiLastUsed>()
const localRecentCalls: RecentAiCall[] = []

export type AiUsageSource =
  | 'agent'
  | 'chart'
  | 'specialist'
  | 'suggestion'
  | 'probe'
  | 'other'

const AI_SOURCE_TO_CONSUMER: Record<AiUsageSource, string> = {
  agent: 'main_agent',
  chart: 'analyze_chart',
  specialist: 'specialist',
  suggestion: 'suggestion',
  probe: 'other',
  other: 'other',
}

export type AiUsageInput = {
  provider: AiProvider
  keySuffix: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens: number
  userEmail?: string
  source?: AiUsageSource
  /** True when tokens were estimated because provider metadata was missing. */
  estimated?: boolean
}

export type AiLastUsed = {
  at: string
  model: string
  tokens: number
  provider: AiProvider
  keySuffix: string
  source?: AiUsageSource
  userEmail?: string
  estimated?: boolean
  /** Present when the last call failed before token metadata was returned. */
  failed?: boolean
  status?: number
  error?: string
}

export type RecentAiCall = AiLastUsed

type UsageMetadataLike = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  thoughtsTokenCount?: number
  toolUsePromptTokenCount?: number
  cachedContentTokenCount?: number
  prompt_token_count?: number
  candidates_token_count?: number
  total_token_count?: number
  thoughts_token_count?: number
  tool_use_prompt_token_count?: number
  cached_content_token_count?: number
}

type GeminiUsageResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
  }>
  usageMetadata?: UsageMetadataLike
  usage_metadata?: UsageMetadataLike
}

function num(...values: Array<number | undefined>): number {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v)
  }
  return 0
}

/** Rough token estimate from plain text (~4 chars per token). */
export function estimateTokensFromText(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return Math.max(1, Math.ceil(trimmed.length / 4))
}

export function extractTextFromGeminiResponse(data: GeminiUsageResponse): string {
  const parts = data.candidates?.[0]?.content?.parts ?? []
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

export function parseUsageFromGeminiResponse(data: GeminiUsageResponse): {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  thoughtsTokens: number
} {
  const meta = data.usageMetadata ?? data.usage_metadata
  const promptTokens = num(meta?.promptTokenCount, meta?.prompt_token_count)
  const completionTokens = num(meta?.candidatesTokenCount, meta?.candidates_token_count)
  const thoughtsTokens = num(meta?.thoughtsTokenCount, meta?.thoughts_token_count)
  const toolTokens = num(meta?.toolUsePromptTokenCount, meta?.tool_use_prompt_token_count)
  const cachedTokens = num(meta?.cachedContentTokenCount, meta?.cached_content_token_count)

  let totalTokens = num(meta?.totalTokenCount, meta?.total_token_count)
  if (totalTokens <= 0) {
    totalTokens = promptTokens + completionTokens + thoughtsTokens + toolTokens + cachedTokens
  }

  return { promptTokens, completionTokens, totalTokens, thoughtsTokens }
}

/** Parse provider metadata, falling back to text/size estimates when missing. */
export function resolveTokenUsage(
  data: GeminiUsageResponse,
  opts?: { outputText?: string; inputApproxChars?: number }
): {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  estimated: boolean
} {
  const parsed = parseUsageFromGeminiResponse(data)
  if (parsed.totalTokens > 0) {
    return {
      promptTokens: parsed.promptTokens,
      completionTokens: parsed.completionTokens,
      totalTokens: parsed.totalTokens,
      estimated: false,
    }
  }

  const outputText = opts?.outputText ?? extractTextFromGeminiResponse(data)
  const outputTokens = estimateTokensFromText(outputText)
  const inputTokens = opts?.inputApproxChars
    ? Math.max(1, Math.ceil(opts.inputApproxChars / 4))
    : 0
  const totalTokens = Math.max(1, outputTokens + inputTokens)

  return {
    promptTokens: inputTokens || Math.max(1, Math.round(totalTokens * 0.7)),
    completionTokens: outputTokens || Math.max(1, Math.round(totalTokens * 0.3)),
    totalTokens,
    estimated: true,
  }
}

async function persistLastUsed(entry: AiLastUsed): Promise<void> {
  const payload = JSON.stringify(entry)
  const redis = getRedis()
  if (redis) {
    try {
      await redis.set(lastUsedKey(entry.provider, entry.keySuffix), payload, {
        ex: META_TTL_SEC,
      })
      if (entry.userEmail) {
        await redis.set(userLastCallKey(entry.userEmail), payload, { ex: META_TTL_SEC })
      }
      await redis.lpush(RECENT_LIST_KEY, payload)
      await redis.ltrim(RECENT_LIST_KEY, 0, RECENT_MAX - 1)
      await redis.expire(RECENT_LIST_KEY, META_TTL_SEC)
      return
    } catch (err) {
      console.warn('[ai-usage-tracker] failed to persist last-used metadata:', err)
    }
  }

  localLastUsed.set(lastUsedKey(entry.provider, entry.keySuffix), entry)
  if (entry.userEmail) {
    localLastUsed.set(userLastCallKey(entry.userEmail), entry)
  }
  localRecentCalls.unshift(entry)
  if (localRecentCalls.length > RECENT_MAX) {
    localRecentCalls.length = RECENT_MAX
  }
}

/** Record measured (or estimated) token usage for a specific API key. */
export async function recordAiKeyUsage(input: AiUsageInput): Promise<void> {
  const suffix = input.keySuffix.slice(-4)
  const day = utcDay(0)
  const prompt = Math.max(0, Math.round(input.promptTokens ?? 0))
  const completion = Math.max(0, Math.round(input.completionTokens ?? 0))
  const total = Math.max(0, Math.round(input.totalTokens))

  await addUsageAmount(usageKey('requests', input.provider, suffix, day), 1, DAY_SEC)

  if (total > 0) {
    await Promise.all([
      addUsageAmount(usageKey('tokens', input.provider, suffix, day), total, DAY_SEC),
      prompt > 0
        ? addUsageAmount(usageKey('prompt', input.provider, suffix, day), prompt, DAY_SEC)
        : Promise.resolve(0),
      completion > 0
        ? addUsageAmount(usageKey('completion', input.provider, suffix, day), completion, DAY_SEC)
        : Promise.resolve(0),
      input.userEmail
        ? addUsageAmount(userTokensKey(input.userEmail, day), total, DAY_SEC)
        : Promise.resolve(0),
    ])
    if (input.source && !getCurrentRunAudit()) {
      const consumerId = AI_SOURCE_TO_CONSUMER[input.source] ?? input.source
      void recordConsumerTokenUsage(consumerId, total)
    }
  }

  await persistLastUsed({
    at: new Date().toISOString(),
    model: input.model ?? 'unknown',
    tokens: total,
    provider: input.provider,
    keySuffix: suffix,
    source: input.source,
    userEmail: input.userEmail,
    estimated: input.estimated,
  })
}

/** Record a failed AI HTTP call (counts request + failure; no tokens). */
export async function recordAiKeyRequestFailed(input: {
  provider: AiProvider
  keySuffix: string
  model?: string
  status: number
  error?: string
  userEmail?: string
  source?: AiUsageSource
}): Promise<void> {
  const suffix = input.keySuffix.slice(-4)
  const day = utcDay(0)

  await Promise.all([
    addUsageAmount(usageKey('requests', input.provider, suffix, day), 1, DAY_SEC),
    addUsageAmount(usageKey('failed', input.provider, suffix, day), 1, DAY_SEC),
  ])

  await persistLastUsed({
    at: new Date().toISOString(),
    model: input.model ?? 'unknown',
    tokens: 0,
    provider: input.provider,
    keySuffix: suffix,
    source: input.source,
    userEmail: input.userEmail,
    failed: true,
    status: input.status,
    error: input.error?.slice(0, 200),
  })
}

/** Convenience wrapper: parse Gemini-shaped response and record per-key usage. */
export async function recordAiKeyUsageFromResponse(
  input: {
    provider: AiProvider
    keySuffix: string
    model: string
    data: GeminiUsageResponse
    userEmail?: string
    source?: AiUsageSource
    inputApproxChars?: number
  }
): Promise<number> {
  const usage = resolveTokenUsage(input.data, {
    inputApproxChars: input.inputApproxChars,
  })
  await recordAiKeyUsage({
    provider: input.provider,
    keySuffix: input.keySuffix,
    model: input.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    userEmail: input.userEmail,
    source: input.source,
    estimated: usage.estimated,
  })
  return usage.totalTokens
}

export type DayUsage = {
  tokens: number
  promptTokens: number
  completionTokens: number
  requests: number
  failedRequests: number
}

export type KeyUsageRow = {
  provider: AiProvider
  keySuffix: string
  today: DayUsage
  last7d: Pick<DayUsage, 'tokens' | 'requests'>
  lastUsed?: AiLastUsed | null
}

async function readLastUsed(
  provider: AiProvider,
  keySuffix: string
): Promise<AiLastUsed | null> {
  const suffix = keySuffix.slice(-4)
  const redis = getRedis()
  if (redis) {
    try {
      const raw = await redis.get<string>(lastUsedKey(provider, suffix))
      if (!raw) return localLastUsed.get(lastUsedKey(provider, suffix)) ?? null
      const parsed = typeof raw === 'string' ? (JSON.parse(raw) as AiLastUsed) : (raw as AiLastUsed)
      return parsed?.at ? parsed : null
    } catch {
      return localLastUsed.get(lastUsedKey(provider, suffix)) ?? null
    }
  }
  return localLastUsed.get(lastUsedKey(provider, suffix)) ?? null
}

export async function getRecentAiCalls(limit = 20): Promise<RecentAiCall[]> {
  const redis = getRedis()
  if (redis) {
    try {
      const rows = await redis.lrange<string>(RECENT_LIST_KEY, 0, Math.max(0, limit - 1))
      const out: RecentAiCall[] = []
      for (const row of rows) {
        try {
          const parsed = typeof row === 'string' ? (JSON.parse(row) as RecentAiCall) : row
          if (parsed?.at && parsed.keySuffix) out.push(parsed)
        } catch {
          /* skip malformed */
        }
      }
      if (out.length > 0) return out
    } catch {
      /* fall through */
    }
  }
  return localRecentCalls.slice(0, limit)
}

export async function getUserLastAiCall(email: string): Promise<AiLastUsed | null> {
  const redis = getRedis()
  const key = userLastCallKey(email)
  if (redis) {
    try {
      const raw = await redis.get<string>(key)
      if (raw) {
        const parsed = typeof raw === 'string' ? (JSON.parse(raw) as AiLastUsed) : (raw as AiLastUsed)
        if (parsed?.at) return parsed
      }
    } catch {
      /* fall through */
    }
  }
  return localLastUsed.get(key) ?? null
}

async function readDayUsage(
  provider: AiProvider,
  keySuffix: string,
  day: string
): Promise<DayUsage> {
  const suffix = keySuffix.slice(-4)
  const [tokens, promptTokens, completionTokens, requests, failedRequests] = await Promise.all([
    readUsageAmount(usageKey('tokens', provider, suffix, day)),
    readUsageAmount(usageKey('prompt', provider, suffix, day)),
    readUsageAmount(usageKey('completion', provider, suffix, day)),
    readUsageAmount(usageKey('requests', provider, suffix, day)),
    readUsageAmount(usageKey('failed', provider, suffix, day)),
  ])
  return { tokens, promptTokens, completionTokens, requests, failedRequests }
}

export async function getKeyUsageRow(
  provider: AiProvider,
  keySuffix: string
): Promise<KeyUsageRow> {
  const suffix = keySuffix.slice(-4)
  const today = await readDayUsage(provider, suffix, utcDay(0))

  let tokens7 = 0
  let requests7 = 0
  for (let i = 0; i < 7; i++) {
    const day = utcDay(i)
    const u = await readDayUsage(provider, suffix, day)
    tokens7 += u.tokens
    requests7 += u.requests
  }

  const lastUsed = await readLastUsed(provider, suffix)

  return {
    provider,
    keySuffix: suffix,
    today,
    last7d: { tokens: tokens7, requests: requests7 },
    lastUsed,
  }
}

export async function getPlatformUsageToday(): Promise<{
  tokens: number
  requests: number
  byProvider: Record<AiProvider, { tokens: number; requests: number }>
}> {
  const byProvider: Record<AiProvider, { tokens: number; requests: number }> = {
    gemini: { tokens: 0, requests: 0 },
    deepseek: { tokens: 0, requests: 0 },
  }
  let tokens = 0
  let requests = 0
  const day = utcDay(0)

  const { getGeminiApiKeys } = await import('@/lib/gemini')
  const { getDeepseekApiKeys } = await import('@/lib/deepseek')

  for (const key of getGeminiApiKeys()) {
    const u = await readDayUsage('gemini', key.slice(-4), day)
    byProvider.gemini.tokens += u.tokens
    byProvider.gemini.requests += u.requests
    tokens += u.tokens
    requests += u.requests
  }
  for (const key of getDeepseekApiKeys()) {
    const u = await readDayUsage('deepseek', key.slice(-4), day)
    byProvider.deepseek.tokens += u.tokens
    byProvider.deepseek.requests += u.requests
    tokens += u.tokens
    requests += u.requests
  }

  return { tokens, requests, byProvider }
}
