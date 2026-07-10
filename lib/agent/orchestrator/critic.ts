/**
 * Bounded second-opinion pass on a draft specialist setup before it reaches
 * chat. One cheap extra model call - not a re-run of the pipeline - that can
 * downgrade an unsupported BUY/SELL to HOLD (which the chat merge step then
 * surfaces as an honest WAIT). Fails open: any critic infra issue just
 * returns the original draft unchanged rather than blocking the reply.
 */

import type { LiveGrounding } from '@/lib/agent/live-grounding'
import type { PipelineResult } from '@/lib/agent/pipeline-types'
import { callSpecialistModel, parseJsonish } from '@/lib/agent/specialists/helpers'

const SYSTEM = `You are a skeptical second-opinion reviewer checking a draft trade read before it reaches a trader. Return ONE strict JSON object:
{"approved":boolean,"reason":"<=200 chars","forceWait":boolean}

Reject (approved:false, forceWait:true) when:
- entry/stop/target are not geometrically sane vs the live price (e.g. stop on the wrong side of entry, an unrealistic target distance).
- the confluence score is not actually backed by the specialist votes below (e.g. score looks inflated relative to how many specialists genuinely agree).
- specialists meaningfully contradict each other and the draft picked a side anyway without real justification.

Otherwise approve. Be honest, not contrarian - a well-supported read should be approved.`

export async function runSetupCritic(
  pipeline: PipelineResult,
  opts: { grounding: LiveGrounding }
): Promise<PipelineResult> {
  const { setup, reports } = pipeline
  // Already an honest WAIT/HOLD - nothing to critique.
  if (setup.bias === 'HOLD') return pipeline

  const votes = reports
    .map((r) => `- ${r.id}: ${r.verdict} (${r.confidence}%)${r.degraded ? ' degraded' : ''}`)
    .join('\n')

  const userPrompt = `Symbol: ${pipeline.symbolLabel} (${pipeline.symbol})  Timeframe: ${pipeline.timeframe}
Live price: ${opts.grounding.quote?.price ?? 'unknown'}
Draft: ${setup.bias} entry=${setup.entry ?? '-'} stop=${setup.stopLoss ?? '-'} target=${setup.takeProfit ?? '-'} confluence=${setup.confluenceScore}/100 R:R=${setup.riskRewardRatio?.toFixed(1) ?? '-'}
Blockers already flagged: ${setup.blockers.join('; ') || 'none'}

Specialist votes:
${votes}

Return ONLY the strict JSON object specified.`

  const r = await callSpecialistModel({
    systemPrompt: SYSTEM,
    userPrompt,
    maxTokens: 256,
    temperature: 0.1,
  })

  // Fail open - a critic infra issue should never block an otherwise-valid answer.
  if (!r.ok) return pipeline

  type ParsedCritic = { approved?: boolean; reason?: string; forceWait?: boolean }
  const parsed = parseJsonish<ParsedCritic>(r.text, {})
  if (parsed.approved !== false && !parsed.forceWait) return pipeline

  const reason = (parsed.reason ?? 'Second-opinion review found this read not well-supported').trim()
  return {
    ...pipeline,
    setup: {
      ...setup,
      bias: 'HOLD',
      blockers: [...new Set([...setup.blockers, reason])].slice(0, 6),
      reasoning: `${setup.reasoning} · Critic override: ${reason}`.slice(0, 500),
    },
  }
}
