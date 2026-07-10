/**
 * Client-side helper that reads the NDJSON stream returned by
 * `POST /api/market-chat` (with `Accept: application/x-ndjson`).
 *
 * Each line is one JSON event; we yield them as they arrive so the UI
 * can show tool calls / thinking states live (Cursor / Claude-Code style).
 */

import { formatNetworkError } from '@/lib/network-errors'

export type AgentGrounding = {
  serverTimeUtc: string
  symbol?: string
  symbolLabel?: string
  quote?: {
    price: number
    changePercent: number
    dayHigh: number
    dayLow: number
    open: number
    prevClose: number
    ageSec: number
  }
  forexOpen: boolean
  usStockOpen: boolean
  activeSessions: string[]
  liquidity: 'High' | 'Medium' | 'Low'
  marketStatusForSymbol?: { label: string; isOpen: boolean }
  nextSession?: {
    name: string
    currency: string
    opensIn: string
    minutesUntil: number
  }
  nextHighImpact?: {
    event: string
    currency: string
    impact: string
    date: string
    time: string
    minutesUntil: number | null
  }
  newsBlackout: boolean
  newsBlackoutReason?: string
}

export type AgentStreamEvent =
  | { type: 'open'; symbol: string; label: string; resolution: string }
  | { type: 'grounding'; grounding: AgentGrounding; durationMs: number }
  | {
      type: 'planning'
      intent: string
      subAgents: string[]
      progressSteps: string[]
      taskTags?: string[]
      effort?: 'light' | 'standard' | 'deep'
    }
  | { type: 'sub_agent_start'; agent: string }
  | {
      type: 'sub_agent_done'
      agent: string
      ok: boolean
      summary: string
      durationMs: number
    }
  | { type: 'confluence_start'; agent?: string }
  | {
      type: 'confluence'
      score: number
      bias: string
      blockers?: string[]
      specialistCount?: number
    }
  | { type: 'reflecting'; passed: boolean; issues?: string[] }
  | { type: 'thinking'; iteration: number }
  | { type: 'model'; model: string }
  | {
      type: 'ai_call'
      source: string
      label: string
      model: string
      tokens: number
    }
  | { type: 'pool_wait'; seconds: number; attempt: number; message?: string }
  | { type: 'emergency_finish'; reason: string }
  | {
      type: 'tool_call'
      tool: string
      args: Record<string, unknown>
      callId: string
    }
  | {
      type: 'tool_result'
      tool: string
      ok: boolean
      summary?: string
      error?: string
      durationMs: number
      callId: string
      payload?: Record<string, unknown>
    }
  | { type: 'ask_user'; question: string; options?: string[] }
  | {
      type: 'final'
      response: {
        reply: string
        setup: unknown
        levels: unknown
        zones?: unknown
        drawIntent?: boolean | null
        clarifyingQuestion?: string | null
        clarifyingOptions?: string[]
        artifacts?: unknown[]
      }
      iterations: number
      reflectionPassed?: boolean
    }
  | { type: 'error'; status: number; error: string }
  | {
      type: 'done'
      symbol?: string
      label?: string
      resolution?: string
      response?: {
        reply: string
        setup: unknown
        levels: unknown
        zones?: unknown
        drawIntent?: boolean | null
        clarifyingQuestion?: string | null
        clarifyingOptions?: string[]
        artifacts?: unknown[]
      }
      trace?: unknown[]
      model?: string
      iterations?: number
      error?: string
      status?: number
    }

/** Hard cap aligned with Vercel `market-chat` maxDuration (120s) + small buffer. */
const STREAM_TOTAL_MS = 125_000
/** Abort when the server sends no bytes for this long (stalled proxy / hung function). */
const STREAM_IDLE_MS = 60_000

export type StreamOptions = {
  signal?: AbortSignal
}

function mergeAbortSignals(
  userSignal: AbortSignal | undefined,
  ...extras: AbortSignal[]
): AbortSignal {
  const signals = [userSignal, ...extras].filter(
    (s): s is AbortSignal => s != null
  )
  if (signals.length === 0) return new AbortController().signal
  if (signals.length === 1) return signals[0]
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals)
  }
  const merged = new AbortController()
  const onAbort = () => merged.abort()
  for (const s of signals) {
    if (s.aborted) {
      merged.abort()
      break
    }
    s.addEventListener('abort', onAbort, { once: true })
  }
  return merged.signal
}

export type AgentImageAttachment = {
  /** Full `data:image/*;base64,...` URL - the server will split prefix + payload. */
  dataUrl: string
  /** Optional original filename (display only). */
  name?: string
}

import type { ChartStateSnapshot } from '@/lib/chart-state'

export async function* streamAgent(
  body: {
    symbol: string
    message: string
    history: { role: string; content: string }[]
    mode?: 'chart' | 'insights'
    resolution?: string
    /** Conversation scope for server-side memory (chart:SYMBOL / insights:FOCUS). */
    scope?: string
    /** Live chart canvas snapshot (drawings + active setup). */
    chartState?: ChartStateSnapshot | null
    /** Optional image attachments - passed to Gemini multimodal input. */
    images?: AgentImageAttachment[]
  },
  opts: StreamOptions = {}
): AsyncGenerator<AgentStreamEvent, void, void> {
  const totalCtrl = new AbortController()
  const idleCtrl = new AbortController()
  const totalTimer = setTimeout(() => totalCtrl.abort(), STREAM_TOTAL_MS)
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => idleCtrl.abort(), STREAM_IDLE_MS)
  }

  const cleanupTimers = () => {
    clearTimeout(totalTimer)
    if (idleTimer) clearTimeout(idleTimer)
  }

  bumpIdle()
  const signal = mergeAbortSignals(opts.signal, totalCtrl.signal, idleCtrl.signal)

  let res: Response
  try {
    res = await fetch('/api/market-chat', {
      method: 'POST',
      signal,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    cleanupTimers()
    if (totalCtrl.signal.aborted && !opts.signal?.aborted) {
      yield {
        type: 'error',
        status: 503,
        error:
          'Analysis took too long. Try a shorter question or wait a moment and retry.',
      }
      return
    }
    if (idleCtrl.signal.aborted && !opts.signal?.aborted) {
      yield {
        type: 'error',
        status: 503,
        error:
          'Connection stalled. Check your network and send your message again.',
      }
      return
    }
    yield {
      type: 'error',
      status: 503,
      error: formatNetworkError(err, 'Market Agent'),
    }
    return
  }

  if (res.status === 401 && typeof window !== 'undefined') {
    const path = window.location.pathname + window.location.search
    window.location.href = `/login?redirect=${encodeURIComponent(path || '/app')}`
    return
  }

  if (!res.ok) {
    let errText: string
    try {
      const j = await res.json()
      errText = j.error ?? `HTTP ${res.status}`
    } catch {
      errText = `HTTP ${res.status}`
    }
    yield { type: 'error', status: res.status, error: errText }
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
      bumpIdle()
      buffer += decoder.decode(value, { stream: true })
      let newlineIdx = buffer.indexOf('\n')
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (line) {
          try {
            bumpIdle()
            yield JSON.parse(line) as AgentStreamEvent
          } catch {
            /* skip malformed chunk */
          }
        }
        newlineIdx = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    if (tail) {
      try {
        bumpIdle()
        yield JSON.parse(tail) as AgentStreamEvent
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    if (!opts.signal?.aborted) {
      if (totalCtrl.signal.aborted) {
        yield {
          type: 'error',
          status: 503,
          error:
            'Analysis took too long. Try a shorter question or wait a moment and retry.',
        }
      } else if (idleCtrl.signal.aborted) {
        yield {
          type: 'error',
          status: 503,
          error:
            'Connection stalled. Check your network and send your message again.',
        }
      } else {
        yield {
          type: 'error',
          status: 503,
          error: formatNetworkError(err, 'agent stream'),
        }
      }
    }
  } finally {
    cleanupTimers()
    reader.releaseLock()
  }
}
