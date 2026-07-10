/**
 * Quick local probe for Gemini + DeepSeek keys.
 * Usage: npx tsx scripts/probe-ai-keys.mjs
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

const { runAiHealthCheck } = await import('../lib/ai-health.ts')

const report = await runAiHealthCheck({ probeLive: true })
console.log('--- AI Health ---')
console.log('Recommendation:', report.summary.recommendation)
console.log(`Gemini: ${report.summary.geminiReady}/${report.summary.geminiKeys} ready`)
console.log(`DeepSeek: ${report.summary.deepseekReady}/${report.summary.deepseekKeys} ready`)
console.log('')
for (const p of report.probes) {
  const status = p.ok ? 'OK' : 'FAIL'
  console.log(
    `[${status}] ${p.provider} ...${p.keySuffix} model=${p.model} ${p.latencyMs}ms - ${p.detail}`
  )
}
