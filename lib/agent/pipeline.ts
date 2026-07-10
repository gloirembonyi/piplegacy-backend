/**
 * Multi-agent trading pipeline.
 *
 * Flow:
 *   1. Pre-fetch live grounding (price, sessions, blackout) - shared with the
 *      Insights chat agent.
 *   2. Fan out 8 specialists in parallel (regime, SMC, technical, momentum,
 *      MTF, pattern, events, sentiment). Each runs ≤ ~9s with fallback rules.
 *   3. Decision orchestrator merges reports into a TradingSetup.
 *
 * `runPipelineStreaming` is the public entry point; it emits PipelineEvents
 * incrementally so the UI can show specialists completing one-by-one.
 */

import { fetchLiveGrounding, type LiveGrounding } from '@/lib/agent/live-grounding'
import { isLegacyPythonPipelineEnabled } from '@/lib/agent/pipeline-engine'
import {
  checkPythonAgentHealth,
  streamPythonPipeline,
} from '@/lib/python-agent/client'
import { displaySymbolLabel } from '@/lib/symbols'
import {
  runDecisionOrchestrator,
} from '@/lib/agent/specialists/orchestrator'
import { runTechnicalSpecialist } from '@/lib/agent/specialists/technical'
import { runMomentumSpecialist } from '@/lib/agent/specialists/momentum'
import { runRegimeSpecialist } from '@/lib/agent/specialists/regime'
import { runSmcSpecialist } from '@/lib/agent/specialists/smc'
import { runMtfSpecialist } from '@/lib/agent/specialists/mtf'
import { runPatternSpecialist } from '@/lib/agent/specialists/pattern'
import { runEventsSpecialist } from '@/lib/agent/specialists/events'
import { runSentimentSpecialist } from '@/lib/agent/specialists/sentiment'
import type { SpecialistContext } from '@/lib/agent/specialists/helpers'
import { specialistRunOk } from '@/lib/agent/specialists/helpers'
import type {
  PipelineEvent,
  PipelineInput,
  PipelineResult,
  SpecialistId,
  SpecialistReport,
} from '@/lib/agent/pipeline-types'
import { recordAgentRun } from '@/lib/tool-usage-tracker'

export type { PipelineInput } from '@/lib/agent/pipeline-types'

type PipelineCoreInput = PipelineInput & {
  symbolLabel: string
  startedAt: string
  startMs: number
}

/** TypeScript specialists are the default. Python is legacy opt-in via PIPELINE_USE_PYTHON=true. */
export function shouldUsePythonEngine(): boolean {
  return isLegacyPythonPipelineEnabled()
}

/** Run specialists + orchestrator using pre-fetched grounding (no duplicate quote fetch). */
async function* runPipelineCore(
  input: PipelineCoreInput,
  grounding: LiveGrounding
): AsyncGenerator<PipelineEvent, PipelineResult | null, void> {
  const { symbol, symbolLabel, timeframe, riskBudgetPct, fast, select, mode } = input
  const ctx: SpecialistContext = {
    symbol,
    symbolLabel,
    timeframe: timeframe!,
    candleCache: new Map(),
  }

  if (shouldUsePythonEngine()) {
    const pythonOk = await checkPythonAgentHealth()
    if (pythonOk) {
      try {
        const pyGen = streamPythonPipeline({
          symbol,
          symbolLabel,
          timeframe: timeframe!,
          riskBudgetPct: riskBudgetPct ?? 1,
          fast: Boolean(fast),
          grounding,
        })
        let pyResult: PipelineResult | null = null
        for await (const event of pyGen) {
          if (event.type === 'grounding' || event.type === 'started') continue
          yield event
          if (event.type === 'done') pyResult = event.result
        }
        if (pyResult) return pyResult
      } catch (err) {
        console.warn(
          '[pipeline] Python engine failed, falling back to TypeScript:',
          err instanceof Error ? err.message : err
        )
      }
    }
  }

  const runners = specialistRunners({ fast: Boolean(fast), select })
  for (const r of runners) {
    yield { type: 'specialist_started', id: r.id }
  }

  const settled = await Promise.allSettled(runners.map((r) => r.run(ctx)))
  const reports: SpecialistReport[] = []
  for (let i = 0; i < runners.length; i++) {
    const r = runners[i]
    const settledRes = settled[i]
    if (settledRes.status === 'fulfilled') {
      reports.push(settledRes.value)
      void recordAgentRun(`specialist:${r.id}`, specialistRunOk(settledRes.value))
      yield { type: 'specialist_done', report: settledRes.value }
    } else {
      const report: SpecialistReport = {
        id: r.id,
        verdict: 'NEUTRAL',
        confidence: 0,
        headline: 'Specialist crashed',
        durationMs: 0,
        degraded: true,
        error:
          settledRes.reason instanceof Error
            ? settledRes.reason.message
            : String(settledRes.reason),
      }
      reports.push(report)
      void recordAgentRun(`specialist:${r.id}`, false)
      yield { type: 'specialist_done', report }
    }
  }

  yield { type: 'orchestrator_started' }
  void recordAgentRun('specialist:orchestrator', true)
  const setup = await runDecisionOrchestrator({
    symbol,
    symbolLabel,
    timeframe: timeframe!,
    grounding,
    reports,
    riskBudgetPct: riskBudgetPct ?? 1,
    mode,
  })

  const finishedAt = new Date().toISOString()
  const result: PipelineResult = {
    symbol,
    symbolLabel,
    timeframe: timeframe!,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Date.now() - input.startMs,
    grounding,
    reports,
    setup,
  }
  yield { type: 'done', result }
  return result
}

/** Chat / cron entry when grounding is already available from the caller. */
export async function* runPipelineStreamingWithGrounding(
  input: PipelineInput,
  grounding: LiveGrounding
): AsyncGenerator<PipelineEvent, PipelineResult | null, void> {
  const symbol = input.symbol.toUpperCase()
  const symbolLabel = displaySymbolLabel(symbol)
  const rawTf = input.timeframe ?? '1h'
  const timeframe = rawTf === '1D' || rawTf === 'D' ? '1d' : rawTf.toLowerCase()
  const startedAt = new Date().toISOString()
  const startMs = Date.now()

  yield { type: 'started', symbol, symbolLabel, timeframe }
  yield {
    type: 'grounding',
    grounding,
    durationMs: 0,
  }

  return yield* runPipelineCore(
    {
      ...input,
      symbol,
      symbolLabel,
      timeframe,
      startedAt,
      startMs,
    },
    grounding
  )
}

type Runner = (ctx: SpecialistContext) => Promise<SpecialistReport>

function specialistRunners(opts: {
  fast?: boolean
  select?: SpecialistId[]
}): Array<{ id: SpecialistId; run: Runner }> {
  const all: Array<{ id: SpecialistId; run: Runner }> = [
    { id: 'regime', run: runRegimeSpecialist },
    { id: 'smc', run: runSmcSpecialist },
    { id: 'technical', run: runTechnicalSpecialist },
    { id: 'momentum', run: runMomentumSpecialist },
    { id: 'mtf', run: runMtfSpecialist },
    { id: 'pattern', run: runPatternSpecialist },
    { id: 'events', run: runEventsSpecialist },
    { id: 'sentiment', run: runSentimentSpecialist },
  ]
  if (opts.select && opts.select.length > 0) {
    const wanted = new Set(opts.select)
    return all.filter((s) => wanted.has(s.id))
  }
  if (!opts.fast) return all
  return all.filter((s) => s.id !== 'pattern' && s.id !== 'sentiment')
}

export async function* runPipelineStreaming(
  input: PipelineInput
): AsyncGenerator<PipelineEvent, PipelineResult | null, void> {
  const symbol = input.symbol.toUpperCase()
  const symbolLabel = displaySymbolLabel(symbol)
  // Normalise timeframe; treat '1D'/'D' as alias for '1d'.
  const rawTf = input.timeframe ?? '1h'
  const timeframe =
    rawTf === '1D' || rawTf === 'D' ? '1d' : rawTf.toLowerCase()
  const riskBudgetPct = input.riskBudgetPct ?? 1
  const startedAt = new Date().toISOString()
  const startMs = Date.now()

  yield { type: 'started', symbol, symbolLabel, timeframe }

  const groundingStart = Date.now()
  const grounding = await fetchLiveGrounding({ symbol, symbolLabel })
  yield {
    type: 'grounding',
    grounding,
    durationMs: Date.now() - groundingStart,
  }

  return yield* runPipelineCore(
    {
      ...input,
      symbol,
      symbolLabel,
      timeframe,
      startedAt,
      startMs,
    },
    grounding
  )
}

/** Non-streaming wrapper for callers that don't need progress events. */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const gen = runPipelineStreaming(input)
  let lastResult: PipelineResult | null = null
  for (;;) {
    const next = await gen.next()
    if (next.done) {
      if (next.value) lastResult = next.value
      break
    }
    if (next.value.type === 'done') lastResult = next.value.result
  }
  if (!lastResult) {
    throw new Error('Pipeline produced no result')
  }
  return lastResult
}
