/**
 * Probe all registered agent tools + print health summary.
 * Usage: npx tsx scripts/probe-agent-health.ts
 */

import { clearAdminToolProbeCache, probeAllAdminTools } from '../lib/admin-tool-probes'
import { listRegisteredToolNames } from '../lib/ai-tools/registry'

async function main() {
  clearAdminToolProbeCache()
  const names = listRegisteredToolNames()
  console.log(`\nProbing ${names.length} tools…\n`)

  const results = await probeAllAdminTools({ force: true })
  let ok = 0
  let fail = 0
  let optional = 0

  const rows: Array<{ name: string; status: string; detail: string; ms: number }> = []

  for (const name of names.sort()) {
    const r = results.get(name)
    if (!r) {
      rows.push({ name, status: 'MISSING', detail: 'no probe result', ms: 0 })
      fail++
      continue
    }
    if (r.optional) {
      optional++
      rows.push({ name, status: 'OPTIONAL', detail: r.detail, ms: r.latencyMs })
    } else if (r.ok) {
      ok++
      rows.push({ name, status: 'OK', detail: r.detail, ms: r.latencyMs })
    } else {
      fail++
      rows.push({ name, status: 'FAIL', detail: r.detail, ms: r.latencyMs })
    }
  }

  const col = (s: string, w: number) => s.padEnd(w).slice(0, w)
  console.log(`${col('TOOL', 32)} ${col('STATUS', 10)} ${col('MS', 6)} DETAIL`)
  console.log('-'.repeat(90))
  for (const row of rows) {
    console.log(
      `${col(row.name, 32)} ${col(row.status, 10)} ${String(row.ms).padStart(4)}ms  ${row.detail}`
    )
  }

  console.log('\n---')
  console.log(`OK: ${ok}  FAIL: ${fail}  OPTIONAL: ${optional}  TOTAL: ${names.length}`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
