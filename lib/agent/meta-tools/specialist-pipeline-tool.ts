/**
 * On-demand 8-specialist confluence pipeline - invoked by the main agent
 * when lightweight scouts are insufficient (second option, not upfront default).
 */

import type { ToolDefinition } from '@/lib/ai-tools/types'
import type { LiveGrounding } from '@/lib/agent/live-grounding'
import type { PipelineResult } from '@/lib/agent/pipeline-types'
import {
  renderPipelineBriefForPrompt,
  runChatSpecialistPipeline,
  type PipelineBridgeEmit,
} from '@/lib/agent/orchestrator/pipeline-bridge'

export type PipelineToolContext = {
  grounding?: LiveGrounding
  onPipelineEvent?: PipelineBridgeEmit
  pipelineResultSlot?: { current: PipelineResult | null }
  deadlineMs?: number
  defaultResolution?: string
}

function pushTrace(
  ctx: { trace: { tool: string; args: Record<string, unknown>; ok: boolean; durationMs: number; summary?: string; error?: string }[] },
  ok: boolean,
  start: number,
  summary: string,
  error?: string
) {
  ctx.trace.push({
    tool: 'run_specialist_confluence',
    args: {},
    ok,
    durationMs: Date.now() - start,
    summary,
    error,
  })
  void import('@/lib/tool-usage-tracker').then(({ recordToolCall }) =>
    recordToolCall('run_specialist_confluence', ok)
  )
}

export const RUN_SPECIALIST_CONFLUENCE_TOOL: ToolDefinition = {
  declaration: {
    name: 'run_specialist_confluence',
    description:
      'Run the 8-specialist confluence scan (regime, SMC, technical, momentum, MTF, pattern, events, sentiment). Use ONLY when the user explicitly asks for confluence / institutional / 8-specialist scan - NOT for normal setup or levels questions (use get_technical_analysis + setup scout instead). Call ONCE per turn.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: {
          type: 'STRING',
          description: 'Why deeper confluence is needed (e.g. conflicting TA, user asked for institutional scan).',
        },
        fast: {
          type: 'BOOLEAN',
          description: 'Skip pattern + sentiment specialists when time budget is tight (default false).',
        },
      },
    },
  },
  execute: async (args, ctx) => {
    const start = Date.now()
    const ext = ctx as typeof ctx & PipelineToolContext
    const symbol = ctx.defaultSymbol?.trim().toUpperCase()
    if (!symbol) {
      pushTrace(ctx, false, start, 'no symbol', 'Symbol required')
      return { error: 'No chart symbol - cannot run specialist pipeline.' }
    }

    if (ext.pipelineResultSlot?.current) {
      const existing = ext.pipelineResultSlot.current
      pushTrace(ctx, true, start, `cached confluence ${existing.setup.confluenceScore}/100`)
      return {
        ok: true,
        cached: true,
        confluenceScore: existing.setup.confluenceScore,
        bias: existing.setup.bias,
        entry: existing.setup.entry,
        stopLoss: existing.setup.stopLoss,
        takeProfit: existing.setup.takeProfit,
        blockers: existing.setup.blockers,
        brief: renderPipelineBriefForPrompt(existing),
        message: 'Pipeline already ran this turn - use the brief above.',
      }
    }

    const grounding = ext.grounding
    if (!grounding) {
      pushTrace(ctx, false, start, 'no grounding', 'grounding missing')
      return { error: 'Live grounding unavailable.' }
    }

    const deadlineMs = ext.deadlineMs ?? Date.now() + 60_000
    const emit = ext.onPipelineEvent ?? (() => {})

    try {
      const result = await runChatSpecialistPipeline({
        symbol,
        resolution: ext.defaultResolution,
        grounding,
        deadlineMs,
        emit,
      })

      if (!result) {
        pushTrace(ctx, false, start, 'timeout', 'Pipeline timed out')
        return { error: 'Specialist pipeline timed out - use setup scout evidence instead.' }
      }

      if (ext.pipelineResultSlot) {
        ext.pipelineResultSlot.current = result
      }

      const ps = result.setup
      const summary = `confluence ${ps.confluenceScore}/100 · ${ps.bias}`
      pushTrace(ctx, true, start, summary)

      return {
        ok: true,
        confluenceScore: ps.confluenceScore,
        bias: ps.bias,
        entry: ps.entry,
        stopLoss: ps.stopLoss,
        takeProfit: ps.takeProfit,
        blockers: ps.blockers,
        reasoning: ps.reasoning.slice(0, 600),
        specialistCount: result.reports.length,
        brief: renderPipelineBriefForPrompt(result),
        message:
          'Use this confluence brief for entry/stop/target. Call chart_mcp_draw_setup if chart mode and levels are valid.',
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      pushTrace(ctx, false, start, msg, msg)
      return { error: msg }
    }
  },
}
