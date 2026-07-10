/**
 * Retry/backoff helpers - aligned with claw-code-parity provider clients
 * (exponential backoff, capped delay, abort-aware sleeps).
 */

/** HTTP statuses providers typically mark as retryable (408, 409, 429, 5xx). */
export const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504])

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status)
}

/** Exponential backoff: initial * 2^(attempt-1), capped at maxMs. */
export function exponentialBackoffMs(
  attempt: number,
  initialMs: number,
  maxMs: number
): number {
  const exp = Math.max(0, attempt - 1)
  const multiplier = Math.min(2 ** exp, Math.max(1, Math.floor(maxMs / initialMs)))
  return Math.min(initialMs * multiplier, maxMs)
}

export function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Resolves false when aborted before the sleep completes. */
export function sleepMsAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
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

export type RetryLoopOpts = {
  maxAttempts: number
  initialBackoffMs: number
  maxBackoffMs: number
  signal?: AbortSignal
  /** Return true to retry after backoff. */
  shouldRetry: (attempt: number, error: { status?: number; message?: string }) => boolean
}

/**
 * Run `fn` with exponential backoff between retryable failures.
 * Inspired by claw-code-parity `send_with_retry` in provider clients.
 */
export async function withExponentialRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryLoopOpts
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    try {
      return await fn(attempt)
    } catch (err) {
      lastErr = err
      const status =
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        typeof (err as { status: unknown }).status === 'number'
          ? (err as { status: number }).status
          : undefined
      const message = err instanceof Error ? err.message : String(err)
      const retry =
        attempt < opts.maxAttempts &&
        opts.shouldRetry(attempt, { status, message })
      if (!retry) break
      const delay = exponentialBackoffMs(
        attempt,
        opts.initialBackoffMs,
        opts.maxBackoffMs
      )
      const ok = await sleepMsAbortable(delay, opts.signal)
      if (!ok) throw new DOMException('Aborted', 'AbortError')
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
