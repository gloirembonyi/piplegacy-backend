/**
 * Final reply synthesis via Gemini after specialist pipeline / scouts finish.
 * Replaces template-only pipeline-bridge copy with question-aware explanations.
 */

import type { LiveGrounding } from '@/lib/agent/live-grounding'
import type { ChartStateSnapshot } from '@/lib/chart-state'
import type { PipelineResult, SpecialistReport } from '@/lib/agent/pipeline-types'
import { callSpecialistModel, parseJsonish } from '@/lib/agent/specialists/helpers'
import { sanitizePublicReply } from '@/lib/agent/orchestrator/defense'
import { isDirectLevelsQuestion } from '@/lib/agent/orchestrator/pipeline-bridge'
import type { AgentPlan, SubAgentBrief } from '@/lib/agent/orchestrator/types'
import type { MarketChatResponse, MarketChatSetup } from '@/lib/parse-market-chat-json'
import {
  isSessionSetupQuestion,
  isTradeManagementQuestion,
  isLiquidityPoolQuestion,
} from '@/lib/setup-reply-format'

const SYNTHESIS_SYSTEM = `You are Piplegacy's lead analyst. Specialists already ran - you write the final chat reply.

Return ONE strict JSON object: {"reply":"markdown prose"}

Answer the USER'S EXACT QUESTION with a format that fits - do NOT reuse one static template every time:
- "setup for Monday / tomorrow / session" → session plan: when to act, what to wait for at open, execution steps (NOT a generic "trade read")
- "where are entry/stop/target" → explain each level's role and distance from live price (compact)
- "buy-side / sell-side liquidity / liquidity pools" → name exact pool prices, what each means, distance from live price - do NOT repeat entry/stop/target setup card
- "give me a setup / trade idea" → narrative trade read with bias + context (vary headings - avoid always "trade read")
- "when to sell/short/exit" → bearish triggers, resistance, invalidation
- "can I buy now / wait" → timing: enter vs wait, what must confirm first
- "can I keep holding" → position management vs active chart setup
- reversal vs continuation → weigh stall signals vs trend structure

Rules:
- Use ONLY facts from EVIDENCE - never invent prices, bias, levels, or confluence
- If bias is HOLD or WAIT, state clearly this is NOT an active trade signal; levels are conditional planning only
- Low confluence (<45): be honest - no edge, wait for confirmation
- Setup card below shows entry/stop/target - explain in prose; do NOT duplicate a price table unless user asked for levels explicitly
- If chart already has an ACTIVE setup, acknowledge it - say whether this is an update or they should clear the chart first
- NO emojis. NO tool/agent names. NO "as an AI". NO provider names
- 2-5 short paragraphs or dash bullets; ### heading only when it helps; vary structure between answers`

function formatReportLine(r: SpecialistReport): string {
  const parts = [`${r.id}: ${r.verdict} (${r.confidence}%)`]
  if (r.situation?.trim()) parts.push(r.situation.trim())
  else if (r.headline?.trim()) parts.push(r.headline.trim())
  if (r.blockers?.length) parts.push(`blockers: ${r.blockers.slice(0, 2).join('; ')}`)
  return parts.join(' - ')
}

function setupEvidence(setup: MarketChatSetup | null | undefined): string {
  if (!setup) return 'No setup card.'
  const lines = [
    `Card bias: ${setup.bias}`,
    `Confluence: ${setup.confidence}/100`,
    setup.timeframe ? `Timeframe: ${setup.timeframe}` : null,
    setup.entry != null ? `Entry: ${setup.entry}` : 'Entry: none',
    setup.stopLoss != null ? `Stop: ${setup.stopLoss}` : 'Stop: none',
    setup.takeProfit != null ? `Target: ${setup.takeProfit}` : 'Target: none',
    setup.triggerCondition ? `Plan: ${setup.triggerCondition}` : null,
    setup.risks.length ? `Risks: ${setup.risks.slice(0, 3).join('; ')}` : null,
  ].filter(Boolean)
  return lines.join('\n')
}

function questionKind(message: string, plan: AgentPlan): string {
  const msg = message.trim()
  if (isTradeManagementQuestion(msg)) return 'position_management'
  if (isLiquidityPoolQuestion(msg) && !isDirectLevelsQuestion(msg)) return 'liquidity_pools'
  if (isSessionSetupQuestion(msg)) return 'session_setup'
  if (isDirectLevelsQuestion(msg)) return 'direct_levels'
  if (plan.taskTags.includes('entry_timing') || /\b(sell|short|exit)\b/i.test(msg)) {
    return 'entry_exit_timing'
  }
  if (plan.intent === 'reversal' || plan.taskTags.includes('reversal')) return 'reversal_continuation'
  if (plan.intent === 'setup' || plan.taskTags.includes('levels')) return 'trade_setup'
  return 'market_analysis'
}

function chartStateEvidence(state: ChartStateSnapshot | null | undefined): string | null {
  if (!state?.drawingCount) return 'No active chart setup or drawings.'
  const lines = [
    `Drawings on chart: ${state.drawingCount} (${state.aiDrawingCount} agent, ${state.userDrawingCount} user)`,
  ]
  if (state.activeSetup) {
    const s = state.activeSetup
    lines.push(
      `ACTIVE SETUP: ${s.side.toUpperCase()} entry ${s.entry}, SL ${s.stopLoss}, TP ${s.takeProfit}${s.pending ? ' [pending]' : ''}`,
      'User may want to update, replace, or manage THIS setup - reference these levels when relevant.'
    )
  }
  return lines.join('\n')
}

function buildUserPrompt(opts: {
  userMessage: string
  symbolLabel: string
  plan: AgentPlan
  grounding: LiveGrounding
  draft: MarketChatResponse
  pipeline?: PipelineResult | null
  subAgentBriefs?: SubAgentBrief[]
  chartState?: ChartStateSnapshot | null
}): string {
  const ps = opts.pipeline?.setup
  const quote = opts.grounding.quote
  const kind = questionKind(opts.userMessage, opts.plan)

  const lines = [
    `User question: "${opts.userMessage.trim()}"`,
    `Question kind: ${kind}`,
    `Intent: ${opts.plan.intent}`,
    `Symbol: ${opts.symbolLabel}`,
    quote
      ? `Live: ${quote.price} (${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%)`
      : null,
    opts.grounding.activeSessions?.length
      ? `Sessions: ${opts.grounding.activeSessions.join(', ')}`
      : null,
    '',
    '--- CHART CANVAS ---',
    chartStateEvidence(opts.chartState) ?? 'Chart state not provided.',
    '',
    '--- PIPELINE SETUP ---',
    ps
      ? [
          `Rule bias: ${ps.bias}`,
          `Confluence: ${ps.confluenceScore}/100`,
          `Entry: ${ps.entry ?? 'none'}`,
          `Stop: ${ps.stopLoss ?? 'none'}`,
          `Target: ${ps.takeProfit ?? 'none'}`,
          ps.riskRewardRatio != null ? `R:R ${ps.riskRewardRatio.toFixed(1)}` : null,
          ps.blockers.length ? `Blockers: ${ps.blockers.join('; ')}` : null,
          ps.reasoning?.trim() ? `Reasoning: ${ps.reasoning.slice(0, 400)}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      : 'Pipeline setup not available.',
    '',
    '--- SETUP CARD (shown separately in UI) ---',
    setupEvidence(opts.draft.setup),
    '',
  ]

  if (opts.pipeline?.reports?.length) {
    lines.push('--- SPECIALIST REPORTS ---')
    for (const r of opts.pipeline.reports) {
      lines.push(formatReportLine(r))
    }
    lines.push('')
  }

  if (opts.subAgentBriefs?.length) {
    lines.push('--- SCOUT NOTES ---')
    for (const b of opts.subAgentBriefs.slice(0, 4)) {
      if (b.summary?.trim()) lines.push(`${b.id}: ${b.summary.trim().slice(0, 280)}`)
    }
    lines.push('')
  }

  if (opts.draft.reply?.trim()) {
    lines.push(
      '--- DRAFT (rewrite completely for the user question; do not copy headings or table layout verbatim) ---',
      opts.draft.reply.trim()
    )
  }

  lines.push('', 'Return ONLY the JSON object.')
  return lines.filter((l) => l !== null).join('\n')
}

/** Gemini final reply - keeps setup/levels from draft, rewrites narrative. */
export async function synthesizePipelineReplyWithGemini(opts: {
  draft: MarketChatResponse
  userMessage: string
  symbolLabel: string
  plan: AgentPlan
  grounding: LiveGrounding
  pipeline?: PipelineResult | null
  subAgentBriefs?: SubAgentBrief[]
  chartState?: ChartStateSnapshot | null
  userEmail?: string
}): Promise<MarketChatResponse> {
  const userPrompt = buildUserPrompt(opts)

  for (const temperature of [0.35, 0.2] as const) {
    const r = await callSpecialistModel({
      systemPrompt: SYNTHESIS_SYSTEM,
      userPrompt,
      maxTokens: 900,
      temperature,
      source: 'pipeline_reply',
      userEmail: opts.userEmail,
    })

    if (r.ok) {
      const parsed = parseJsonish<{ reply?: string }>(r.text, {})
      const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
      if (reply.length > 40) {
        return {
          ...opts.draft,
          reply: sanitizePublicReply(reply),
        }
      }
    }
  }

  return opts.draft
}
