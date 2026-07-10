import type { ThreatKind } from './defense'
import type { LiveGrounding } from '@/lib/agent/live-grounding'
import type { UserPreferences } from '@/lib/user-types'

export type AgentIntent =
  | 'setup'
  | 'research'
  | 'macro'
  | 'discovery'
  | 'reversal'
  | 'goal'
  | 'general'
  | 'conversational'
  | 'undercover'

export type ResponseMode = 'conversational' | 'analytical'

export type SubAgentId =
  | 'setup'
  | 'research'
  | 'macro'
  | 'discovery'
  | 'verification'
  | 'liquidity'

export type AgentUserContext = {
  name?: string
  email?: string
  plan?: string
  preferences?: UserPreferences
  watchlist?: string[]
  favorites?: string[]
}

/** Task tags drive dynamic tool selection - not shown to users. */
export type AgentTaskTag =
  | 'levels'
  | 'candle_trigger'
  | 'reversal'
  | 'macro_risk'
  | 'web_research'
  | 'chart_draw'
  | 'personal_goal'
  | 'education'
  | 'smart_money'
  | 'entry_timing'
  | 'confluence_scan'

export type AgentPlan = {
  intent: AgentIntent
  /** Parsed question summary - manager reads this before acting. */
  questionSummary: string
  responseMode: ResponseMode
  /** When false, main loop runs with function calling disabled (hello, thanks, meta). */
  allowToolCalls: boolean
  /** Internal reasoning checklist - LLM prompt only, never shown in UI. */
  selfQuestions: string[]
  /** User-facing progress lines (claw-code-parity style - no internal questions). */
  progressSteps: string[]
  /** Task tags for dynamic scout / gap-fill routing. */
  taskTags: AgentTaskTag[]
  /** Sub-agents to run in parallel (empty = main agent only). */
  subAgents: SubAgentId[]
  /** Tool names the main loop should prioritize (advisory). */
  recommendedTools: string[]
  /** Tools exposed to the main LLM loop (allowlist). */
  allowedTools: string[]
  /** Human-readable routing note for the prompt. */
  routingNote: string
  /** Skip sub-agent pre-fetch for trivial queries. */
  skipPrefetch: boolean
  /** True for setup/reversal chat turns with a symbol - runs a selective
   *  subset of the 8-specialist confluence pipeline (see pipeline-bridge.ts
   *  selectSpecialistsForChat) in addition to the bot scan use of the pipeline. */
  usePipeline: boolean
  /** Estimated effort for UI - light / standard / deep. */
  effort: 'light' | 'standard' | 'deep'
  /** Extraction / jailbreak guard - no tools, sanitized public replies. */
  undercoverMode?: boolean
  threatKind?: ThreatKind
}

export type SubAgentBrief = {
  id: SubAgentId
  ok: boolean
  durationMs: number
  summary: string
  data: Record<string, unknown>
}

import type { ChartStateSnapshot } from '@/lib/chart-state'

export type OrchestratorInput = {
  message: string
  mode: 'chart' | 'insights'
  symbol?: string
  symbolLabel?: string
  resolution?: string
  user?: AgentUserContext
  grounding: LiveGrounding
  /** Live chart canvas snapshot from the client. */
  chartState?: ChartStateSnapshot | null
}

export type ReflectionResult = {
  passed: boolean
  issues: string[]
  suggestions: string[]
}
