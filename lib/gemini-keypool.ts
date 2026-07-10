/**
 * Stateful AI-provider key pool with per-key cooldown tracking.
 *
 * Despite the historical filename, this pool is PROVIDER-AGNOSTIC: it tracks
 * cooldowns for Gemini AND DeepSeek (and any future provider) so a 429 on
 * one key parks it briefly while traffic flows through the rest of the pool.
 *
 *   getActiveKeys(provider)      → keys NOT currently cooling, LRU-ordered
 *   markFailure(key, ...)        → record a 429 / 503 / 401 - Retry-After aware
 *   markSuccess(key)             → clear cooldown on a key that just worked
 *   poolStatus(provider)         → snapshot for diagnostics
 *   poolExhaustedMessage(prov)   → user-facing "next key recovers in Xs"
 *
 * State is keyed by `${provider}:${apiKey}` so two providers can hold the
 * same key string without colliding (rare, but cheap to be safe).
 */

import { getGeminiApiKeys } from '@/lib/gemini'
import { getDeepseekApiKeys } from '@/lib/deepseek'
import { poolWaitUserMessage } from '@/lib/agent-user-facing'

export type AiProvider = 'gemini' | 'deepseek'

const KEY_GETTERS: Record<AiProvider, () => string[]> = {
  gemini: getGeminiApiKeys,
  deepseek: getDeepseekApiKeys,
}

type KeyState = {
  /** Epoch ms when this key becomes available again. 0 = ready now. */
  cooldownUntil: number
  /** Last reason for cooldown (for diagnostics). */
  lastStatus?: number
  /** Last used (epoch ms) - for round-robin ordering among ready keys. */
  lastUsed: number
  /** Consecutive failures - exponential backoff cap. */
  consecutiveFailures: number
}

const DEFAULT_COOLDOWNS_MS: Record<number, number> = {
  // Per-minute / per-day quota - back off ~60s by default.
  429: 60_000,
  // Auth issue - disable for the lifetime of the process unless reset.
  401: 24 * 60 * 60 * 1000,
  403: 24 * 60 * 60 * 1000,
  // Transient server overload - try again shortly.
  502: 8_000,
  503: 8_000,
}

const MAX_COOLDOWN_MS = 5 * 60_000 // transient errors (503/502)
/** Daily/minute quota exhausted - park key longer so pool rotates to healthy keys. */
const QUOTA_EXHAUSTED_COOLDOWN_MS = 90 * 60_000

function isDailyQuotaExhausted(body?: string): boolean {
  if (!body) return false
  const b = body.toLowerCase()
  return (
    b.includes('exceeded your current quota') ||
    b.includes('quota exceeded') ||
    b.includes('resource_exhausted') ||
    (b.includes('quota') && b.includes('billing'))
  )
}

function isInsufficientBalance(body?: string): boolean {
  if (!body) return false
  return body.toLowerCase().includes('insufficient balance')
}

const state = new Map<string, KeyState>()

function stateKey(provider: AiProvider, apiKey: string): string {
  return `${provider}:${apiKey}`
}

function ensure(provider: AiProvider, apiKey: string): KeyState {
  const k = stateKey(provider, apiKey)
  let s = state.get(k)
  if (!s) {
    s = { cooldownUntil: 0, lastUsed: 0, consecutiveFailures: 0 }
    state.set(k, s)
  }
  return s
}

function parseRetryAfterMs(retryAfter: string | null | undefined): number | null {
  if (!retryAfter) return null
  const trimmed = retryAfter.trim()
  const secs = Number(trimmed)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_COOLDOWN_MS)
  const date = Date.parse(trimmed)
  if (Number.isFinite(date)) {
    const ms = date - Date.now()
    return Math.max(0, Math.min(ms, MAX_COOLDOWN_MS))
  }
  return null
}

/**
 * Record that a key just failed. Provider defaults to 'gemini' for
 * backwards-compatible callers; pass 'deepseek' for DeepSeek keys.
 */
export function markFailure(
  apiKey: string,
  status: number,
  opts?: { retryAfter?: string | null; body?: string; provider?: AiProvider }
): number {
  const provider = opts?.provider ?? 'gemini'
  const s = ensure(provider, apiKey)
  s.lastStatus = status
  s.consecutiveFailures = Math.min(s.consecutiveFailures + 1, 6)

  const retryHint = parseRetryAfterMs(opts?.retryAfter)
  const body = opts?.body ?? ''
  let base = DEFAULT_COOLDOWNS_MS[status] ?? 15_000

  if (status === 429 && isDailyQuotaExhausted(body)) {
    base = QUOTA_EXHAUSTED_COOLDOWN_MS
  }
  if (status === 402 || (status === 429 && isInsufficientBalance(body))) {
    base = 24 * 60 * 60_000
  }

  const backoffMultiplier = Math.pow(1.5, Math.max(0, s.consecutiveFailures - 1))
  let cooldownMs =
    retryHint != null
      ? retryHint
      : status === 429 && isDailyQuotaExhausted(body)
        ? QUOTA_EXHAUSTED_COOLDOWN_MS
        : Math.min(base * backoffMultiplier, status === 503 ? MAX_COOLDOWN_MS : base)

  s.cooldownUntil = Date.now() + cooldownMs

  // When a transient rate-limit burst parks every key at once, cap cooldown so
  // the agent can recover - but not when keys hit daily quota (keep them parked).
  if (status === 429 && !isDailyQuotaExhausted(body)) {
    const st = poolStatus(provider)
    if (st.total > 0 && st.ready === 0 && st.cooling === st.total) {
      s.cooldownUntil = Math.min(s.cooldownUntil, Date.now() + Math.min(cooldownMs, 20_000))
    }
  }

  return cooldownMs
}

export function markSuccess(apiKey: string, provider: AiProvider = 'gemini'): void {
  const s = ensure(provider, apiKey)
  s.cooldownUntil = 0
  s.consecutiveFailures = 0
  s.lastUsed = Date.now()
}

/**
 * Return all configured keys for `provider` that are currently READY (not
 * cooling), ordered by least-recently-used. Falls back to "least-cooling-
 * first" if every key is cooling so we still attempt the call.
 */
export function getActiveKeys(provider: AiProvider = 'gemini'): string[] {
  const getter = KEY_GETTERS[provider] ?? KEY_GETTERS.gemini
  const all = getter()
  if (all.length === 0) return []
  const now = Date.now()

  const ready: Array<{ key: string; lastUsed: number }> = []
  const cooling: Array<{ key: string; cooldownUntil: number }> = []
  for (const key of all) {
    const s = ensure(provider, key)
    if (s.cooldownUntil <= now) {
      ready.push({ key, lastUsed: s.lastUsed })
    } else {
      cooling.push({ key, cooldownUntil: s.cooldownUntil })
    }
  }

  ready.sort((a, b) => a.lastUsed - b.lastUsed)

  if (ready.length === 0) {
    cooling.sort((a, b) => a.cooldownUntil - b.cooldownUntil)
    return cooling.map((c) => c.key)
  }

  return ready.map((r) => r.key)
}

/** True if AT LEAST ONE key for this provider is currently ready. */
export function hasReadyKey(provider: AiProvider = 'gemini'): boolean {
  const getter = KEY_GETTERS[provider] ?? KEY_GETTERS.gemini
  const all = getter()
  const now = Date.now()
  for (const key of all) {
    const s = ensure(provider, key)
    if (s.cooldownUntil <= now) return true
  }
  return false
}

export type KeyPoolStatus = {
  total: number
  ready: number
  cooling: number
  /** Earliest cooldown expiry (epoch ms) when nothing is ready. */
  nextReadyAt: number | null
  details: Array<{
    /** Last 4 chars of the key for safe logging. */
    keySuffix: string
    readyIn: number // ms, 0 = ready now
    lastStatus?: number
    consecutiveFailures: number
  }>
}

export function poolStatus(provider: AiProvider = 'gemini'): KeyPoolStatus {
  const getter = KEY_GETTERS[provider] ?? KEY_GETTERS.gemini
  const all = getter()
  const now = Date.now()
  let ready = 0
  let cooling = 0
  let nextReadyAt: number | null = null
  const details: KeyPoolStatus['details'] = []
  for (const key of all) {
    const s = ensure(provider, key)
    const readyIn = Math.max(0, s.cooldownUntil - now)
    if (readyIn === 0) ready++
    else {
      cooling++
      if (nextReadyAt == null || s.cooldownUntil < nextReadyAt)
        nextReadyAt = s.cooldownUntil
    }
    details.push({
      keySuffix: key.slice(-4),
      readyIn,
      lastStatus: s.lastStatus,
      consecutiveFailures: s.consecutiveFailures,
    })
  }
  return { total: all.length, ready, cooling, nextReadyAt, details }
}

/** Clear in-memory cooldown state (admin recovery after fixing keys). */
export function resetKeyPool(provider?: AiProvider): void {
  if (!provider) {
    state.clear()
    return
  }
  for (const key of [...state.keys()]) {
    if (key.startsWith(`${provider}:`)) state.delete(key)
  }
}

/**
 * Human-readable message when ALL keys (across BOTH providers if
 * specified) are cooling. Used for stream status + admin diagnostics.
 */
export function poolExhaustedMessage(providers: AiProvider[] = ['gemini']): string {
  const snapshots = providers.map((p) => ({ provider: p, status: poolStatus(p) }))
  const total = snapshots.reduce((acc, s) => acc + s.status.total, 0)
  const ready = snapshots.reduce((acc, s) => acc + s.status.ready, 0)
  if (total === 0) return 'No AI API key configured.'
  if (ready > 0) return poolWaitUserMessage(3)

  // Find the soonest recovery across all providers.
  let nextReadyAt: number | null = null
  for (const s of snapshots) {
    if (s.status.nextReadyAt != null) {
      nextReadyAt =
        nextReadyAt == null ? s.status.nextReadyAt : Math.min(nextReadyAt, s.status.nextReadyAt)
    }
  }
  if (nextReadyAt == null) return poolWaitUserMessage(8)

  const secs = Math.min(Math.max(1, Math.ceil((nextReadyAt - Date.now()) / 1000)), 90)
  return poolWaitUserMessage(secs)
}

/** Milliseconds until any configured key becomes ready (0 = ready now, null = no keys). */
export function msUntilNextReady(providers: AiProvider[] = ['gemini', 'deepseek']): number | null {
  const configured = providers.filter((p) => (KEY_GETTERS[p]?.() ?? []).length > 0)
  if (configured.length === 0) return null

  const now = Date.now()
  let soonest: number | null = null
  for (const p of configured) {
    const st = poolStatus(p)
    if (st.ready > 0) return 0
    if (st.nextReadyAt != null) {
      const ms = st.nextReadyAt - now
      soonest = soonest == null ? ms : Math.min(soonest, ms)
    }
  }
  return soonest ?? 0
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(true)
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(!signal?.aborted), ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve(false)
      },
      { once: true }
    )
  })
}

/**
 * Block until at least one key is ready, polling the pool. Returns false when
 * aborted or maxWaitMs elapses without recovery.
 */
export async function waitForPoolRecovery(
  providers: AiProvider[] = ['gemini', 'deepseek'],
  opts?: {
    maxWaitMs?: number
    pollMs?: number
    onTick?: (secondsLeft: number) => void
    signal?: AbortSignal
  }
): Promise<boolean> {
  const maxWait = opts?.maxWaitMs ?? 90_000
  const poll = Math.max(500, opts?.pollMs ?? 1000)
  const deadline = Date.now() + maxWait

  while (Date.now() < deadline) {
    if (opts?.signal?.aborted) return false
    const ms = msUntilNextReady(providers)
    if (ms === 0) return true
    if (ms == null) return false

    opts?.onTick?.(Math.max(1, Math.ceil(ms / 1000)))
    const slice = Math.min(ms + 250, poll, deadline - Date.now())
    if (slice <= 0) break
    const ok = await sleepMs(slice, opts?.signal)
    if (!ok) return false
  }

  return msUntilNextReady(providers) === 0
}
