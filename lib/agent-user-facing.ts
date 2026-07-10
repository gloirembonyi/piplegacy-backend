/**
 * User-safe labels and error copy for the Market Agent UI.
 * Admins still see technical timeline data from raw AgentWorkState.
 */

import { sanitizeInternalLeaks } from '@/lib/agent/orchestrator/defense'
import {
  formatMarketChatLimitMessage,
  type PlanLimitCopy,
} from '@/lib/plan-limit-messages'
import type { AgentWorkState, StepStatus } from '@/lib/agent-work-state'
import {
  currentRunningActivity,
  spinnerPhaseFromActivity,
} from '@/lib/agent-activity-feed'
import type { AgentSpinnerPhase } from '@/lib/agent-spinner-verbs'

export type UserProgressItem = {
  label: string
  status: StepStatus
}

const FALLBACK_PHASES = [
  'Understanding your question',
  'Reading live market data',
  'Analyzing context',
  'Preparing your answer',
]

/** Shown during pool recovery - never mention keys or providers. */
export function poolWaitUserLabel(seconds: number): string {
  const secs = Math.min(Math.max(1, Math.round(seconds)), 90)
  if (secs <= 2) return 'Catching up - one moment…'
  if (secs <= 12) return `Busy right now - resuming in ~${secs}s…`
  if (secs <= 90) return 'High demand - retrying shortly…'
  return 'High demand - retrying shortly…'
}

/** Server + stream friendly pool status (no key/provider wording). */
export function poolWaitUserMessage(seconds: number): string {
  return poolWaitUserLabel(seconds)
}

const STATUS_REPLACEMENTS: Array<[RegExp, string]> = [
  [/cooling.*auto retrying/i, 'Catching up - one moment…'],
  [/all \d+ ai keys/i, 'Market Agent is busy - retrying shortly…'],
  [/ai key/i, 'Market Agent'],
  [/gemini|deepseek|openai|chatgpt|claude/i, 'Market Agent'],
  [/calling ai model/i, 'Thinking through your question'],
  [/reasoning over data/i, 'Analyzing market context'],
  [/manager plan/i, 'Planning approach'],
  [/recovering/i, 'Catching up'],
  [/pool.?wait/i, 'Brief pause'],
  [/\.env\.local|vercel environment/i, 'account settings'],
]

export function sanitizeUserStatusLabel(label: string): string {
  if (!label?.trim()) return 'Working on your question…'
  let out = label.trim()
  for (const [re, replacement] of STATUS_REPLACEMENTS) {
    out = out.replace(re, replacement)
  }
  return sanitizeInternalLeaks(out)
}

/** User-safe label for live analysis steps - never expose provider or model names. */
export function userFacingAiCallLabel(label: string): string {
  return sanitizeUserStatusLabel(label.replace(/^Gemini\s·\s*/i, ''))
}

export function sanitizeAgentErrorForUser(
  error: string | null | undefined,
  showTechnical: boolean
): string | null {
  if (!error?.trim()) return null
  if (showTechnical) return error

  const lower = error.toLowerCase()
  if (
    lower.includes('cooling') ||
    lower.includes('auto retrying') ||
    lower.includes('rate limit') ||
    lower.includes('ai key') ||
    lower.includes('temporarily busy') ||
    lower.includes('429') ||
    lower.includes('quota')
  ) {
    return 'Market Agent is busy right now. Please wait a moment - your question is still being processed.'
  }
  if (lower.includes('gemini') || lower.includes('deepseek') || lower.includes('.env')) {
    return 'Market Agent is temporarily unavailable. Please try again shortly.'
  }
  if (lower.includes('network') || lower.includes('connection')) {
    return 'Connection issue - check your internet and try again.'
  }
  return sanitizeInternalLeaks(error)
}

/** Plan quota errors - never auto-retry; block the next send in the UI. */
export function isPlanLimitError(error: string | null | undefined): boolean {
  if (!error?.trim()) return false
  const lower = error.toLowerCase()
  return (
    lower.includes('daily limit') ||
    lower.includes('hourly limit') ||
    lower.includes('limit reached') ||
    lower.includes('chat limit') ||
    lower.includes('per day') ||
    lower.includes('per hour')
  )
}

type MarketChatUsageSlice = { remaining: number; limit: number }

export type MarketChatLimitBlock = PlanLimitCopy

/** Client-side gate before starting a new agent run (server remains authoritative). */
export function getMarketChatLimitBlock(
  usage?: {
    marketChatDay?: MarketChatUsageSlice
    marketChatHour?: MarketChatUsageSlice
  },
  plan?: string | null
): MarketChatLimitBlock | null {
  const hour = usage?.marketChatHour
  if (hour && hour.limit >= 0 && hour.remaining <= 0) {
    return formatMarketChatLimitMessage({ kind: 'hour', limit: hour.limit, plan })
  }
  const day = usage?.marketChatDay
  if (day && day.limit >= 0 && day.remaining <= 0) {
    return formatMarketChatLimitMessage({ kind: 'day', limit: day.limit, plan })
  }
  return null
}

/** @deprecated Prefer getMarketChatLimitBlock for upgrade-aware UI. */
export function getMarketChatLimitBlockMessage(
  usage?: {
    marketChatDay?: MarketChatUsageSlice
    marketChatHour?: MarketChatUsageSlice
  },
  plan?: string | null
): string | null {
  return getMarketChatLimitBlock(usage, plan)?.message ?? null
}

/** Whether the client should auto-retry the agent stream after a transient failure. */
export function isRetryableAgentError(error: string | null | undefined): boolean {
  if (!error?.trim()) return false
  if (isPlanLimitError(error)) return false
  const lower = error.toLowerCase()
  return (
    lower.includes('busy') ||
    lower.includes('temporarily') ||
    lower.includes('rate limit') ||
    lower.includes('429') ||
    lower.includes('503') ||
    lower.includes('quota') ||
    lower.includes('connection') ||
    lower.includes('network') ||
    lower.includes('provider is having') ||
    lower.includes('time budget')
  )
}

function countDoneSubAgents(work: AgentWorkState): number {
  return work.steps.filter((s) => s.kind === 'sub_agent' && s.status === 'done').length
}

function countSubAgents(work: AgentWorkState): number {
  return work.steps.filter((s) => s.kind === 'sub_agent').length
}

/** Map internal agent work → user-facing plan checklist (Cursor-style). */
export function deriveUserProgress(
  work: AgentWorkState,
  opts?: { includePending?: boolean }
): UserProgressItem[] {
  const labels =
    work.plan?.progressSteps?.length && work.plan.progressSteps.length > 0
      ? work.plan.progressSteps
      : FALLBACK_PHASES

  const total = labels.length
  let activeIndex = 0

  const active = work.activeStepId
  const toolsRunning = work.tools.some((t) => t.status === 'running')
  const totalSubs = countSubAgents(work)
  const doneSubs = countDoneSubAgents(work)

  if (active === 'compose' || active === 'emergency') {
    activeIndex = total - 1
  } else if (active === 'grounding' || active === 'boot' || !active) {
    activeIndex = 0
  } else if (active === 'plan') {
    activeIndex = Math.min(1, total - 1)
  } else if (active === 'pool-wait') {
    activeIndex = Math.min(Math.max(0, Math.floor(total * 0.25)), total - 1)
  } else if (active === 'tools' || toolsRunning) {
    activeIndex = Math.min(Math.max(2, Math.floor(total * 0.6)), total - 2)
  } else if (active?.startsWith('sub-') || active === 'confluence' || totalSubs > 0) {
    const midStart = 1
    const midEnd = Math.max(midStart, total - 2)
    const span = Math.max(1, midEnd - midStart)
    const ratio = totalSubs > 0 ? doneSubs / totalSubs : 0.35
    activeIndex = Math.min(midEnd, midStart + Math.floor(ratio * span))
  } else if (work.tools.length > 0 && !toolsRunning) {
    activeIndex = Math.min(total - 2, Math.floor(total * 0.75))
  } else {
    activeIndex = Math.min(Math.floor(total * 0.4), total - 2)
  }

  // When run finished (no active step), mark all done
  if (!active && work.steps.some((s) => s.status === 'done')) {
    activeIndex = total
  }

  const items = labels.map((label, i) => ({
    label: sanitizeUserStatusLabel(label),
    status:
      i < activeIndex
        ? ('done' as const)
        : i === activeIndex
          ? ('running' as const)
          : ('pending' as const),
  }))

  if (opts?.includePending === false) {
    return items.filter((i) => i.status === 'done' || i.status === 'running')
  }
  return items
}

/** Steps shown in the UI - regular users only see started steps while live. */
export function deriveUserProgressForDisplay(
  work: AgentWorkState,
  mode: 'live' | 'recorded',
  showAllSteps: boolean
): UserProgressItem[] {
  if (showAllSteps) {
    return deriveUserProgress(work, { includePending: true })
  }
  if (mode === 'recorded') {
    return deriveUserProgress(work, { includePending: false }).filter(
      (i) => i.status === 'done'
    )
  }
  // Live: reveal steps only as they start (done + currently running)
  return deriveUserProgress(work, { includePending: false })
}

export function userFacingStatusLabel(work: AgentWorkState, isRunning: boolean): string {
  const running = currentRunningActivity(work.activities)
  if (running) return running.label

  if (work.activeStepId === 'pool-wait') {
    const secMatch = work.steps
      .find((s) => s.id === 'pool-wait')
      ?.detail?.match(/~(\d+)s/)
    const sec = secMatch ? Number(secMatch[1]) : 5
    return poolWaitUserLabel(sec)
  }

  const items = deriveUserProgress(work)
  const runningItem = items.find((i) => i.status === 'running')
  if (runningItem) return runningItem.label

  if (isRunning) {
    return sanitizeUserStatusLabel(work.currentLabel)
  }

  const lastDone = [...items].reverse().find((i) => i.status === 'done')
  return lastDone?.label ?? sanitizeUserStatusLabel(work.currentLabel)
}

export function userFacingSpinnerPhase(
  work: AgentWorkState
): AgentSpinnerPhase {
  const running = currentRunningActivity(work.activities)
  if (running) return spinnerPhaseFromActivity(running)

  const active = work.activeStepId
  if (active === 'grounding' || active === 'boot') return 'grounding'
  if (active === 'plan') return 'planning'
  if (active === 'tools' || work.tools.some((t) => t.status === 'running')) return 'tool'
  if (active === 'compose' || active === 'emergency') return 'drafting'
  if (active?.startsWith('sub-') || active === 'confluence') return 'reflecting'
  return 'thinking'
}
