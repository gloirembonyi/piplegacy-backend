/**
 * Shared helpers for specialist agents.
 *
 * Each specialist follows the same shape: gather raw data with existing tools
 * / providers, then ask Gemini (cheap, fast) to summarise into a strict
 * SpecialistReport. We keep prompts tiny + outputs JSON-only so the
 * orchestrator can combine them deterministically.
 */

import {
  getGeminiSpecialistModels,
  getGeminiGenerateUrl,
} from '@/lib/gemini'
import { getActiveKeys, markFailure, markSuccess, msUntilNextReady, waitForPoolRecovery } from '@/lib/gemini-keypool'
import { exponentialBackoffMs, sleepMsAbortable } from '@/lib/ai-retry'
import { recordAiKeyUsageFromResponse } from '@/lib/ai-usage-tracker'
import { getCurrentRunAudit } from '@/lib/agent/run-audit'
import { withAiCallSlot } from '@/lib/ai-call-limiter'
import {
  DEEPSEEK_CHAT_MODEL,
  DEEPSEEK_CHAT_MODEL_FALLBACKS,
} from '@/lib/deepseek'
import { callDeepseek } from '@/lib/deepseek-client'
import type { SpecialistReport, SpecialistVerdict } from '@/lib/agent/pipeline-types'

const SPECIALIST_TIMEOUT_MS = 14_000
const SPECIALIST_POOL_WAITS = 4

/**
 * Shared context passed to every specialist run. Carries the **user's selected
 * timeframe** so specialists analyse the same chart the user is looking at,
 * instead of always defaulting to daily.
 */
export type SpecialistContext = {
  symbol: string
  symbolLabel: string
  /** Canonical TF string: '5m' | '15m' | '30m' | '1h' | '4h' | '1d'. */
  timeframe: string
  /** Shared candle cache for one pipeline batch - avoids 8× duplicate fetches. */
  candleCache?: Map<string, import('@/lib/agent/specialists/candles').SpecialistCandles>
}

/** Convert UI timeframes ('5m', '1h', '1d') → candle-provider resolution. */
export function timeframeToResolution(tf: string): string {
  const map: Record<string, string> = {
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '4h': '4h',
    '1d': 'D',
    D: 'D',
  }
  return map[tf] ?? tf
}

/** Human-friendly minutes-per-bar for prompts. */
export function timeframeMinutes(tf: string): number {
  const map: Record<string, number> = {
    '5m': 5,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '4h': 240,
    '1d': 1440,
  }
  return map[tf] ?? 60
}

export const VERDICT_VALUES: SpecialistVerdict[] = [
  'BULLISH',
  'BEARISH',
  'NEUTRAL',
  'AVOID',
]

/** Parse strict JSON the model returned, with a forgiving fallback. */
export function parseJsonish<T>(text: string, fallback: T): T {
  const trimmed = text.trim()
  if (!trimmed) return fallback
  const candidates: string[] = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T
    } catch {
      /* try next */
    }
  }
  return fallback
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

export function normalizeVerdict(value: unknown): SpecialistVerdict {
  const upper = String(value ?? '').toUpperCase()
  if ((VERDICT_VALUES as string[]).includes(upper)) return upper as SpecialistVerdict
  if (upper === 'BUY' || upper === 'LONG') return 'BULLISH'
  if (upper === 'SELL' || upper === 'SHORT') return 'BEARISH'
  return 'NEUTRAL'
}

type ModelCall = {
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  temperature?: number
  userEmail?: string
  source?:
    | 'specialist'
    | 'suggestion'
    | 'sub_agent_summarize'
    | 'pipeline_reply'
    | 'format_reply'
    | 'conversational'
}

type ModelResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string }

async function attemptSpecialistCall(
  call: ModelCall,
  signal: AbortSignal
): Promise<ModelResult | null> {
  const body = {
    systemInstruction: { role: 'system', parts: [{ text: call.systemPrompt }] },
    contents: [{ role: 'user' as const, parts: [{ text: call.userPrompt }] }],
    generationConfig: {
      temperature: call.temperature ?? 0.15,
      maxOutputTokens: call.maxTokens ?? 768,
      responseMimeType: 'application/json',
    },
  }

  const geminiKeys = getActiveKeys('gemini')
  const geminiModels = getGeminiSpecialistModels()
  for (const key of geminiKeys) {
    let saw429OnKey = false
    let last429Body = ''
    for (const model of geminiModels) {
      if (signal.aborted) return null
      try {
        const res = await withAiCallSlot(() =>
          fetch(getGeminiGenerateUrl(model), {
            method: 'POST',
            signal,
            headers: {
              'Content-Type': 'application/json',
              'X-goog-api-key': key,
            },
            body: JSON.stringify(body),
          })
        )
        if (res.ok) {
          type Resp = {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
            usageMetadata?: {
              promptTokenCount?: number
              candidatesTokenCount?: number
              totalTokenCount?: number
            }
          }
          const data = (await res.json()) as Resp
          const text =
            data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
          markSuccess(key, 'gemini')
          await recordAiKeyUsageFromResponse({
            provider: 'gemini',
            keySuffix: key.slice(-4),
            model,
            data,
            userEmail: call.userEmail,
            source: call.source ?? 'specialist',
            inputApproxChars: call.systemPrompt.length + call.userPrompt.length,
          }).then((tokens) => {
            getCurrentRunAudit()?.recordAiCall({
              source: call.source ?? 'specialist',
              model: `gemini:${model}`,
              tokens,
            })
          })
          return { ok: true, text, model: `gemini:${model}` }
        }
        const errBody = await res.text()
        if (res.status === 401 || res.status === 403) {
          markFailure(key, res.status, {
            retryAfter: res.headers.get('retry-after'),
            body: errBody,
            provider: 'gemini',
          })
          break
        }
        if (res.status === 429) {
          saw429OnKey = true
          last429Body = errBody
          continue
        }
        if (res.status === 503 || res.status === 502) {
          await sleepMsAbortable(600, signal)
          continue
        }
        if (res.status === 404) continue
      } catch (err) {
        if ((err as Error).name === 'AbortError') return null
      }
    }
    if (saw429OnKey) {
      markFailure(key, 429, { body: last429Body, provider: 'gemini' })
    }
  }

  const deepseekKeys = getActiveKeys('deepseek')
  for (const key of deepseekKeys) {
    for (const model of [
      DEEPSEEK_CHAT_MODEL,
      ...DEEPSEEK_CHAT_MODEL_FALLBACKS.filter((m) => m !== DEEPSEEK_CHAT_MODEL),
    ]) {
      if (signal.aborted) return null
      try {
        const r = await withAiCallSlot(() => callDeepseek(key, model, body))
        if (r.ok) {
          type Resp = {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
            usageMetadata?: {
              promptTokenCount?: number
              candidatesTokenCount?: number
              totalTokenCount?: number
            }
          }
          const data = r.data as Resp
          const text =
            data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
          markSuccess(key, 'deepseek')
          await recordAiKeyUsageFromResponse({
            provider: 'deepseek',
            keySuffix: key.slice(-4),
            model,
            data,
            userEmail: call.userEmail,
            source: call.source ?? 'specialist',
            inputApproxChars: call.systemPrompt.length + call.userPrompt.length,
          }).then((tokens) => {
            getCurrentRunAudit()?.recordAiCall({
              source: call.source ?? 'specialist',
              model: `deepseek:${model}`,
              tokens,
            })
          })
          return { ok: true, text, model: `deepseek:${model}` }
        }
        if (r.status === 401 || r.status === 403 || r.status === 429 || r.status === 402) {
          markFailure(key, r.status, {
            retryAfter: r.retryAfter,
            body: r.body,
            provider: 'deepseek',
          })
          break
        }
      } catch {
        /* try next */
      }
    }
  }

  return null
}

/**
 * Run one model call with provider fallback (Gemini → DeepSeek), short
 * timeout, and key rotation. Specialists never need tools - they just
 * summarise the raw data we already collected.
 */
export async function callSpecialistModel(call: ModelCall): Promise<ModelResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SPECIALIST_TIMEOUT_MS)

  try {
    const providers = ['gemini', 'deepseek'] as const
    for (let waitAttempt = 0; waitAttempt <= SPECIALIST_POOL_WAITS; waitAttempt++) {
      const result = await attemptSpecialistCall(call, controller.signal)
      if (result) return result
      if (controller.signal.aborted || waitAttempt >= SPECIALIST_POOL_WAITS) break

      const ms = msUntilNextReady([...providers])
      if (ms == null || ms <= 0) break
      await waitForPoolRecovery([...providers], {
        maxWaitMs: Math.min(ms + 1_500, 25_000),
        signal: controller.signal,
      })
      const backoff = exponentialBackoffMs(waitAttempt + 1, 400, 4_000)
      await sleepMsAbortable(backoff, controller.signal)
    }

    return { ok: false, error: 'All AI providers exhausted for specialist call.' }
  } finally {
    clearTimeout(timer)
  }
}

/** Whether a specialist run should count as success in admin metrics. */
export function specialistRunOk(report: SpecialistReport): boolean {
  if (report.headline === 'Specialist crashed') return false
  if (report.headline?.startsWith('Rule-based')) return true
  if (report.headline?.startsWith('Specialist degraded -')) return false
  if (report.degraded && report.confidence >= 40) return true
  return true
}

/** Always returns a SpecialistReport, even when the model call failed. */
export function degradedReport(
  id: SpecialistReport['id'],
  start: number,
  reason: string
): SpecialistReport {
  return {
    id,
    verdict: 'NEUTRAL',
    confidence: 0,
    headline: `Specialist degraded - ${reason}`,
    durationMs: Date.now() - start,
    degraded: true,
    error: reason,
  }
}
