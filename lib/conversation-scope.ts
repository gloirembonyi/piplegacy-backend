/**
 * Conversation scope helpers.
 *
 * Scopes identify a single saved thread:
 *   chart:BINANCE:BTCUSDT           - legacy default thread
 *   chart:BINANCE:BTCUSDT:t:a1b2c3d4 - additional thread on same symbol
 *   insights:MARKET:t:f9e8d7c6
 */

const THREAD_MARKER = ':t:'

export function newThreadId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Channel key shared by all threads (symbol / focus). */
export function conversationChannel(scope: string): string {
  const idx = scope.indexOf(THREAD_MARKER)
  return idx >= 0 ? scope.slice(0, idx) : scope
}

export function isThreadScope(scope: string): boolean {
  return scope.includes(THREAD_MARKER)
}

export function makeThreadScope(channel: string, threadId = newThreadId()): string {
  return `${channel}${THREAD_MARKER}${threadId}`
}

export function chartChannel(symbol: string): string {
  return `chart:${symbol}`
}

export function insightsChannel(focus: string): string {
  return `insights:${focus}`
}

/** True when scope belongs to the same symbol/focus channel. */
export function scopeMatchesChannel(scope: string, channel: string): boolean {
  return scope === channel || scope.startsWith(`${channel}${THREAD_MARKER}`)
}

export function threadLabel(scope: string, title?: string): string {
  if (title?.trim()) return title.trim()
  if (!isThreadScope(scope)) return 'Main'
  const id = scope.split(THREAD_MARKER)[1] ?? ''
  return id ? `Chat ${id.slice(0, 6)}` : 'Chat'
}

const ACTIVE_THREAD_PREFIX = 'ms:active-thread:'

export function readActiveThreadScope(
  email: string | null,
  channel: string
): string | null {
  if (typeof window === 'undefined' || !email) return null
  try {
    const key = `${ACTIVE_THREAD_PREFIX}${email.trim().toLowerCase()}:${channel}`
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeActiveThreadScope(
  email: string | null,
  channel: string,
  scope: string
): void {
  if (typeof window === 'undefined' || !email) return
  try {
    const key = `${ACTIVE_THREAD_PREFIX}${email.trim().toLowerCase()}:${channel}`
    sessionStorage.setItem(key, scope)
  } catch {
    /* private mode */
  }
}

export function clearActiveThreadScope(email: string | null, channel: string): void {
  if (typeof window === 'undefined' || !email) return
  try {
    const key = `${ACTIVE_THREAD_PREFIX}${email.trim().toLowerCase()}:${channel}`
    sessionStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
