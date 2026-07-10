/**
 * Client-side reader for `POST /api/bot/scan` (NDJSON stream of PipelineEvents).
 * Mirrors the shape of `lib/agent-stream.ts` so we can reuse the same UI
 * patterns from the Insights chat panel.
 */

import type { PipelineEvent } from '@/lib/agent/pipeline-types'
import { cleanUpgradeMessage } from '@/lib/plan-upgrade'

export type ScanRequest = {
  symbol: string
  timeframe?: string
  riskBudgetPct?: number
  fast?: boolean
  strategyId?: string
}

export async function* streamPipeline(
  body: ScanRequest,
  opts: { signal?: AbortSignal } = {}
): AsyncGenerator<PipelineEvent, void, void> {
  const res = await fetch('/api/bot/scan', {
    method: 'POST',
    signal: opts.signal,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: JSON.stringify(body),
  })

  if (res.status === 401 && typeof window !== 'undefined') {
    const here = window.location.pathname + window.location.search
    window.location.href = `/login?redirect=${encodeURIComponent(here || '/app')}`
    return
  }

  if (!res.ok) {
    let msg: string
    let upgradeRequired = false
    try {
      const j = (await res.json()) as { error?: string; upgradeRequired?: boolean }
      msg = j.error ?? `HTTP ${res.status}`
      upgradeRequired = Boolean(j.upgradeRequired)
    } catch {
      msg = `HTTP ${res.status}`
    }
    if (res.status === 404) {
      msg =
        'Scan API not found (HTTP 404). Restart the dev server: stop it, run `npm run dev:clean`, then try again.'
    }
    yield {
      type: 'error',
      error: cleanUpgradeMessage(msg),
      status: res.status,
      upgradeRequired: upgradeRequired || res.status === 403 || res.status === 429,
    }
    return
  }

  const reader = res.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) {
          try {
            yield JSON.parse(line) as PipelineEvent
          } catch {
            /* skip malformed line */
          }
        }
        nl = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    if (tail) {
      try {
        yield JSON.parse(tail) as PipelineEvent
      } catch {
        /* skip */
      }
    }
  } finally {
    reader.releaseLock()
  }
}
