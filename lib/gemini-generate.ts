import { recordAiKeyUsageFromResponse, type AiUsageSource } from '@/lib/ai-usage-tracker'
import { getGeminiGenerateUrl } from '@/lib/gemini'
import {
  getActiveKeys,
  markFailure,
  markSuccess,
} from '@/lib/gemini-keypool'

const RETRYABLE_STATUSES = new Set([502, 503])
const KEY_AUTH_FAIL_STATUSES = new Set([401, 402, 403])

export type GeminiGenerateSuccess = {
  ok: true
  data: unknown
  model: string
  keySuffix: string
}

export type GeminiGenerateFailure = {
  ok: false
  status: number
  body: string
  model: string
}

export type GeminiGenerateResult = GeminiGenerateSuccess | GeminiGenerateFailure

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Call Gemini generateContent with model + API-key fallbacks.
 *
 * Failover order: for each KEY, try each MODEL with retries; on 401/403/429
 * (per-key quota / auth issue) move to the next KEY without burning more
 * retries on the current one. On 503/502 retry briefly before moving on.
 */
export async function generateGeminiContent(
  apiKeyOrKeys: string | string[],
  models: string[],
  requestBody: object,
  options?: {
    retriesPerModel?: number
    retryDelayMs?: number
    userEmail?: string
    source?: AiUsageSource
  }
): Promise<GeminiGenerateResult> {
  const retriesPerModel = options?.retriesPerModel ?? 2
  const retryDelayMs = options?.retryDelayMs ?? 700

  // Prefer the stateful pool - it already filters out cooling keys for
  // zero-downtime failover. Fall back to the caller-provided list only when
  // the pool is empty (e.g., embedded usage with explicit keys).
  let keys = getActiveKeys()
  if (keys.length === 0) {
    keys = (Array.isArray(apiKeyOrKeys) ? apiKeyOrKeys : [apiKeyOrKeys])
      .map((k) => k?.trim())
      .filter((k): k is string => Boolean(k))
  }

  if (keys.length === 0) {
    return { ok: false, status: 503, body: 'No Gemini API key configured', model: '' }
  }

  let lastStatus = 502
  let lastBody = ''
  let lastModel = models[0] ?? ''

  for (const apiKey of keys) {
    let keyExhausted = false
    let saw429OnKey = false
    for (const model of models) {
      lastModel = model
      for (let attempt = 0; attempt < retriesPerModel; attempt++) {
        const response = await fetch(getGeminiGenerateUrl(model), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-goog-api-key': apiKey,
          },
          body: JSON.stringify(requestBody),
        })

        if (response.ok) {
          const data = await response.json()
          markSuccess(apiKey)
          await recordAiKeyUsageFromResponse({
            provider: 'gemini',
            keySuffix: apiKey.slice(-4),
            model,
            data: data as Parameters<typeof recordAiKeyUsageFromResponse>[0]['data'],
            userEmail: options?.userEmail,
            source: options?.source ?? 'other',
            inputApproxChars: JSON.stringify(requestBody).length,
          })
          return { ok: true, data, model, keySuffix: apiKey.slice(-4) }
        }

        lastStatus = response.status
        lastBody = await response.text()
        const retryAfter = response.headers.get('retry-after')

        if (KEY_AUTH_FAIL_STATUSES.has(response.status)) {
          markFailure(apiKey, response.status, { retryAfter, body: lastBody })
          keyExhausted = true
          break
        }
        if (response.status === 429) {
          saw429OnKey = true
          break
        }
        if (response.status === 404) break
        if (RETRYABLE_STATUSES.has(response.status) && attempt < retriesPerModel - 1) {
          markFailure(apiKey, response.status, { retryAfter })
          await sleep(retryDelayMs * (attempt + 1))
          continue
        }
        if (!RETRYABLE_STATUSES.has(response.status)) {
          return { ok: false, status: lastStatus, body: lastBody, model: lastModel }
        }
        markFailure(apiKey, response.status, { retryAfter })
        break
      }
      if (keyExhausted) break
    }
    if (!keyExhausted && saw429OnKey) {
      markFailure(apiKey, 429, { body: lastBody })
    }
  }

  return { ok: false, status: lastStatus, body: lastBody, model: lastModel }
}
