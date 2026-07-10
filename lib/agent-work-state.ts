/**
 * Reducer: NDJSON agent stream events → Cursor-style work timeline state.
 */

import type { AgentStreamEvent } from '@/lib/agent-stream'
import type { StoredAgentTrace as UserStoredAgentTrace } from '@/lib/user-types'
import type { AgentToolEvent } from '@/lib/agent-work-ui'
import {
  coerceAgentToolEvents,
  INTENT_LABELS,
  SUB_AGENT_LABELS,
  subAgentLabel,
  toolLabel,
} from '@/lib/agent-work-ui'
import {
  activitiesFromTools,
  completeActivitiesExcept,
  completeAllActivities,
  type UserActivity,
  upsertUserActivity,
  userActivityLabelForSubAgent,
  userActivityLabelForTool,
  userActivityPhaseForTool,
} from '@/lib/agent-activity-feed'
import { userFacingAiCallLabel } from '@/lib/agent-user-facing'

export type { UserActivity } from '@/lib/agent-activity-feed'

export type StepStatus = 'pending' | 'running' | 'done' | 'error'

export type WorkStep = {
  id: string
  kind:
    | 'grounding'
    | 'plan'
    | 'confluence'
    | 'sub_agent'
    | 'tools'
    | 'think'
    | 'reflect'
    | 'model'
    | 'pool_wait'
    | 'compose'
  label: string
  detail?: string
  status: StepStatus
  durationMs?: number
}

export type AgentPlanView = {
  intent: string
  intentLabel: string
  subAgents: string[]
  /** User-safe progress lines - internal self-questions are never shown. */
  progressSteps: string[]
  taskTags?: string[]
  /** Estimated effort tier for UI (light / standard / deep). */
  effort?: 'light' | 'standard' | 'deep'
}

export type GeminiCallEvent = {
  id: string
  source: string
  label: string
  model: string
  tokens: number
  at: number
}

export type AgentWorkState = {
  steps: WorkStep[]
  plan: AgentPlanView | null
  tools: AgentToolEvent[]
  /** Live user-facing activity feed (dynamic, event-driven). */
  activities: UserActivity[]
  /** Internal AI synthesis calls during this run (admin/telemetry only - UI uses generic labels). */
  geminiCalls: GeminiCallEvent[]
  activeStepId: string | null
  iteration: number
  model: string | null
  /** Shown in header pulse line */
  currentLabel: string
  /** Last self-check outcome */
  reflectionPassed: boolean | null
}

export const INITIAL_AGENT_WORK: AgentWorkState = {
  steps: [],
  plan: null,
  tools: [],
  activities: [],
  geminiCalls: [],
  activeStepId: null,
  iteration: 0,
  model: null,
  currentLabel: 'Starting…',
  reflectionPassed: null,
}

function toolArgsKey(args?: Record<string, unknown>): string {
  if (!args) return ''
  const sym = args.symbol
  return typeof sym === 'string' ? sym : JSON.stringify(args).slice(0, 80)
}

function isDuplicateToolCall(
  tools: AgentToolEvent[],
  tool: string,
  args?: Record<string, unknown>
): boolean {
  const key = toolArgsKey(args)
  return tools.some(
    (t) =>
      t.tool === tool &&
      toolArgsKey(t.args) === key &&
      (t.status === 'running' || t.status === 'ok')
  )
}

function upsertStep(
  steps: WorkStep[],
  id: string,
  patch: Partial<WorkStep> & Pick<WorkStep, 'kind' | 'label'>
): WorkStep[] {
  const idx = steps.findIndex((s) => s.id === id)
  if (idx >= 0) {
    const next = [...steps]
    next[idx] = { ...next[idx], ...patch }
    return next
  }
  return [...steps, { id, status: 'pending' as StepStatus, ...patch }]
}

function markRunning(steps: WorkStep[], id: string): WorkStep[] {
  return steps.map((s) =>
    s.id === id
      ? { ...s, status: 'running' }
      : s.status === 'running'
        ? { ...s, status: 'done' }
        : s
  )
}

function markDone(steps: WorkStep[], id: string, detail?: string, durationMs?: number): WorkStep[] {
  return steps.map((s) =>
    s.id === id
      ? {
          ...s,
          status: 'done' as StepStatus,
          detail: detail ?? s.detail,
          durationMs: durationMs ?? s.durationMs,
        }
      : s
  )
}

export function reduceAgentWork(
  state: AgentWorkState,
  ev: AgentStreamEvent
): AgentWorkState {
  switch (ev.type) {
    case 'open':
      return {
        ...INITIAL_AGENT_WORK,
        currentLabel: `Analyzing ${ev.label}`,
        activities: [
          {
            id: 'grounding',
            kind: 'grounding',
            label: 'Syncing live market snapshot',
            status: 'running',
            phase: 'grounding',
            at: Date.now(),
          },
        ],
        steps: upsertStep([], 'grounding', {
          kind: 'grounding',
          label: 'Live market snapshot',
          status: 'running',
        }),
        activeStepId: 'grounding',
      }

    case 'grounding': {
      const ms = ev.durationMs
      const g = ev.grounding
      const detailParts: string[] = []
      if (g.quote) {
        detailParts.push(`Price ${g.quote.price}`)
        detailParts.push(
          `${g.quote.changePercent >= 0 ? '+' : ''}${g.quote.changePercent.toFixed(2)}%`
        )
      }
      detailParts.push(`${g.liquidity} liquidity`)
      if (g.activeSessions.length) detailParts.push(g.activeSessions.join(', '))
      if (g.nextHighImpact) detailParts.push(g.nextHighImpact.event)
      if (g.newsBlackout) detailParts.push('News blackout active')
      const detail = detailParts.join(' · ')
      const completedGrounding = completeActivitiesExcept(state.activities).map((a) =>
        a.id === 'grounding'
          ? { ...a, status: 'done' as const, detail: detail.slice(0, 80) }
          : a
      )
      return {
        ...state,
        steps: markDone(state.steps, 'grounding', detail, ms),
        activities: upsertUserActivity(completedGrounding, 'plan', {
          kind: 'plan',
          label: 'Understanding your question',
          status: 'running',
          phase: 'planning',
        }),
        currentLabel: 'Planning approach',
        activeStepId: 'plan',
      }
    }

    case 'planning': {
      const intentLabel = INTENT_LABELS[ev.intent] ?? ev.intent
      const subLabel =
        ev.subAgents.length > 0
          ? ev.subAgents.map((a) => SUB_AGENT_LABELS[a] ?? a).join(' + ')
          : 'Main agent only'
      let steps = markDone(state.steps, 'grounding')
      steps = upsertStep(steps, 'plan', {
        kind: 'plan',
        label: 'Manager plan',
        detail: `${intentLabel} · ${subLabel}`,
        status: 'running',
      })
      for (const agent of ev.subAgents) {
        const id = `sub-${agent}`
        steps = upsertStep(steps, id, {
          kind: 'sub_agent',
          label: subAgentLabel(agent),
          status: 'pending',
        })
      }
      return {
        ...state,
        steps,
        plan: {
          intent: ev.intent,
          intentLabel,
          subAgents: ev.subAgents,
          progressSteps: ev.progressSteps,
          taskTags: ev.taskTags,
          effort: ev.effort,
        },
        activities: upsertUserActivity(
          completeActivitiesExcept(state.activities, undefined).map((a) =>
            a.id === 'plan' ? { ...a, status: 'done' as const } : a
          ),
          'plan-done',
          {
            kind: 'plan',
            label: `Plan · ${intentLabel}`,
            status: 'done',
            phase: 'planning',
            detail: subLabel,
          }
        ),
        activeStepId: 'plan',
        currentLabel: `Planning · ${intentLabel}`,
      }
    }

    case 'confluence_start': {
      const id = 'confluence'
      const actId = 'pipeline-confluence'
      return {
        ...state,
        steps: markRunning(
          upsertStep(markDone(state.steps, 'plan', state.plan?.intentLabel), id, {
            kind: 'confluence',
            label: 'Specialist confluence',
            status: 'pending',
          }),
          id
        ),
        activities: upsertUserActivity(
          completeActivitiesExcept(state.activities),
          actId,
          {
            kind: 'pipeline',
            label: 'Running specialist confluence scan',
            status: 'running',
            phase: 'sub_agent',
          }
        ),
        activeStepId: id,
        currentLabel: 'Running specialist confluence scan',
      }
    }

    case 'confluence': {
      const detail = `${ev.bias} · ${ev.score}/100${ev.blockers?.length ? ` · ${ev.blockers.slice(0, 2).join(', ')}` : ''}`
      return {
        ...state,
        steps: markDone(state.steps, 'confluence', detail),
        activities: upsertUserActivity(
          completeActivitiesExcept(state.activities).map((a) =>
            a.id === 'pipeline-confluence'
              ? { ...a, status: 'done' as const, detail: `${ev.score}/100 · ${ev.bias}` }
              : a
          ),
          'pipeline-confluence',
          {
            kind: 'pipeline',
            label: 'Specialist confluence scan',
            status: 'done',
            phase: 'sub_agent',
            detail: `${ev.score}/100 · ${ev.bias}`,
          }
        ),
        currentLabel: `Confluence ${ev.score}/100`,
      }
    }

    case 'sub_agent_start': {
      const id = `sub-${ev.agent}`
      const actId = `act-${id}`
      return {
        ...state,
        steps: markRunning(
          markDone(state.steps, 'plan', state.plan?.intentLabel),
          id
        ),
        activities: upsertUserActivity(completeActivitiesExcept(state.activities), actId, {
          kind: 'sub_agent',
          label: userActivityLabelForSubAgent(ev.agent),
          status: 'running',
          phase: 'sub_agent',
        }),
        activeStepId: id,
        currentLabel: userActivityLabelForSubAgent(ev.agent),
      }
    }

    case 'sub_agent_done': {
      const id = `sub-${ev.agent}`
      const actId = `act-${id}`
      return {
        ...state,
        steps: markDone(
          state.steps,
          id,
          ev.summary,
          ev.durationMs
        ).map((s) =>
          s.id === id && !ev.ok ? { ...s, status: 'error' as StepStatus } : s
        ),
        activities: upsertUserActivity(
          completeActivitiesExcept(state.activities).map((a) =>
            a.id === actId
              ? {
                  ...a,
                  status: (ev.ok ? 'done' : 'error') as StepStatus,
                  detail: ev.summary?.slice(0, 72),
                }
              : a
          ),
          actId,
          {
            kind: 'sub_agent',
            label: userActivityLabelForSubAgent(ev.agent),
            status: ev.ok ? 'done' : 'error',
            phase: 'sub_agent',
            detail: ev.summary?.slice(0, 72),
          }
        ),
        currentLabel: 'Drafting answer',
        activeStepId: 'compose',
      }
    }

    case 'ai_call': {
      const id = `ai-${ev.source}-${state.geminiCalls.length}`
      return {
        ...state,
        geminiCalls: [
          ...state.geminiCalls,
          {
            id,
            source: ev.source,
            label: ev.label,
            model: ev.model,
            tokens: ev.tokens,
            at: Date.now(),
          },
        ],
        activities: upsertUserActivity(state.activities, id, {
          kind: 'think',
          label: userFacingAiCallLabel(ev.label),
          status: 'done',
          phase: 'thinking',
        }),
      }
    }

    case 'thinking': {
      const id = 'compose'
      const actId = `think-act-${ev.iteration}`
      const thinkLabel =
        ev.iteration === 0
          ? 'Drafting answer'
          : `Drafting answer · pass ${ev.iteration + 1}`
      let steps = state.steps
      steps = markDone(steps, 'pool-wait')
      for (const s of steps) {
        if (s.kind === 'sub_agent' && s.status === 'running') {
          steps = markDone(steps, s.id)
        }
      }
      steps = upsertStep(steps, id, {
        kind: 'compose',
        label: thinkLabel,
        status: 'running',
      })
      if (state.tools.some((t) => t.status === 'running' || t.status === 'ok')) {
        steps = upsertStep(steps, 'tools', {
          kind: 'tools',
          label: 'Tool calls',
          status: 'running',
        })
      }
      const activities = upsertUserActivity(
        completeActivitiesExcept(state.activities),
        actId,
        {
          kind: 'think',
          label: thinkLabel,
          status: 'running',
          phase: 'drafting',
        }
      )
      return {
        ...state,
        steps: markRunning(steps, id),
        activities,
        iteration: ev.iteration,
        activeStepId: id,
        currentLabel: thinkLabel,
      }
    }

    case 'model':
      return {
        ...state,
        model: ev.model,
        currentLabel: 'Thinking through your question',
      }

    case 'pool_wait': {
      const id = 'pool-wait'
      const userDetail = ev.message ?? `~${ev.seconds}s`
      return {
        ...state,
        steps: markRunning(
          upsertStep(state.steps, id, {
            kind: 'pool_wait',
            label: 'Brief pause',
            detail: userDetail,
            status: 'running',
          }),
          id
        ),
        activities: upsertUserActivity(completeActivitiesExcept(state.activities), 'pool-wait', {
          kind: 'wait',
          label: ev.message ?? `High demand · resuming in ~${ev.seconds}s`,
          status: 'running',
          phase: 'thinking',
          detail: userDetail,
        }),
        activeStepId: id,
        currentLabel: ev.message ?? `Busy - resuming in ~${ev.seconds}s…`,
      }
    }

    case 'emergency_finish':
      return {
        ...state,
        currentLabel: 'Wrapping up from gathered data',
        steps: markRunning(
          upsertStep(state.steps, 'compose', {
            kind: 'compose',
            label: 'Drafting answer',
            detail: ev.reason.slice(0, 80),
            status: 'running',
          }),
          'compose'
        ),
        activeStepId: 'compose',
      }

    case 'tool_call': {
      if (isDuplicateToolCall(state.tools, ev.tool, ev.args)) {
        return state
      }
      const tools: AgentToolEvent[] = [
        ...state.tools,
        {
          callId: ev.callId,
          tool: ev.tool,
          args: ev.args,
          status: 'running',
        },
      ]
      let steps = upsertStep(state.steps, 'tools', {
        kind: 'tools',
        label: 'Tool calls',
        status: 'running',
        detail: toolLabel(ev.tool),
      })
      const thinkId = 'compose'
      if (steps.some((s) => s.id === thinkId && s.status === 'running')) {
        steps = markDone(steps, thinkId, 'Tools requested')
      }
      const actLabel = userActivityLabelForTool(ev.tool, ev.args)
      return {
        ...state,
        tools,
        activities: upsertUserActivity(completeActivitiesExcept(state.activities), ev.callId, {
          kind: 'tool',
          label: actLabel,
          status: 'running',
          phase: userActivityPhaseForTool(ev.tool),
        }),
        steps: markRunning(steps, 'tools'),
        activeStepId: 'tools',
        currentLabel: actLabel,
      }
    }

    case 'tool_result': {
      const tools = state.tools.map((t) =>
        t.callId === ev.callId
          ? {
              ...t,
              status: ev.ok ? ('ok' as const) : ('error' as const),
              summary: ev.summary,
              error: ev.error,
              durationMs: ev.durationMs,
            }
          : t
      )
      const running = tools.some((t) => t.status === 'running')
      const actLabel = userActivityLabelForTool(ev.tool)
      const detail = ev.ok ? ev.summary?.slice(0, 72) : ev.error?.slice(0, 72)
      return {
        ...state,
        tools,
        activities: upsertUserActivity(
          state.activities.map((a) =>
            a.id === ev.callId
              ? {
                  ...a,
                  status: (ev.ok ? 'done' : 'error') as StepStatus,
                  detail,
                }
              : a
          ),
          ev.callId,
          {
            kind: 'tool',
            label: actLabel,
            status: ev.ok ? 'done' : 'error',
            phase: userActivityPhaseForTool(ev.tool),
            detail,
          }
        ),
        steps: state.steps.map((s) =>
          s.id === 'tools'
            ? {
                ...s,
                status: running ? ('running' as StepStatus) : ('done' as StepStatus),
                detail: running
                  ? toolLabel(tools.find((t) => t.status === 'running')?.tool ?? '')
                  : `${tools.filter((t) => t.status === 'ok').length} tools completed`,
              }
            : s
        ),
        currentLabel: running
          ? userActivityLabelForTool(
              tools.find((t) => t.status === 'running')?.tool ?? ev.tool,
              tools.find((t) => t.status === 'running')?.args
            )
          : 'Processing results',
      }
    }

    case 'ask_user':
      return {
        ...state,
        currentLabel: 'Waiting for your input',
        steps: upsertStep(state.steps, 'clarify', {
          kind: 'compose',
          label: 'Clarifying question',
          detail: ev.question.slice(0, 80),
          status: 'running',
        }),
        activeStepId: 'clarify',
      }

    case 'reflecting': {
      const id = 'reflect'
      const detail = ev.passed
        ? 'Levels and risk validated'
        : ev.issues?.[0]?.slice(0, 80) ?? 'Revising answer'
      return {
        ...state,
        reflectionPassed: ev.passed,
        steps: markRunning(
          upsertStep(state.steps, id, {
            kind: 'reflect',
            label: 'Self-check',
            status: 'running',
            detail,
          }),
          id
        ),
        activities: upsertUserActivity(completeActivitiesExcept(state.activities), 'reflect', {
          kind: 'reflect',
          label: 'Verifying levels, risk & answer quality',
          status: 'running',
          phase: 'reflecting',
          detail,
        }),
        activeStepId: id,
        currentLabel: ev.passed ? 'Finalizing' : 'Self-check · revising',
      }
    }

    case 'final': {
      const passed = ev.reflectionPassed ?? state.reflectionPassed ?? true
      const reflectDetail = passed ? 'Passed' : 'Completed with notes'
      let steps = markDone(state.steps, 'reflect', reflectDetail)
      if (!passed) {
        steps = steps.map((s) =>
          s.id === 'reflect' ? { ...s, status: 'done' as StepStatus, detail: reflectDetail } : s
        )
      }
      steps = markRunning(steps, 'compose')
      steps = markDone(steps, 'compose', 'Ready', undefined)
      for (const s of steps) {
        if (s.status === 'running') steps = markDone(steps, s.id)
      }
      return {
        ...state,
        steps,
        activities: completeAllActivities(state.activities).concat([
          {
            id: 'compose-done',
            kind: 'compose',
            label: 'Answer ready',
            status: 'done',
            phase: 'drafting',
            at: Date.now(),
          },
        ]),
        reflectionPassed: passed,
        activeStepId: null,
        currentLabel: 'Done',
      }
    }

    case 'error':
      return {
        ...state,
        currentLabel: ev.error,
        steps: state.steps.map((s) =>
          s.status === 'running' ? { ...s, status: 'error' as StepStatus, detail: ev.error } : s
        ),
        activeStepId: null,
      }

    case 'done':
      if (ev.error) {
        return {
          ...state,
          currentLabel: ev.error,
          activeStepId: null,
        }
      }
      return {
        ...state,
        model: ev.model ?? state.model,
        currentLabel: 'Done',
        activeStepId: null,
      }

    default:
      return state
  }
}

/** Tool list + timeline for live assistant bubble. */
export function workStateToToolEvents(state: AgentWorkState): AgentToolEvent[] {
  return state.tools
}

/** Lightweight snapshot persisted on assistant messages for replay. */
export type StoredAgentTrace = {
  plan: AgentPlanView | null
  steps: WorkStep[]
  tools: AgentToolEvent[]
  activities?: UserActivity[]
  model: string | null
}

/** Coerce JSON / user-store trace into strict work-state shape. */
export function parseStoredAgentTrace(
  trace: UserStoredAgentTrace | StoredAgentTrace | null | undefined
): StoredAgentTrace | undefined {
  if (!trace) return undefined

  const rawPlan = trace.plan
  const plan: AgentPlanView | null = rawPlan
    ? {
        intent: rawPlan.intent,
        intentLabel: rawPlan.intentLabel,
        subAgents: rawPlan.subAgents,
        progressSteps:
          rawPlan.progressSteps ??
          (rawPlan as { selfQuestions?: string[] }).selfQuestions?.map((q) =>
            q.replace(/^What is the user actually asking\? \(literal: "[^"]*"\)$/, 'Analyzed your question')
          ) ??
          [],
        taskTags: 'taskTags' in rawPlan ? (rawPlan as AgentPlanView).taskTags : undefined,
        effort: 'effort' in rawPlan ? (rawPlan as AgentPlanView).effort : undefined,
      }
    : null

  return {
    plan,
    steps: (trace.steps ?? []) as WorkStep[],
    tools: coerceAgentToolEvents(trace.tools) ?? [],
    activities:
      'activities' in trace && Array.isArray(trace.activities)
        ? trace.activities
        : undefined,
    model: trace.model ?? null,
  }
}

export function serializeAgentWork(state: AgentWorkState): StoredAgentTrace {
  const finalizeStatus = (s: StepStatus): StepStatus =>
    s === 'running' ? 'done' : s

  return {
    plan: state.plan,
    steps: state.steps.map((s) => ({
      ...s,
      status: finalizeStatus(s.status),
    })),
    tools: state.tools.map((t) => ({
      ...t,
      status: t.status === 'running' ? ('ok' as const) : t.status,
    })),
    activities: completeAllActivities(state.activities),
    model: state.model,
  }
}

export function traceToWorkState(trace: StoredAgentTrace): AgentWorkState {
  const okTools = trace.tools.filter((t) => t.status === 'ok').length
  const totalMs = trace.tools.reduce((n, t) => n + (t.durationMs ?? 0), 0)
  const durationLabel =
    totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : totalMs > 0 ? `${totalMs}ms` : null

  const plan = trace.plan
    ? {
        ...trace.plan,
        progressSteps:
          trace.plan.progressSteps ??
          (trace.plan as { selfQuestions?: string[] }).selfQuestions?.map((q) =>
            q.replace(/^What is the user actually asking\? \(literal: "[^"]*"\)$/, 'Analyzed your question')
          ) ??
          [],
      }
    : null

  return {
    plan,
    steps: trace.steps as WorkStep[],
    tools: trace.tools,
    activities:
      trace.activities?.length
        ? trace.activities
        : activitiesFromTools(trace.tools),
    geminiCalls: [],
    activeStepId: null,
    iteration: 0,
    model: trace.model,
    reflectionPassed: null,
    currentLabel:
      trace.tools.length > 0
        ? `Completed · ${okTools}/${trace.tools.length} tools${durationLabel ? ` · ${durationLabel}` : ''}`
        : 'Completed',
  }
}

/** Back-compat when only tool events were saved in memory. */
export function toolEventsToTrace(
  tools: AgentToolEvent[],
  model?: string | null
): StoredAgentTrace {
  return {
    plan: null,
    steps: tools.length
      ? [
          {
            id: 'tools',
            kind: 'tools',
            label: 'Tool calls',
            status: 'done',
            detail: `${tools.filter((t) => t.status === 'ok').length} completed`,
          },
        ]
      : [],
    tools,
    model: model ?? null,
  }
}
