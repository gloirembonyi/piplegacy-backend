/**
 * Risk guard - last line of defence before any order hits the broker.
 *
 * Enforces:
 *  - Strategy must be enabled and inside its trading window.
 *  - Kill-switch is not tripped.
 *  - Account daily loss < killSwitch.dailyLossPct → otherwise trip + reject.
 *  - Open positions for the strategy < strategy.maxConcurrent.
 *  - Computed quantity > 0 and notional > broker minimum.
 *  - In live mode, an extra hard-gate flag is required (defaults off in v1).
 *
 * Returns a quantity to trade or a typed rejection reason.
 */

import type {
  BotStrategy,
  KillSwitch,
} from '@/lib/bot-config-store'
import { strategyIsRunnable } from '@/lib/bot-config-store'
import type {
  BrokerAccount,
  BrokerClient,
  OrderSide,
  Position,
} from '@/lib/brokers/types'
import type { TradingSetup } from '@/lib/agent/pipeline-types'

export type RiskGuardInput = {
  strategy: BotStrategy
  killSwitch: KillSwitch
  setup: TradingSetup
  client: BrokerClient
  /** Set to true only when the user has explicitly opted in to live trading
   *  on the global settings page (additional UI gate). */
  liveTradingAllowed: boolean
  /** When true, regime caution blockers (sideways, compression) are warnings
   *  only - hard blockers (news blackout) still veto. Used for manual trades
   *  and armed pending triggers the user explicitly requested. */
  ignoreSoftBlockers?: boolean
}

export type RiskGuardOutput =
  | {
      ok: true
      side: OrderSide
      quantity: number
      stopLoss: number | null
      takeProfit: number | null
      tripKillSwitch: false
      account: BrokerAccount
    }
  | {
      ok: false
      reason: string
      tripKillSwitch: boolean
    }

function roundUnits(qty: number, fractional: boolean): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0
  if (fractional) {
    return Number(qty.toFixed(6))
  }
  return Math.max(1, Math.floor(qty))
}

/** News blackouts are hard vetoes; regime caution is soft (user can override). */
function isHardBlocker(reason: string): boolean {
  const lower = reason.toLowerCase()
  return (
    lower.includes('blackout') ||
    lower.includes('high-impact') ||
    lower.includes('news') ||
    lower.includes('events veto')
  )
}

export async function evaluateRiskGuard(
  input: RiskGuardInput
): Promise<RiskGuardOutput> {
  const { strategy, killSwitch, setup, client, liveTradingAllowed, ignoreSoftBlockers } =
    input

  if (strategy.mode === 'live' && !liveTradingAllowed) {
    return {
      ok: false,
      reason: 'Live trading is disabled globally - flip the safety toggle first.',
      tripKillSwitch: false,
    }
  }

  const runnable = strategyIsRunnable(strategy, killSwitch)
  if (!runnable.ok) {
    return { ok: false, reason: runnable.reason ?? 'Strategy not runnable', tripKillSwitch: false }
  }

  if (setup.bias === 'HOLD' || setup.entry == null || setup.stopLoss == null) {
    return {
      ok: false,
      reason: 'No actionable setup (bias HOLD or missing entry/stop).',
      tripKillSwitch: false,
    }
  }

  if (setup.confluenceScore < strategy.confluenceThreshold) {
    return {
      ok: false,
      reason: `Confluence ${setup.confluenceScore} < threshold ${strategy.confluenceThreshold}`,
      tripKillSwitch: false,
    }
  }

  const blockers = setup.blockers ?? []
  const hardBlockers = blockers.filter(isHardBlocker)
  if (hardBlockers.length > 0) {
    return {
      ok: false,
      reason: `Setup blocked: ${hardBlockers.join('; ')}`,
      tripKillSwitch: false,
    }
  }
  if (!ignoreSoftBlockers && blockers.length > 0) {
    return {
      ok: false,
      reason: `Setup blocked: ${blockers.join('; ')}`,
      tripKillSwitch: false,
    }
  }

  let account: BrokerAccount
  let positions: Position[]
  try {
    ;[account, positions] = await Promise.all([
      client.getAccount(),
      client.getPositions(),
    ])
  } catch (err) {
    return {
      ok: false,
      reason: `Broker fetch failed: ${err instanceof Error ? err.message : 'unknown'}`,
      tripKillSwitch: false,
    }
  }

  if (!account.tradingEnabled) {
    return { ok: false, reason: 'Broker has trading disabled.', tripKillSwitch: false }
  }

  // Daily loss kill-switch (uses broker-reported PnL when available).
  if (
    account.dailyPnl != null &&
    account.equity > 0 &&
    (account.dailyPnl / account.equity) * 100 <= -killSwitch.dailyLossPct
  ) {
    return {
      ok: false,
      reason: `Daily loss ${(account.dailyPnl / account.equity * 100).toFixed(2)}% exceeded -${killSwitch.dailyLossPct}% cap.`,
      tripKillSwitch: true,
    }
  }

  const stratPositions = positions.filter(
    (p) => p.symbol.toUpperCase() === setup.symbol.toUpperCase()
  )
  if (stratPositions.length >= strategy.maxConcurrent) {
    return {
      ok: false,
      reason: `Already at maxConcurrent (${strategy.maxConcurrent}) for ${setup.symbol}.`,
      tripKillSwitch: false,
    }
  }

  const side: OrderSide = setup.bias === 'BUY' ? 'buy' : 'sell'
  const riskPerUnit = Math.abs(setup.entry - setup.stopLoss)
  if (riskPerUnit <= 0) {
    return { ok: false, reason: 'Stop loss equals entry - zero risk per unit.', tripKillSwitch: false }
  }
  const riskCashBudget = account.equity * (strategy.riskPct / 100)
  const rawQty = riskCashBudget / riskPerUnit
  const quantity = roundUnits(rawQty, client.capabilities.fractional)

  if (quantity <= 0) {
    return {
      ok: false,
      reason: `Computed quantity rounds to zero (risk ${riskCashBudget.toFixed(2)} ${account.currency} / per-unit ${riskPerUnit}).`,
      tripKillSwitch: false,
    }
  }

  const minUsd = client.capabilities.minOrderUsd
  if (minUsd != null && setup.entry * quantity < minUsd) {
    return {
      ok: false,
      reason: `Notional ${(setup.entry * quantity).toFixed(2)} below broker min ${minUsd}.`,
      tripKillSwitch: false,
    }
  }

  return {
    ok: true,
    side,
    quantity,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    tripKillSwitch: false,
    account,
  }
}
