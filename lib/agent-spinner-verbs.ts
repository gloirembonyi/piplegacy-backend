/**
 * Rotating loading verbs inspired by Claude's spinner copy
 * (see https://deepakness.com/raw/claude-spinner-verbs/).
 * Pools are scoped by agent phase - not one generic spinner label.
 */

export type AgentSpinnerPhase =
  | 'thinking'
  | 'drafting'
  | 'planning'
  | 'grounding'
  | 'sub_agent'
  | 'tool'
  | 'reflecting'
  | 'idle'

/** General wait - model warming up */
export const THINKING_VERBS = [
  'Thinking',
  'Cogitating',
  'Pondering',
  'Processing',
  'Ruminating',
  'Contemplating',
  'Deliberating',
  'Mulling',
  'Ideating',
  'Analyzing',
] as const

/** Compose / draft answer pass */
export const DRAFTING_VERBS = [
  'Composing',
  'Drafting',
  'Synthesizing',
  'Crystallizing',
  'Formulating',
  'Articulating',
  'Crafting',
  'Generating',
  'Weaving',
  'Polishing',
  'Unfurling',
  'Orchestrating',
] as const

export const PLANNING_VERBS = [
  'Planning',
  'Architecting',
  'Strategizing',
  'Mapping',
  'Scaffolding',
  'Charting',
  'Designing',
  'Structuring',
] as const

export const GROUNDING_VERBS = [
  'Scanning markets',
  'Reading live data',
  'Pulling quotes',
  'Grounding',
  'Syncing snapshot',
  'Checking liquidity',
] as const

export const SUB_AGENT_VERBS = [
  'Scouting',
  'Investigating',
  'Researching',
  'Exploring',
  'Cross-checking',
  'Deep diving',
  'Surveying',
] as const

export const TOOL_VERBS = [
  'Fetching',
  'Crunching',
  'Computing',
  'Reticulating',
  'Running tool',
  'Querying',
  'Loading data',
] as const

export const REFLECTING_VERBS = [
  'Self-checking',
  'Verifying',
  'Reviewing',
  'Validating',
  'Cross-examining',
] as const

const POOLS: Record<AgentSpinnerPhase, readonly string[]> = {
  thinking: THINKING_VERBS,
  drafting: DRAFTING_VERBS,
  planning: PLANNING_VERBS,
  grounding: GROUNDING_VERBS,
  sub_agent: SUB_AGENT_VERBS,
  tool: TOOL_VERBS,
  reflecting: REFLECTING_VERBS,
  idle: ['Ready'],
}

export function verbsForPhase(phase: AgentSpinnerPhase): readonly string[] {
  return POOLS[phase] ?? THINKING_VERBS
}

export function pickVerb(phase: AgentSpinnerPhase, index: number): string {
  const pool = verbsForPhase(phase)
  return pool[index % pool.length] ?? 'Working'
}
