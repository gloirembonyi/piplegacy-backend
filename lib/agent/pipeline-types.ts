/**
 * Types shared by the multi-agent pipeline (lib/agent/pipeline.ts) and the
 * UI components that render its output (Chart Analysis right rail,
 * Auto-Trader page, audit log).
 */

import type { LiveGrounding } from '@/lib/agent/live-grounding'
import type { PendingSetup } from '@/lib/pending-setup-types'

export type SpecialistId =
  | 'technical'
  | 'momentum'
  | 'regime'
  | 'smc'
  | 'mtf'
  | 'pattern'
  | 'events'
  | 'sentiment'

export type SpecialistVerdict = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'AVOID'

export type SpecialistReport = {
  id: SpecialistId
  verdict: SpecialistVerdict
  /** 0-100 confidence the specialist has in its own verdict. */
  confidence: number
  /** Short, scannable headline (≤140 chars). */
  headline: string
  /** What price is doing right now - situational narrative (not just bullish/bearish). */
  situation?: string
  /** Optional structured data (verdict-specific). */
  data?: Record<string, unknown>
  /** Optional risk flags raised (block trade / size down). */
  blockers?: string[]
  /** Wall-clock duration of the specialist run. */
  durationMs: number
  /** True when the specialist hit an error and returned a fallback verdict. */
  degraded?: boolean
  error?: string
}

export type TradingSetup = {
  symbol: string
  symbolLabel: string
  timeframe: string
  bias: 'BUY' | 'SELL' | 'HOLD'
  /** Weighted confluence score across specialists (0-100). */
  confluenceScore: number
  entry: number | null
  stopLoss: number | null
  takeProfit: number | null
  riskRewardRatio: number | null
  /** Suggested position-size hint (in % of equity, not absolute units). */
  suggestedRiskPct: number
  /** ATR(14) from the technical specialist - used by UI for quick-fill SL/TP. */
  atr?: number | null
  validUntil: string | null
  reasoning: string
  blockers: string[]
}

export type PipelineResult = {
  symbol: string
  symbolLabel: string
  timeframe: string
  startedAt: string
  finishedAt: string
  durationMs: number
  grounding: LiveGrounding
  reports: SpecialistReport[]
  setup: TradingSetup
}

/** Streamable events emitted by the pipeline (for SSE/NDJSON in the UI). */
export type PipelineEvent =
  | { type: 'started'; symbol: string; symbolLabel: string; timeframe: string }
  | { type: 'grounding'; grounding: LiveGrounding; durationMs: number }
  | { type: 'specialist_started'; id: SpecialistId }
  | { type: 'specialist_done'; report: SpecialistReport }
  | { type: 'orchestrator_started' }
  | { type: 'pending_armed'; pending: PendingSetup }
  | { type: 'done'; result: PipelineResult }
  | { type: 'error'; error: string; status?: number; upgradeRequired?: boolean }

export type PipelineInput = {
  symbol: string
  timeframe?: string
  /** Risk budget (% of equity) the orchestrator should size to. Default 1%. */
  riskBudgetPct?: number
  /** When true, the technical + pattern specialists are skipped to keep
   *  the run under a tight latency budget (cron use). Default false. */
  fast?: boolean
  /** Restrict the run to this subset of specialists (chat's selective
   *  dispatch). When omitted, all 8 run (bot auto-trade scan behavior). */
  select?: SpecialistId[]
  /** Orchestrator synthesis prompt variant. 'bot' (default) keeps the
   *  aggressive auto-trade trigger philosophy; 'chat' is neutral about
   *  WAIT/HOLD being a valid outcome. */
  mode?: 'bot' | 'chat'
}
