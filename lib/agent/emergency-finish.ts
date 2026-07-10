/**
 * Emergency finish - when the agent stalls or nears its deadline, synthesize
 * a best-effort answer from evidence already gathered (claw-style compaction).
 * User-visible text must NEVER include orchestrator / scout / tool internals.
 */

import type { MarketChatResponse } from '@/lib/parse-market-chat-json'
import type { LiveGrounding } from '@/lib/agent/live-grounding'
import type { PipelineResult } from '@/lib/agent/pipeline-types'
import type { AgentPlan } from '@/lib/agent/orchestrator/types'
import type { SubAgentBrief } from '@/lib/agent/orchestrator/types'
import {
  renderUserEvidenceSummary,
  userFacingEmergencyReason,
} from '@/lib/agent/orchestrator/user-evidence'
import { sanitizePublicReply } from '@/lib/agent/orchestrator/defense'

export type EmergencyFinishInput = {
  userMessage: string
  symbolLabel?: string
  grounding: LiveGrounding
  plan: AgentPlan
  reason: string
  subAgentBriefs?: SubAgentBrief[]
  pipelineResult?: PipelineResult | null
}

export function buildEmergencyMarketResponse(
  input: EmergencyFinishInput
): MarketChatResponse {
  const symbol = input.symbolLabel ?? 'this market'
  const why = userFacingEmergencyReason(input.reason)

  const evidence = renderUserEvidenceSummary({
    briefs: input.subAgentBriefs,
    pipeline: input.pipelineResult,
    intent: input.plan.intent,
    userMessage: input.userMessage,
  })

  const priceLine = input.grounding.quote
    ? `**Price:** ${input.grounding.quote.price} (${input.grounding.quote.changePercent >= 0 ? '+' : ''}${input.grounding.quote.changePercent.toFixed(2)}%)`
    : ''

  const replyParts = [
    `I couldn't finish the full analysis (${why}), but here's what I found for **${symbol}**:`,
    '',
    priceLine,
    evidence ? `\n${evidence}` : '',
    '',
    'Ask again with a focused question (e.g. "tomorrow\'s calendar only" or "5m long setup") for a complete answer.',
  ].filter(Boolean)

  const reply = sanitizePublicReply(replyParts.join('\n'))

  const isConversational =
    input.plan.responseMode === 'conversational' || input.plan.intent === 'conversational'

  return {
    reply,
    setup: isConversational
      ? null
      : {
          bias: 'WAIT',
          entryType: 'market',
          entry: null,
          triggerZone: null,
          triggerCondition: 'Partial analysis only - not a live entry signal',
          validUntil: 'Re-ask for a fresh setup',
          invalidation: null,
          stopLoss: null,
          takeProfit: null,
          confidence: 0,
          timeframe: input.plan.intent === 'setup' ? '15m' : '1h',
          confirmation: 'Based on partial data - verify before trading',
          risks: ['Analysis incomplete', 'Not a live entry signal'],
        },
    levels: [],
    zones: [],
    drawIntent: false,
  }
}
