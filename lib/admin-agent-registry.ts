import { SUB_AGENT_LABELS } from '@/lib/agent-work-ui'
import type { SpecialistId } from '@/lib/agent/pipeline-types'

export type AgentKind = 'sub_agent' | 'pipeline_specialist' | 'orchestrator'

export type AgentRegistryEntry = {
  id: string
  label: string
  kind: AgentKind
  description: string
}

const PIPELINE_SPECIALISTS: Array<{ id: SpecialistId; description: string }> = [
  { id: 'regime', description: 'Market regime (trend/range/volatility)' },
  { id: 'smc', description: 'Smart money structure (BOS/CHoCH, liquidity)' },
  { id: 'technical', description: 'Indicators, swings, key levels' },
  { id: 'momentum', description: 'RSI/MACD momentum alignment' },
  { id: 'mtf', description: 'Multi-timeframe confluence' },
  { id: 'pattern', description: 'Chart pattern recognition' },
  { id: 'events', description: 'Calendar / macro event risk' },
  { id: 'sentiment', description: 'News and sentiment bias' },
]

export const AGENT_REGISTRY: AgentRegistryEntry[] = [
  {
    id: 'setup',
    label: SUB_AGENT_LABELS.setup,
    kind: 'sub_agent',
    description: 'Prefetches structure (TA, candles, volume) or session timing when no symbol',
  },
  {
    id: 'research',
    label: SUB_AGENT_LABELS.research,
    kind: 'sub_agent',
    description: 'Web, news, and catalyst research before the main answer',
  },
  {
    id: 'macro',
    label: SUB_AGENT_LABELS.macro,
    kind: 'sub_agent',
    description: 'Sessions, calendar, cross-asset macro snapshot',
  },
  {
    id: 'discovery',
    label: SUB_AGENT_LABELS.discovery,
    kind: 'sub_agent',
    description: 'Symbol lookup, resolve tickers, instrument search (claw Explore agent)',
  },
  {
    id: 'verification',
    label: SUB_AGENT_LABELS.verification,
    kind: 'sub_agent',
    description: 'Re-check live price, TA, and session timing before setups (claw Verification agent)',
  },
  {
    id: 'liquidity',
    label: SUB_AGENT_LABELS.liquidity,
    kind: 'sub_agent',
    description:
      'Smart Money & Liquidity Analyst - sweeps, EQH/EQL, OB/FVG, order flow, confirmed vs speculative structure',
  },
  ...PIPELINE_SPECIALISTS.map((s) => ({
    id: `specialist:${s.id}`,
    label: SUB_AGENT_LABELS[`specialist:${s.id}`] ?? s.id,
    kind: 'pipeline_specialist' as const,
    description: s.description,
  })),
  {
    id: 'specialist:orchestrator',
    label: SUB_AGENT_LABELS['specialist:orchestrator'],
    kind: 'orchestrator',
    description: 'Merges specialist reports into confluence score and setup',
  },
  {
    id: 'manager',
    label: 'Manager planner',
    kind: 'orchestrator',
    description: 'Rule-based intent routing and sub-agent selection',
  },
  {
    id: 'main_agent',
    label: 'Main chat agent',
    kind: 'orchestrator',
    description: 'Gemini/DeepSeek loop with tool calling and self-check',
  },
]

export function agentRegistryById(id: string): AgentRegistryEntry | undefined {
  return AGENT_REGISTRY.find((a) => a.id === id)
}
