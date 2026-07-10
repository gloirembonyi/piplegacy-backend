/**
 * Types + constants for the auto-trader configuration.
 *
 * Split out from `lib/bot-config-store.ts` so client components can safely
 * import these without dragging `fs/promises`, `@neondatabase/serverless`,
 * or Upstash into the browser bundle.
 */

import type { BrokerId } from '@/lib/brokers/types'

export type StrategyTimeframe = '5m' | '15m' | '30m' | '1h' | '4h' | '1d'

export const STRATEGY_TIMEFRAMES: StrategyTimeframe[] = [
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
]

export type BotStrategy = {
  id: string
  /** Friendly name (e.g. "EURUSD 15m scalper"). */
  name: string
  symbol: string
  timeframe: StrategyTimeframe
  brokerId: BrokerId
  /** paper or live (live still requires manual confirmation per scan). */
  mode: 'paper' | 'live'
  enabled: boolean
  /** Confluence score the orchestrator must clear before a trade is placed. */
  confluenceThreshold: number
  /** Per-trade risk in % of equity. */
  riskPct: number
  /** Cap on simultaneous open positions this strategy may hold. */
  maxConcurrent: number
  /** Optional time-of-day window (UTC, HH:MM). Empty = always-on. */
  windowStart?: string
  windowEnd?: string
  /** Server timestamp of the last successful scan + last placed order. */
  lastScanAt?: string | null
  lastOrderAt?: string | null
  createdAt: string
}

export type KillSwitch = {
  /** Hard cap on the daily PnL drawdown (% of starting-of-day equity). */
  dailyLossPct: number
  /** True when the cap was hit today - blocks all new orders. */
  tripped: boolean
  /** Date (YYYY-MM-DD UTC) the cap was tripped. */
  trippedDate: string | null
  /** Optional user-provided reason when manually tripping. */
  reason?: string | null
}

export type BotConfig = {
  email: string
  strategies: BotStrategy[]
  killSwitch: KillSwitch
  updatedAt: string
}

/** Minimum minutes between scans for each timeframe. Pure function - safe on
 *  both client and server. The cron loop uses it to skip strategies that
 *  ticked over more recently than their cadence allows. */
export function tfCadenceMinutes(tf: StrategyTimeframe): number {
  switch (tf) {
    case '5m':
      return 5
    case '15m':
      return 15
    case '30m':
      return 30
    case '1h':
      return 60
    case '4h':
      return 240
    case '1d':
      return 1440
    default:
      return 60
  }
}

/** True if the strategy is currently allowed to place an order. Pure function. */
export function strategyIsRunnable(
  strategy: BotStrategy,
  killSwitch: KillSwitch,
  now = new Date()
): { ok: boolean; reason?: string } {
  if (!strategy.enabled) return { ok: false, reason: 'Disabled' }
  if (killSwitch.tripped) return { ok: false, reason: 'Kill-switch tripped' }
  if (strategy.windowStart && strategy.windowEnd) {
    const hm = now.toISOString().slice(11, 16)
    if (strategy.windowStart <= strategy.windowEnd) {
      if (hm < strategy.windowStart || hm > strategy.windowEnd) {
        return { ok: false, reason: 'Outside trading window' }
      }
    } else {
      if (hm < strategy.windowStart && hm > strategy.windowEnd) {
        return { ok: false, reason: 'Outside trading window' }
      }
    }
  }
  return { ok: true }
}
