/**
 * Probe all market + AI keys from .env.local (names only in output - never prints secrets).
 * Usage: npx tsx scripts/probe-env-keys.mjs
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

function mask(key) {
  if (!key || key.length < 6) return key ? '***' : '(unset)'
  return `…${key.slice(-4)}`
}

async function probe(name, fn) {
  const start = Date.now()
  try {
    const r = await fn()
    return { name, ok: r.ok, ms: Date.now() - start, detail: r.detail }
  } catch (e) {
    return {
      name,
      ok: false,
      ms: Date.now() - start,
      detail: e instanceof Error ? e.message.slice(0, 120) : 'failed',
    }
  }
}

const rows = []

rows.push(
  await probe('GEMINI (pool)', async () => {
    const { runAiHealthCheck } = await import('../lib/ai-health.ts')
    const r = await runAiHealthCheck({ probeLive: true })
    const okCount = r.probes.filter((p) => p.ok).length
    return {
      ok: okCount > 0,
      detail: `${okCount}/${r.probes.length} keys OK · ${r.summary.recommendation.slice(0, 80)}`,
    }
  })
)

rows.push(
  await probe('FINNHUB', async () => {
    const key = process.env.FINNHUB_API_KEY?.trim()
    if (!key) return { ok: false, detail: 'FINNHUB_API_KEY unset' }
    const url = `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${key}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const j = await res.json()
    return { ok: typeof j.c === 'number', detail: `AAPL ${j.c}` }
  })
)

rows.push(
  await probe('FMP', async () => {
    const key = process.env.FMP_API_KEY?.trim()
    if (!key) return { ok: false, detail: 'FMP_API_KEY unset' }
    const url = `https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=${key}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const j = await res.json()
    const q = Array.isArray(j) ? j[0] : j
    return { ok: q && typeof q.price === 'number', detail: `AAPL ${q?.price}` }
  })
)

rows.push(
  await probe('ALPHA_VANTAGE', async () => {
    const key = process.env.ALPHA_VANTAGE_API_KEY?.trim()
    if (!key) return { ok: false, detail: 'ALPHA_VANTAGE_API_KEY unset' }
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=${key}`
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
    const j = await res.json()
    const note = j['Note'] || j['Information']
    if (note) return { ok: false, detail: String(note).slice(0, 80) }
    const price = j['Global Quote']?.['05. price']
    return { ok: !!price, detail: price ? `IBM ${price}` : 'no quote' }
  })
)

rows.push(
  await probe('GOOGLE_CSE', async () => {
    const key = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY?.trim()
    const cx = process.env.GOOGLE_CSE_CX?.trim() || '50b16243c51df457f'
    if (!key) return { ok: false, detail: 'GOOGLE_CUSTOM_SEARCH_API_KEY unset' }
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=gold+price&num=1`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const j = await res.json()
    return {
      ok: Array.isArray(j.items) && j.items.length > 0,
      detail: j.items?.[0]?.title?.slice(0, 60) ?? 'no results',
    }
  })
)

rows.push(
  await probe('KV/Redis', async () => {
    const url = process.env.KV_REST_API_URL?.trim()
    const token = process.env.KV_REST_API_TOKEN?.trim()
    if (!url || !token) return { ok: false, detail: 'KV_REST_* unset (usage counters ephemeral)' }
    const res = await fetch(`${url}/ping`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    })
    return { ok: res.ok, detail: res.ok ? 'Upstash ping OK' : `HTTP ${res.status}` }
  })
)

rows.push(
  await probe('CONVEX', async () => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL?.trim()
    if (!url) return { ok: false, detail: 'NEXT_PUBLIC_CONVEX_URL unset' }
    const res = await fetch(`${url.replace(/\/$/, '')}/api/version`, {
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null)
    return {
      ok: !!res?.ok,
      detail: res?.ok ? 'Convex reachable' : 'Could not reach Convex URL',
    }
  })
)

console.log('--- Environment key probe (.env.local) ---\n')
console.log('Configured (masked):')
console.log(`  GEMINI keys: ${[1, 2, 3, 4, 5].filter((i) => process.env[`GEMINI_API_KEY${i === 1 ? '' : '_' + i}`]?.trim() || (i === 1 && process.env.GEMINI_API_KEY?.trim())).length + (process.env.GEMINI_API_KEYS ? '+csv' : 0)}`)
console.log(`  DEEPSEEK keys: ${['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_2'].filter((k) => process.env[k]?.trim()).length}`)
console.log(`  FINNHUB: ${mask(process.env.FINNHUB_API_KEY)}`)
console.log(`  FMP: ${mask(process.env.FMP_API_KEY)}`)
console.log(`  ALPHA_VANTAGE: ${mask(process.env.ALPHA_VANTAGE_API_KEY)}`)
console.log(`  GOOGLE_CSE: ${mask(process.env.GOOGLE_CUSTOM_SEARCH_API_KEY)}`)
console.log(`  GEMINI_CHAT_MODEL: ${process.env.GEMINI_CHAT_MODEL || '(default flash-lite)'}`)
console.log('')
console.log('SERVICE'.padEnd(18), 'STATUS', 'MS', 'DETAIL')
console.log('-'.repeat(72))
for (const r of rows) {
  console.log(
    r.name.padEnd(18),
    (r.ok ? 'OK' : 'FAIL').padEnd(6),
    `${r.ms}ms`.padStart(6),
    r.detail
  )
}
