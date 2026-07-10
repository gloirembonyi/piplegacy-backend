/**
 * TypeScript scan pipeline - 8 in-process specialists + confluence orchestrator.
 * Replaces the legacy Python sidecar / Vercel Python serverless engine.
 */

import { runRegimeSpecialist } from '@/lib/agent/specialists/regime'
import { displaySymbolLabel } from '@/lib/symbols'

export const TS_PIPELINE_SPECIALIST_COUNT = 8

export const TS_PIPELINE_SPECIALISTS = [
  'regime',
  'smc',
  'technical',
  'momentum',
  'mtf',
  'pattern',
  'events',
  'sentiment',
] as const

export type ScanPipelineProbeResult = {
  ok: boolean
  latency: number
  detail: string
  engine: 'typescript'
  specialists: number
  legacyPythonEnabled: boolean
}

/** True only when PIPELINE_USE_PYTHON is explicitly enabled (legacy opt-in). */
export function isLegacyPythonPipelineEnabled(): boolean {
  const mode = process.env.PIPELINE_USE_PYTHON?.trim().toLowerCase()
  return mode === 'true' || mode === '1' || mode === 'yes'
}

/** Admin health probe - runs one lightweight specialist against SPY. */
export async function probeScanPipelineHealth(): Promise<ScanPipelineProbeResult> {
  const legacyPythonEnabled = isLegacyPythonPipelineEnabled()
  const start = Date.now()
  const symbol = 'SPY'

  try {
    const racePromise = runRegimeSpecialist({
      symbol,
      symbolLabel: displaySymbolLabel(symbol),
      timeframe: '1h',
    })
    void racePromise.catch(() => {})
    const report = await Promise.race([
      racePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Pipeline probe timed out')), 12_000)
      ),
    ])

    const ok = !report.error && report.confidence >= 0
    const headline = report.headline?.trim() || report.verdict
    const suffix = legacyPythonEnabled ? ' · legacy Python opt-in enabled' : ''

    return {
      ok,
      latency: Date.now() - start,
      detail: ok
        ? `TypeScript · ${TS_PIPELINE_SPECIALIST_COUNT} specialists · ${headline}${suffix}`
        : `Probe failed: ${report.error ?? headline}${suffix}`,
      engine: 'typescript',
      specialists: TS_PIPELINE_SPECIALIST_COUNT,
      legacyPythonEnabled,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      latency: Date.now() - start,
      detail: `TypeScript pipeline unreachable: ${msg}`,
      engine: 'typescript',
      specialists: TS_PIPELINE_SPECIALIST_COUNT,
      legacyPythonEnabled,
    }
  }
}
