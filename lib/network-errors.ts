/**
 * Detect and format network / DNS failures for user-facing messages.
 */

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

export function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; cause?: unknown; message?: string }
  if (e.code && NETWORK_CODES.has(e.code)) return true
  if (e.cause) return isNetworkError(e.cause)
  const msg = (e.message ?? '').toLowerCase()
  return (
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('getaddrinfo') ||
    msg.includes('failed to fetch') ||
    msg.includes('net::') ||
    msg.includes('partial transfer') ||
    msg.includes('input stream')
  )
}

export function formatNetworkError(err: unknown, context?: string): string {
  if (isNetworkError(err)) {
    const base =
      'Network connection issue - check your internet, VPN, or firewall. Live quotes and AI need outbound access.'
    return context ? `${base} (${context})` : base
  }
  if (err instanceof Error && err.message.trim()) {
    const msg = err.message
    if (/input stream|partial transfer|networkerror/i.test(msg)) {
      return 'Connection lost while the agent was responding. Check your network and try again.'
    }
    return msg
  }
  return context
    ? `Request failed (${context}). Please try again.`
    : 'Request failed. Please try again.'
}

export function networkErrorStatus(err: unknown): number {
  return isNetworkError(err) ? 503 : 502
}
