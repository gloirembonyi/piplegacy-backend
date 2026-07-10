/**
 * Limits concurrent outbound AI provider calls so free-tier key pools are not
 * overwhelmed when 8 pipeline specialists + main agent fire at once.
 */

let inFlight = 0
const waitQueue: Array<() => void> = []

function release(): void {
  inFlight = Math.max(0, inFlight - 1)
  const next = waitQueue.shift()
  if (next) next()
}

/** Max parallel AI HTTP calls (Gemini/DeepSeek). Tune via AI_MAX_CONCURRENT_CALLS. */
export function aiMaxConcurrentCalls(): number {
  const raw = Number(process.env.AI_MAX_CONCURRENT_CALLS)
  if (Number.isFinite(raw) && raw >= 1 && raw <= 8) return Math.round(raw)
  return 2
}

/** Acquire a slot before calling an AI provider. Releases when fn completes. */
export async function withAiCallSlot<T>(fn: () => Promise<T>): Promise<T> {
  const max = aiMaxConcurrentCalls()
  if (inFlight >= max) {
    await new Promise<void>((resolve) => waitQueue.push(resolve))
  }
  inFlight += 1
  try {
    return await fn()
  } finally {
    release()
  }
}

/** Current in-flight count (for admin diagnostics). */
export function aiCallSlotStats(): { inFlight: number; queued: number; max: number } {
  return { inFlight, queued: waitQueue.length, max: aiMaxConcurrentCalls() }
}
