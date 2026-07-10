/**
 * Groups live agent activities under plan tasks for the user progress UI.
 * Tool codenames are user-facing aliases - not internal tool identifiers.
 */

import {
  currentRunningActivity,
  type UserActivity,
} from '@/lib/agent-activity-feed'
import { deriveUserProgress } from '@/lib/agent-user-facing'
import type { AgentPlanView, AgentWorkState, StepStatus } from '@/lib/agent-work-state'

export type AgentEffort = 'light' | 'standard' | 'deep'

export type AgentTaskView = {
  id: string
  label: string
  status: StepStatus
  activities: UserActivity[]
  /** Friendly codenames for tools used in this task (deduped, ordered). */
  toolCodenames: string[]
}

/** User-facing codenames - intentionally not matching internal tool names. */
const ACTIVITY_CODENAMES: Array<{ match: RegExp | string; code: string }> = [
  { match: /^Searching the web/i, code: 'Web Scout' },
  { match: 'Searching the internet', code: 'Web Scout' },
  { match: 'Reading trend, momentum & structure', code: 'Pulse Scan' },
  { match: 'Scanning recent price action', code: 'Bar Reader' },
  { match: 'Mapping volume profile & POC', code: 'Volume Lens' },
  { match: 'Reading order-book depth', code: 'Depth Probe' },
  { match: 'Pulling institutional metals data', code: 'Metals Feed' },
  { match: 'Checking economic calendar', code: 'Calendar Watch' },
  { match: /^Scanning market headlines/i, code: 'News Wire' },
  { match: 'Researching upcoming catalysts', code: 'Catalyst Hunt' },
  { match: 'Snapshotting cross-asset prices', code: 'Quote Grid' },
  { match: 'Reading crypto sentiment', code: 'Sentiment Gauge' },
  { match: 'Deep market structure scan', code: 'Structure Map' },
  { match: 'Drawing entry, stop & target on chart', code: 'Chart Draft' },
  { match: 'Clearing chart overlays', code: 'Chart Reset' },
  { match: 'Connecting to chart engine', code: 'Chart Link' },
  { match: 'Syncing with TradingView', code: 'TV Bridge' },
  { match: /scout · web/i, code: 'Research Scout' },
  { match: /Macro scout/i, code: 'Macro Scout' },
  { match: /Smart-money liquidity/i, code: 'Liquidity Lens' },
  { match: /Verifying live price/i, code: 'Price Check' },
  { match: /structure, candles & volume/i, code: 'Setup Scan' },
  { match: /Reading chart overlays/i, code: 'Chart Reader' },
  { match: /Checking live price/i, code: 'Price Check' },
  { match: /run_specialist_confluence|Confluence scan/i, code: 'Confluence Engine' },
  { match: /Session timing/i, code: 'Session Clock' },
  { match: /Live quote/i, code: 'Live Ticker' },
  { match: /Reversal check/i, code: 'Reversal Lens' },
  { match: /Regime analysis/i, code: 'Regime Scan' },
  { match: /SMC structure/i, code: 'Structure Scan' },
  { match: /Technical analysis/i, code: 'Pulse Scan' },
  { match: /Momentum analysis/i, code: 'Momentum Scan' },
  { match: /Multi-timeframe/i, code: 'MTF Scan' },
  { match: /Pattern analysis/i, code: 'Pattern Scan' },
  { match: /Events analysis/i, code: 'Event Scan' },
  { match: /Sentiment analysis/i, code: 'Sentiment Scan' },
  { match: /analysis$/i, code: 'Signal Scan' },
]

export function codenameForActivity(activity: UserActivity): string {
  for (const { match, code } of ACTIVITY_CODENAMES) {
    if (typeof match === 'string') {
      if (activity.label.includes(match)) return code
    } else if (match.test(activity.label)) {
      return code
    }
  }
  if (activity.kind === 'think') return 'Reason Engine'
  if (activity.kind === 'reflect') return 'Quality Gate'
  if (activity.kind === 'compose') return 'Answer Builder'
  if (activity.kind === 'plan') return 'Task Planner'
  if (activity.kind === 'grounding') return 'Market Context'
  if (activity.kind === 'wait') return 'Queue Wait'
  return activity.label.split(' ').slice(0, 2).join(' ')
}

function extractCodenames(activities: UserActivity[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of activities) {
    if (
      a.kind !== 'tool' &&
      a.kind !== 'sub_agent' &&
      a.kind !== 'pipeline' &&
      a.kind !== 'think' &&
      a.kind !== 'reflect'
    ) {
      continue
    }
    const code = codenameForActivity(a)
    if (!seen.has(code)) {
      seen.add(code)
      out.push(code)
    }
  }
  return out
}

function assignActivitiesToTasks(
  tasks: AgentTaskView[],
  activities: UserActivity[]
): void {
  if (tasks.length === 0) return

  let currentIdx = 0

  for (const act of activities) {
    const runningIdx = tasks.findIndex((t) => t.status === 'running')
    if (runningIdx >= 0) {
      currentIdx = runningIdx
    }

    if (act.kind === 'grounding' || act.kind === 'plan' || act.kind === 'wait') {
      currentIdx = 0
    } else if (act.kind === 'think' || act.kind === 'reflect' || act.kind === 'compose') {
      currentIdx = tasks.length - 1
    } else if (
      act.kind === 'tool' ||
      act.kind === 'sub_agent' ||
      act.kind === 'pipeline'
    ) {
      if (runningIdx > 0) {
        currentIdx = runningIdx
      } else if (tasks.length > 2) {
        const doneCount = tasks.filter((t) => t.status === 'done').length
        currentIdx = Math.min(Math.max(1, doneCount), tasks.length - 2)
      } else {
        currentIdx = Math.min(1, tasks.length - 1)
      }
    }

    tasks[currentIdx].activities.push(act)

    if (
      act.kind === 'plan' &&
      act.status === 'done' &&
      currentIdx < tasks.length - 1 &&
      tasks[currentIdx + 1].status !== 'pending'
    ) {
      currentIdx += 1
    }
  }

  for (const task of tasks) {
    task.toolCodenames = extractCodenames(task.activities)
  }
}

/** Build task groups from plan steps + live activities. */
export function deriveAgentTasks(
  work: AgentWorkState,
  opts?: { isRunning?: boolean }
): AgentTaskView[] {
  const progressItems =
    work.plan?.progressSteps?.length && work.plan.progressSteps.length > 0
      ? deriveUserProgress(work, { includePending: true })
      : null

  const activities = work.activities

  if (!progressItems || progressItems.length === 0) {
    if (activities.length === 0 && !work.plan) return []
    const status: StepStatus = opts?.isRunning ? 'running' : 'done'
    return [
      {
        id: 'task-0',
        label: work.plan?.intentLabel ?? 'Analysis',
        status,
        activities,
        toolCodenames: extractCodenames(activities),
      },
    ]
  }

  const tasks: AgentTaskView[] = progressItems.map((item, i) => ({
    id: `task-${i}`,
    label: item.label,
    status: item.status,
    activities: [],
    toolCodenames: [],
  }))

  assignActivitiesToTasks(tasks, activities)
  return tasks
}

/** Agent is between tasks - planning or synthesizing before the next step. */
export function isAgentDecidingNext(
  work: AgentWorkState,
  isRunning: boolean
): boolean {
  if (!isRunning) return false
  if (currentRunningActivity(work.activities)) return false

  const tasks = deriveAgentTasks(work, { isRunning })
  const runningTask = tasks.find((t) => t.status === 'running')
  if (runningTask) return false

  const doneCount = tasks.filter((t) => t.status === 'done').length
  const pendingCount = tasks.filter((t) => t.status === 'pending').length
  if (doneCount === 0 || pendingCount === 0) return false

  const active = work.activeStepId
  return (
    active === 'plan' ||
    active?.startsWith('think') ||
    active === 'pool-wait' ||
    work.currentLabel.toLowerCase().includes('synthesiz') ||
    work.currentLabel.toLowerCase().includes('planning')
  )
}

export function effortLabel(effort?: AgentEffort): string {
  if (effort === 'light') return 'Quick reply'
  if (effort === 'deep') return 'Deep research'
  return 'Standard analysis'
}

export function effortFromPlan(plan: AgentPlanView | null): AgentEffort {
  return plan?.effort ?? 'standard'
}

export function visibleTasks(
  tasks: AgentTaskView[],
  mode: 'live' | 'recorded'
): AgentTaskView[] {
  if (mode === 'recorded') {
    return tasks.filter((t) => t.status === 'done' || t.activities.length > 0)
  }
  return tasks.filter(
    (t) => t.status !== 'pending' || t.activities.length > 0
  )
}

export type AgentAchievementSummary = {
  /** Cursor-style one-liner, e.g. "3 web searches · 5 market scans · chart overlay" */
  headline: string
  /** Stat chips for optional expand header */
  stats: Array<{ label: string; count: number }>
  planCompleted: number
  planTotal: number
  /** User-safe activity lines for optional detail expand (codenames, not raw labels) */
  detailLines: Array<{ codename: string; status: StepStatus }>
}

function countByCategory(activities: UserActivity[]): AgentAchievementSummary['stats'] {
  let web = 0
  let scans = 0
  let chart = 0
  let data = 0

  for (const a of activities) {
    if (a.status !== 'done' && a.status !== 'error') continue
    const label = a.label.toLowerCase()
    const code = codenameForActivity(a)

    if (
      label.includes('web') ||
      label.includes('internet') ||
      label.includes('headline') ||
      label.includes('news') ||
      code === 'Web Scout' ||
      code === 'News Wire' ||
      code === 'Research Scout'
    ) {
      web++
    } else if (
      label.includes('chart') ||
      label.includes('draw') ||
      code === 'Chart Draft' ||
      code === 'Chart Link' ||
      code === 'TV Bridge'
    ) {
      chart++
    } else if (a.kind === 'sub_agent' || a.kind === 'pipeline') {
      scans++
    } else if (a.kind === 'tool') {
      data++
    }
  }

  const stats: AgentAchievementSummary['stats'] = []
  if (web > 0) stats.push({ label: 'web search', count: web })
  if (scans > 0) stats.push({ label: 'market scan', count: scans })
  if (data > 0) stats.push({ label: 'data source', count: data })
  if (chart > 0) stats.push({ label: 'chart action', count: chart })
  return stats
}

function formatStatPhrase(stats: AgentAchievementSummary['stats']): string {
  if (stats.length === 0) return 'Analysis complete'
  return stats
    .map(({ label, count }) => {
      const plural = count === 1 ? label : `${label}s`
      return `${count} ${plural}`
    })
    .join(' · ')
}

/** Cursor-style achievement line for completed runs - no internal tool names. */
export function buildAchievementSummary(work: AgentWorkState): AgentAchievementSummary {
  const doneActivities = work.activities.filter(
    (a) => a.status === 'done' || a.status === 'error'
  )
  const stats = countByCategory(doneActivities)
  const progressItems = work.plan?.progressSteps?.length
    ? deriveUserProgress(work, { includePending: false })
    : []
  const planCompleted = progressItems.filter((s) => s.status === 'done').length
  const planTotal = work.plan?.progressSteps?.length ?? progressItems.length

  const headline =
    stats.length > 0
      ? formatStatPhrase(stats)
      : doneActivities.length > 0
        ? `Completed ${doneActivities.length} step${doneActivities.length === 1 ? '' : 's'}`
        : planTotal > 0
          ? `Completed ${planTotal} plan step${planTotal === 1 ? '' : 's'}`
          : 'Analysis complete'

  const seen = new Set<string>()
  const detailLines: AgentAchievementSummary['detailLines'] = []
  for (const a of doneActivities) {
    if (a.kind === 'plan' || a.kind === 'grounding' || a.kind === 'wait') continue
    const code = codenameForActivity(a)
    if (/scout|analysis$|specialist|confluence engine|regime scan|smc|mtf/i.test(code)) {
      if (a.kind === 'sub_agent' || a.kind === 'pipeline') continue
    }
    if (seen.has(code)) continue
    seen.add(code)
    detailLines.push({ codename: code, status: a.status })
  }

  return {
    headline,
    stats,
    planCompleted: planCompleted || planTotal,
    planTotal,
    detailLines,
  }
}

/** Activities worth showing live (exclude meta/plan noise). */
export function liveVisibleActivities(activities: UserActivity[]): UserActivity[] {
  return activities.filter(
    (a) =>
      a.kind !== 'plan' &&
      a.kind !== 'grounding' &&
      !(a.kind === 'wait' && a.status === 'done')
  )
}

/** Currently running tool codename only - not the full history. */
export function currentRunningCodename(work: AgentWorkState): string | null {
  const running = currentRunningActivity(work.activities)
  if (!running) return null
  if (running.kind === 'think' || running.kind === 'reflect' || running.kind === 'compose') {
    return null
  }
  return codenameForActivity(running)
}
