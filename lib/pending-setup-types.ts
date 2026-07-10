/**
 * Armed / pending trade setups - wait for price to reach entry before executing.
 * Types are client-safe (no Node deps).
 */

import type { BrokerId } from '@/lib/brokers/types'
import type { TradingSetup } from '@/lib/agent/pipeline-types'

export type PendingSetupStatus =
  | 'armed'
  | 'triggered'
  | 'filled'
  | 'cancelled'
  | 'expired'

export type PendingSetup = {
  id: string
  symbol: string
  symbolLabel: string
  timeframe: string
  bias: 'BUY' | 'SELL'
  entry: number
  stopLoss: number
  takeProfit: number | null
  confluenceScore: number
  reasoning: string
  riskPct: number
  brokerId: BrokerId
  mode: 'paper' | 'live'
  strategyId: string | null
  status: PendingSetupStatus
  createdAt: string
  updatedAt: string
  expiresAt: string
  armedPrice: number | null
  lastPrice: number | null
  triggeredAt: string | null
  filledAt: string | null
  orderId: string | null
  cancelReason: string | null
}

export type PendingSetupBook = {
  email: string
  setups: PendingSetup[]
  updatedAt: string
}

export type ArmPendingInput = {
  setup: TradingSetup
  brokerId: BrokerId
  mode?: 'paper' | 'live'
  strategyId?: string | null
  riskPct?: number
  /** Live quote when armed - used for trigger cross detection. */
  armedPrice?: number | null
}
