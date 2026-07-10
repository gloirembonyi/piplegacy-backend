/**
 * Probe each Gemini key against candidate models - prints working pairs only.
 * Usage: npx tsx scripts/probe-gemini-models.mjs
 */
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

function loadEnvFile(name) {
  const path = resolve(process.cwd(), name)
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] == null) process.env[key] = val
  }
}

loadEnvFile('.env.local')
loadEnvFile('.env')

const { getGeminiApiKeys, getGeminiGenerateUrl, GEMINI_CHAT_MODEL } = await import('../lib/gemini.ts')

const MODELS = [
  GEMINI_CHAT_MODEL,
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-3-flash-preview',
]

async function probeKeyModel(apiKey, model) {
  const start = Date.now()
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
      signal: AbortSignal.timeout(15_000),
    })
    const ms = Date.now() - start
    if (res.ok) return { ok: true, ms, detail: 'OK' }
    const body = (await res.text()).slice(0, 120)
    return { ok: false, ms, detail: `HTTP ${res.status} ${body}` }
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - start,
      detail: e instanceof Error ? e.message.slice(0, 80) : 'failed',
    }
  }
}

const keys = getGeminiApiKeys()
console.log(`--- Gemini key × model probe (${keys.length} keys) ---\n`)

const working = []
for (const key of keys) {
  const suffix = key.slice(-4)
  console.log(`Key …${suffix}:`)
  for (const model of [...new Set(MODELS)]) {
    const r = await probeKeyModel(key, model)
    const tag = r.ok ? 'OK' : 'FAIL'
    console.log(`  [${tag}] ${model.padEnd(28)} ${String(r.ms).padStart(5)}ms - ${r.detail}`)
    if (r.ok) working.push({ suffix, model, ms: r.ms })
  }
  console.log('')
}

console.log('--- Recommended GEMINI_AGENT_MODELS (fastest per model) ---')
const byModel = new Map()
for (const w of working) {
  const prev = byModel.get(w.model)
  if (!prev || w.ms < prev.ms) byModel.set(w.model, w)
}
const recommended = [...byModel.keys()]
console.log(recommended.join(',') || '(none - check keys/quota)')
console.log('\nAdd to .env.local:')
console.log(`GEMINI_CHAT_MODEL=${recommended[0] ?? 'gemini-2.5-flash-lite'}`)
if (recommended.length > 1) {
  console.log(`GEMINI_AGENT_MODELS=${recommended.join(',')}`)
}
