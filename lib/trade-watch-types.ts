/**
 * Trade Watch - monitors watchlist pairs for movement + AI setups.
 */

import type { TradingSetup } from '@/lib/agent/pipeline-types'

export type MovementState = 'calm' | 'building' | 'moving' | 'breakout'

export type TradeWatchAlertKind =
  | 'movement'
  | 'breakout'
  | 'setup'
  | 'session'
  | 'catalyst'

export type TradeWatchAlertSeverity = 'info' | 'warning' | 'critical'

export type PairScanState = {
  symbol: string
  lastScanAt: string
  lastPrice: number | null
  changePercent: number | null
  signalScore: number
  movementState: MovementState
  direction: 'up' | 'down' | 'neutral'
  reasons: string[]
  lastAiScanAt?: string
  lastSetupBias?: TradingSetup['bias']
  lastConfluence?: number
}

export type TradeWatchConfig = {
  /** Master switch - when off, scans are manual only. */
  enabled: boolean
  /** Run AI pipeline when movement score crosses threshold. */
  autoAnalyze: boolean
  /** Request browser push notifications for new alerts. */
  browserNotify: boolean
  /** Client polling interval hint (minutes). */
  scanIntervalMinutes: 5 | 15 | 30
  /** Default timeframe for AI scans. */
  defaultTimeframe: '15m' | '1h' | '4h' | '1d'
  /** Per-symbol last scan snapshot. */
  pairStates: Record<string, PairScanState>
}

export type TradeWatchAlert = {
  id: string
  symbol: string
  kind: TradeWatchAlertKind
  severity: TradeWatchAlertSeverity
  title: string
  detail: string
  signalScore?: number
  movementState?: MovementState
  setup?: Pick<
    TradingSetup,
    | 'bias'
    | 'entry'
    | 'stopLoss'
    | 'takeProfit'
    | 'confluenceScore'
    | 'reasoning'
    | 'timeframe'
  >
  href?: string
  read: boolean
  createdAt: string
  expiresAt?: string
}

export type TradeWatchBook = {
  email: string
  config: TradeWatchConfig
  alerts: TradeWatchAlert[]
  updatedAt: string
}

export const DEFAULT_TRADE_WATCH_CONFIG: TradeWatchConfig = {
  enabled: false,
  autoAnalyze: true,
  browserNotify: false,
  scanIntervalMinutes: 5,
  defaultTimeframe: '1h',
  pairStates: {},
}

export const ALERT_CAP = 80
export const AI_SCAN_COOLDOWN_MS = 2 * 60 * 60_000
export const ALERT_DEDUPE_MS = 45 * 60_000
export const MOVEMENT_AI_THRESHOLD = 55
