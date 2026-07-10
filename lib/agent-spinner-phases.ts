import type { AgentSpinnerPhase } from '@/lib/agent-spinner-verbs'
import type { AgentWorkState, WorkStep } from '@/lib/agent-work-state'
import type { AgentToolEvent } from '@/lib/agent-work-ui'
import { toolLabel } from '@/lib/agent-work-ui'

export type AgentSpinnerVariant = 'braille' | 'orbit' | 'bars' | 'scan' | 'pulse'

export function phaseForStepKind(kind: WorkStep['kind']): AgentSpinnerPhase {
  switch (kind) {
    case 'grounding':
      return 'grounding'
    case 'plan':
      return 'planning'
    case 'sub_agent':
      return 'sub_agent'
    case 'tools':
      return 'tool'
    case 'think':
    case 'model':
    case 'compose':
      return 'drafting'
    case 'reflect':
      return 'reflecting'
    case 'pool_wait':
      return 'thinking'
    default:
      return 'thinking'
  }
}

export function variantForPhase(phase: AgentSpinnerPhase): AgentSpinnerVariant {
  switch (phase) {
    case 'grounding':
      return 'scan'
    case 'sub_agent':
      return 'orbit'
    case 'tool':
      return 'bars'
    case 'reflecting':
      return 'pulse'
    case 'planning':
    case 'drafting':
    case 'thinking':
      return 'braille'
    default:
      return 'braille'
  }
}

export function resolveWorkSpinnerPhase(work: AgentWorkState): AgentSpinnerPhase {
  if (!work.activeStepId) {
    const runningTool = work.tools.find((t) => t.status === 'running')
    if (runningTool) return 'tool'
    return 'idle'
  }

  const step = work.steps.find((s) => s.id === work.activeStepId)
  if (step) return phaseForStepKind(step.kind)

  if (work.activeStepId === 'tools' || work.tools.some((t) => t.status === 'running')) {
    return 'tool'
  }

  return 'thinking'
}

export function resolveStepSpinnerPhase(step: WorkStep): AgentSpinnerPhase {
  return phaseForStepKind(step.kind)
}

export function runningToolLabel(tools: AgentToolEvent[]): string | null {
  const running = tools.find((t) => t.status === 'running')
  if (!running) return null
  return toolLabel(running.tool)
}
