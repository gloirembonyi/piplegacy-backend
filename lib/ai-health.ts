import { getDeepseekApiKeys, getDeepseekChatUrl, DEEPSEEK_CHAT_MODEL } from '@/lib/deepseek'
import { getGeminiApiKeys, getGeminiGenerateUrl, GEMINI_CHAT_MODEL } from '@/lib/gemini'
import {
  poolStatus,
  resetKeyPool,
  type AiProvider,
  type KeyPoolStatus,
} from '@/lib/gemini-keypool'

export type KeyProbeResult = {
  provider: AiProvider
  keySuffix: string
  ok: boolean
  status: number
  latencyMs: number
  model: string
  detail: string
}

export type AiHealthReport = {
  timestamp: string
  gemini: KeyPoolStatus
  deepseek: KeyPoolStatus
  probes: KeyProbeResult[]
  summary: {
    geminiKeys: number
    deepseekKeys: number
    geminiReady: number
    deepseekReady: number
    anyReady: boolean
    recommendation: string
  }
}

async function probeGeminiKey(apiKey: string): Promise<KeyProbeResult> {
  const models = [
    ...new Set([GEMINI_CHAT_MODEL, 'gemini-2.5-flash-lite', 'gemini-2.5-flash']),
  ]
  const start = Date.now()
  let lastStatus = 503
  let lastDetail = 'All models failed'
  let lastModel = models[0] ?? 'gemini-2.5-flash-lite'

  for (const model of models) {
    lastModel = model
    try {
      const res = await fetch(getGeminiGenerateUrl(model), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: ok' }] }],
          generationConfig: { maxOutputTokens: 8, temperature: 0 },
        }),
        signal: AbortSignal.timeout(12_000),
      })
      if (res.ok) {
        return {
          provider: 'gemini',
          keySuffix: apiKey.slice(-4),
          ok: true,
          status: res.status,
          latencyMs: Date.now() - start,
          model,
          detail: 'Live probe OK',
        }
      }
      lastStatus = res.status
      const body = (await res.text()).slice(0, 200)
      lastDetail = body || `HTTP ${res.status}`
      if (res.status === 429) lastDetail = 'Rate limited (429) on ' + model
      if (res.status === 402 || res.status === 403) lastDetail = 'Quota or billing issue'
      if (res.status === 401) lastDetail = 'Invalid API key (401)'
      if (res.status === 404) continue
      if (res.status === 429) continue
    } catch (err) {
      lastStatus = 503
      lastDetail = err instanceof Error ? err.message.slice(0, 120) : 'Probe failed'
    }
  }

  return {
    provider: 'gemini',
    keySuffix: apiKey.slice(-4),
    ok: false,
    status: lastStatus,
    latencyMs: Date.now() - start,
    model: lastModel,
    detail: lastDetail,
  }
}

async function probeDeepseekKey(apiKey: string): Promise<KeyProbeResult> {
  const model = DEEPSEEK_CHAT_MODEL
  const start = Date.now()
  try {
    const res = await fetch(getDeepseekChatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(12_000),
    })
    const latencyMs = Date.now() - start
    const body = res.ok ? '' : (await res.text()).slice(0, 200)
    let detail = res.ok ? 'Live probe OK' : body || `HTTP ${res.status}`
    if (res.status === 402) detail = 'Insufficient balance (402)'
    if (res.status === 429) detail = 'Rate limited (429)'
    if (res.status === 401) detail = 'Invalid API key (401)'
    return {
      provider: 'deepseek',
      keySuffix: apiKey.slice(-4),
      ok: res.ok,
      status: res.status,
      latencyMs,
      model,
      detail,
    }
  } catch (err) {
    return {
      provider: 'deepseek',
      keySuffix: apiKey.slice(-4),
      ok: false,
      status: 503,
      latencyMs: Date.now() - start,
      model,
      detail: err instanceof Error ? err.message.slice(0, 120) : 'Probe failed',
    }
  }
}

/** Live probe of each configured key (admin only - costs ~1 token per key). */
export async function runAiHealthCheck(opts?: {
  probeLive?: boolean
}): Promise<AiHealthReport> {
  const gemini = poolStatus('gemini')
  const deepseek = poolStatus('deepseek')
  const probes: KeyProbeResult[] = []

  if (opts?.probeLive !== false) {
    for (const key of getGeminiApiKeys()) {
      probes.push(await probeGeminiKey(key))
    }
    for (const key of getDeepseekApiKeys()) {
      probes.push(await probeDeepseekKey(key))
    }
  }

  const anyProbeOk = probes.some((p) => p.ok)
  const anyReady = gemini.ready > 0 || deepseek.ready > 0

  const geminiProbeOk = probes.filter((p) => p.provider === 'gemini' && p.ok).length
  const geminiProbeTotal = probes.filter((p) => p.provider === 'gemini').length
  const deepseekProbeOk = probes.filter((p) => p.provider === 'deepseek' && p.ok).length

  let recommendation = 'AI look healthy.'
  if (gemini.total === 0 && deepseek.total === 0) {
    recommendation =
      'No AI configured. Add GEMINI_API_KEY and/or DEEPSEEK_API_KEY in Vercel env vars and redeploy.'
  } else if (!anyProbeOk && probes.length > 0) {
    recommendation =
      'All probed keys failed (429 quota or 503 demand). Wait for daily reset, add fresh Gemini keys at aistudio.google.com, or top up DeepSeek. Reset cooldowns after fixing keys.'
  } else if (geminiProbeOk > 0 && geminiProbeOk < geminiProbeTotal) {
    recommendation = `${geminiProbeOk}/${geminiProbeTotal} Gemini keys live OK - pool rotates to healthy keys. Exhausted keys auto-park ~90m. Keep AI_MAX_CONCURRENT_CALLS=2 on free tier.`
  } else if (deepseek.total > 0 && deepseekProbeOk === 0) {
    recommendation =
      'DeepSeek keys have no balance (402). Gemini-only mode is active - ensure at least 2 working Gemini keys for rotation.'
  } else if (!anyReady) {
    recommendation =
      'All keys are in cooldown from recent failures. Wait for recovery or reset the key pool from Admin → AI Health.'
  } else if (gemini.total > 0 && deepseek.total === 0) {
    recommendation =
      'Consider adding DEEPSEEK_API_KEY as fallback when Gemini free tier is exhausted.'
  }

  return {
    timestamp: new Date().toISOString(),
    gemini,
    deepseek,
    probes,
    summary: {
      geminiKeys: gemini.total,
      deepseekKeys: deepseek.total,
      geminiReady: gemini.ready,
      deepseekReady: deepseek.ready,
      anyReady: anyReady || anyProbeOk,
      recommendation,
    },
  }
}

export { resetKeyPool }
