/**
 * Pure types for the trade activity log - safe to import from client
 * components (no Node-only deps).
 */

import type { BrokerId, OrderSide } from '@/lib/brokers/types'

export type TradeLogEntry =
  | {
      kind: 'scan'
      id: string
      ts: string
      strategyId: string
      symbol: string
      timeframe: string
      confluenceScore: number
      bias: 'BUY' | 'SELL' | 'HOLD'
      durationMs: number
    }
  | {
      kind: 'proposed'
      id: string
      ts: string
      strategyId: string
      symbol: string
      timeframe: string
      bias: 'BUY' | 'SELL'
      entry: number | null
      stopLoss: number | null
      takeProfit: number | null
      confluenceScore: number
      reasoning: string
    }
  | {
      kind: 'placed'
      id: string
      ts: string
      strategyId: string
      brokerId: BrokerId
      mode: 'paper' | 'live'
      symbol: string
      side: OrderSide
      quantity: number
      type: 'market' | 'limit' | 'stop'
      orderId: string
      stopLoss: number | null
      takeProfit: number | null
    }
  | {
      kind: 'rejected'
      id: string
      ts: string
      strategyId: string | null
      symbol: string
      reason: string
    }
  | {
      kind: 'closed'
      id: string
      ts: string
      strategyId: string | null
      brokerId: BrokerId
      symbol: string
      reason: string
    }

export type TradeLog = {
  email: string
  entries: TradeLogEntry[]
  updatedAt: string
}

/** Distributive Omit so the discriminated union survives call-sites. */
type DistOmit<T, K extends keyof T | string> = T extends unknown
  ? Omit<T, K & keyof T>
  : never

export type TradeLogInput = DistOmit<TradeLogEntry, 'id' | 'ts'>
