/**
 * Bridge to the Python multi-agent engine.
 *
 * - **Local dev:** FastAPI sidecar on http://127.0.0.1:8765 (`npm run python-agent:start`)
 * - **Vercel production:** Serverless Python at `/api/python-agent/*` (auto-detected)
 *
 * Falls back to the TypeScript pipeline when Python is unavailable.
 */

import type { LiveGrounding } from '@/lib/agent/live-grounding'
import type {
  PipelineEvent,
  PipelineInput,
  PipelineResult,
} from '@/lib/agent/pipeline-types'

const LOCAL_URL = 'http://127.0.0.1:8765'
const HEALTH_TIMEOUT_MS = 2500
const VERCEL_HEALTH_TIMEOUT_MS = 20_000
const SCAN_TIMEOUT_MS = 55_000

let cachedHealth: { ok: boolean; checkedAt: number } | null = null
const HEALTH_TTL_MS = 30_000

function isExplicitlyDisabled(): boolean {
  const env = process.env.PYTHON_AGENT_URL?.trim().toLowerCase()
  return env === 'disabled' || env === 'false' || env === '0'
}

/** Resolve the Python engine base URL (no trailing slash). */
export function getPythonAgentUrl(request?: Request): string {
  if (isExplicitlyDisabled()) return ''

  const explicit = process.env.PYTHON_AGENT_URL?.trim()
  if (explicit) {
    const lower = explicit.toLowerCase()
    const isLocalhost =
      lower.includes('127.0.0.1') || lower.includes('localhost') || lower.startsWith('http://127.')
    // Never use a local sidecar URL on Vercel (common misconfiguration when copying .env.local).
    if (!(process.env.VERCEL === '1' && isLocalhost)) {
      return explicit.replace(/\/$/, '')
    }
  }

  // Vercel: same-deployment serverless Python at /api/python-agent/*
  if (process.env.VERCEL === '1') {
    if (request) {
      try {
        const origin = new URL(request.url).origin
        if (origin && !origin.includes('localhost')) {
          return `${origin}/api/python-agent`
        }
      } catch {
        /* fall through */
      }
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim()
    if (appUrl) return `${appUrl.replace(/\/$/, '')}/api/python-agent`
    const vercelUrl = process.env.VERCEL_URL?.trim()
    if (vercelUrl) return `https://${vercelUrl}/api/python-agent`
  }

  // Local dev: FastAPI sidecar (optional).
  return LOCAL_URL
}

export type PythonAgentMode = 'disabled' | 'local' | 'vercel' | 'custom'

export function getPythonAgentMode(request?: Request): PythonAgentMode {
  if (isExplicitlyDisabled()) return 'disabled'
  const explicit = process.env.PYTHON_AGENT_URL?.trim()
  if (explicit) {
    const lower = explicit.toLowerCase()
    const isLocalhost =
      lower.includes('127.0.0.1') || lower.includes('localhost') || lower.startsWith('http://127.')
    if (!(process.env.VERCEL === '1' && isLocalhost)) return 'custom'
  }
  if (process.env.VERCEL === '1') return 'vercel'
  return 'local'
}

export function isPythonAgentEnabled(): boolean {
  if (isExplicitlyDisabled()) return false
  if (process.env.VERCEL === '1') return true
  return true // local sidecar optional; health check gates usage
}

function pythonAuthHeaders(): Record<string, string> {
  const secret =
    process.env.PYTHON_AGENT_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim()
  return secret ? { 'X-Python-Agent-Secret': secret } : {}
}

function healthTimeoutMs(): number {
  return process.env.VERCEL === '1' ? VERCEL_HEALTH_TIMEOUT_MS : HEALTH_TIMEOUT_MS
}

export async function checkPythonAgentHealth(request?: Request): Promise<boolean> {
  const now = Date.now()
  if (cachedHealth && now - cachedHealth.checkedAt < HEALTH_TTL_MS) {
    return cachedHealth.ok
  }
  const result = await probePythonAgentHealth(request)
  return result.ok
}

export type PythonAgentProbeResult = {
  ok: boolean
  latency: number
  detail: string
  mode: PythonAgentMode
  url: string
}

/** Detailed health probe for admin Services (uses auth + Vercel serverless URL). */
export async function probePythonAgentHealth(
  request?: Request
): Promise<PythonAgentProbeResult> {
  const mode = getPythonAgentMode(request)
  const base = getPythonAgentUrl(request)

  if (mode === 'disabled' || !base) {
    return {
      ok: false,
      latency: 0,
      detail: 'PYTHON_AGENT_URL=disabled (TypeScript pipeline only)',
      mode,
      url: '',
    }
  }

  const start = Date.now()
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(healthTimeoutMs()),
      cache: 'no-store',
      headers: pythonAuthHeaders(),
    })
    const latency = Date.now() - start

    if (res.status === 401) {
      return {
        ok: false,
        latency,
        detail: 'Unauthorized - set PYTHON_AGENT_SECRET or ensure SESSION_SECRET matches',
        mode,
        url: base,
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        ok: false,
        latency,
        detail: body.slice(0, 100) || `HTTP ${res.status}`,
        mode,
        url: base,
      }
    }

    const data = (await res.json()) as { ok?: boolean; runtime?: string; engine?: string }
    const ok = data.ok === true
    const runtime =
      data.runtime === 'vercel'
        ? 'Vercel serverless'
        : mode === 'local'
          ? 'Local FastAPI'
          : 'Python engine'

    cachedHealth = { ok, checkedAt: Date.now() }
    return {
      ok,
      latency,
      detail: ok ? `${runtime} · ${data.engine ?? 'ok'}` : 'Health check failed',
      mode,
      url: base,
    }
  } catch (err) {
    const latency = Date.now() - start
    const msg = err instanceof Error ? err.message.slice(0, 100) : 'Unreachable'
    cachedHealth = { ok: false, checkedAt: Date.now() }
    return {
      ok: false,
      latency,
      detail:
        mode === 'vercel'
          ? `${msg} (cold start can take ~15s - retry or check /api/python-agent/health)`
          : msg,
      mode,
      url: base,
    }
  }
}

type PythonScanBody = {
  symbol: string
  symbolLabel: string
  timeframe: string
  riskBudgetPct: number
  fast: boolean
  grounding: LiveGrounding
}

/** Stream pipeline events from the Python engine (NDJSON). */
export async function* streamPythonPipeline(
  input: PipelineInput & { symbolLabel: string; grounding: LiveGrounding }
): AsyncGenerator<PipelineEvent, PipelineResult | null, void> {
  const base = getPythonAgentUrl().replace(/\/$/, '') // runtime calls use env-based URL
  const body: PythonScanBody = {
    symbol: input.symbol.toUpperCase(),
    symbolLabel: input.symbolLabel,
    timeframe: input.timeframe ?? '1h',
    riskBudgetPct: input.riskBudgetPct ?? 1,
    fast: Boolean(input.fast),
    grounding: input.grounding,
  }

  const res = await fetch(`${base}/scan/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
      ...pythonAuthHeaders(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    cache: 'no-store',
  })

  if (!res.ok) {
    let msg = `Python engine HTTP ${res.status}`
    try {
      const j = (await res.json()) as { error?: string }
      if (j.error) msg = j.error
    } catch {
      /* ignore */
    }
    yield { type: 'error', error: msg, status: res.status }
    return null
  }

  const reader = res.body?.getReader()
  if (!reader) return null

  const decoder = new TextDecoder()
  let buffer = ''
  let lastResult: PipelineResult | null = null

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
            const event = JSON.parse(line) as PipelineEvent
            if (event.type === 'done') lastResult = event.result
            yield event
          } catch {
            /* skip malformed */
          }
        }
        nl = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    if (tail) {
      try {
        const event = JSON.parse(tail) as PipelineEvent
        if (event.type === 'done') lastResult = event.result
        yield event
      } catch {
        /* skip */
      }
    }
  } finally {
    reader.releaseLock()
  }

  return lastResult
}

