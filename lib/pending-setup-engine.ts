/**
 * Price-trigger engine for armed setups.
 * Checks live quote vs entry and executes via the broker when hit.
 */

import type { TradingSetup } from '@/lib/agent/pipeline-types'
import type { BotStrategy } from '@/lib/bot-config-types'
import { getBotConfig } from '@/lib/bot-config-store'
import { evaluateRiskGuard } from '@/lib/bot-risk-guard'
import { resolveBrokerForTrade } from '@/lib/brokers/registry'
import { fetchYahooQuote } from '@/lib/candle-providers/yahoo'
import {
  listPendingSetups,
  patchPendingSetup,
} from '@/lib/pending-setup-store'
import { appendTradeLog } from '@/lib/trade-log-store'
import type { PendingSetup } from '@/lib/pending-setup-types'

/** Tolerance band around entry - scales with price / asset class. */
export function entryTolerance(entry: number, symbol: string): number {
  const upper = symbol.toUpperCase()
  if (upper.includes('JPY') || entry > 50) {
    return Math.max(entry * 0.0003, 0.01)
  }
  if (entry > 10) {
    return Math.max(entry * 0.0005, 0.02)
  }
  return Math.max(entry * 0.001, 0.0001)
}

/** True when live price has reached the entry zone for this bias. */
export function isEntryTriggered(
  bias: 'BUY' | 'SELL',
  entry: number,
  price: number,
  symbol: string
): boolean {
  const tol = entryTolerance(entry, symbol)
  if (bias === 'BUY') return price <= entry + tol
  return price >= entry - tol
}

function toTradingSetup(p: PendingSetup): TradingSetup {
  return {
    symbol: p.symbol,
    symbolLabel: p.symbolLabel,
    timeframe: p.timeframe,
    bias: p.bias,
    confluenceScore: p.confluenceScore,
    entry: p.entry,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    riskRewardRatio:
      p.takeProfit != null && p.entry !== p.stopLoss
        ? Math.abs(p.takeProfit - p.entry) / Math.abs(p.entry - p.stopLoss)
        : null,
    suggestedRiskPct: p.riskPct,
    atr: null,
    validUntil: p.expiresAt,
    reasoning: p.reasoning,
    blockers: [],
  }
}

function pseudoStrategy(p: PendingSetup): BotStrategy {
  return {
    id: p.strategyId ?? `pending-${p.id}`,
    name: `Pending ${p.symbol}`,
    symbol: p.symbol,
    timeframe: p.timeframe as BotStrategy['timeframe'],
    brokerId: p.brokerId,
    mode: p.mode,
    enabled: true,
    confluenceThreshold: 0,
    riskPct: p.riskPct,
    maxConcurrent: 3,
    createdAt: p.createdAt,
  }
}

export type TriggerResult = {
  id: string
  symbol: string
  outcome: 'waiting' | 'triggered' | 'filled' | 'rejected' | 'expired' | 'error'
  detail?: string
  price?: number
}

async function executePending(
  email: string,
  pending: PendingSetup,
  liveTradingAllowed: boolean
): Promise<TriggerResult> {
  const setup = toTradingSetup(pending)
  const strategy = pseudoStrategy(pending)

  const resolved = await resolveBrokerForTrade(email, pending.symbol, pending.brokerId)
  if (!resolved.client) {
    await appendTradeLog(email, {
      kind: 'rejected',
      strategyId: strategy.id,
      symbol: pending.symbol,
      reason: resolved.reason ?? 'No broker for pending setup',
    })
    await patchPendingSetup(email, pending.id, {
      status: 'cancelled',
      cancelReason: resolved.reason ?? 'Broker unavailable',
    })
    return { id: pending.id, symbol: pending.symbol, outcome: 'rejected', detail: resolved.reason }
  }

  const cfg = await getBotConfig(email)
  const guard = await evaluateRiskGuard({
    strategy,
    killSwitch: cfg.killSwitch,
    setup,
    client: resolved.client,
    liveTradingAllowed,
    ignoreSoftBlockers: true,
  })

  if (!guard.ok) {
    await appendTradeLog(email, {
      kind: 'rejected',
      strategyId: strategy.id,
      symbol: pending.symbol,
      reason: guard.reason,
    })
    return {
      id: pending.id,
      symbol: pending.symbol,
      outcome: 'rejected',
      detail: guard.reason,
    }
  }

  try {
    const order = await resolved.client.placeOrder({
      symbol: pending.symbol,
      side: guard.side,
      quantity: guard.quantity,
      type: 'market',
      stopLoss: guard.stopLoss ?? undefined,
      takeProfit: guard.takeProfit ?? undefined,
      clientOrderId: `pending-${pending.id}-${Date.now()}`,
    })

    await appendTradeLog(email, {
      kind: 'placed',
      strategyId: strategy.id,
      brokerId: resolved.client.brokerId,
      mode: pending.mode,
      symbol: pending.symbol,
      side: guard.side,
      quantity: guard.quantity,
      type: 'market',
      orderId: order.id,
      stopLoss: guard.stopLoss,
      takeProfit: guard.takeProfit,
    })

    await patchPendingSetup(email, pending.id, {
      status: 'filled',
      filledAt: new Date().toISOString(),
      orderId: order.id,
    })

    return {
      id: pending.id,
      symbol: pending.symbol,
      outcome: 'filled',
      detail: `Order ${order.id}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Order failed'
    await appendTradeLog(email, {
      kind: 'rejected',
      strategyId: strategy.id,
      symbol: pending.symbol,
      reason: msg,
    })
    return { id: pending.id, symbol: pending.symbol, outcome: 'error', detail: msg }
  }
}

/** Check all armed setups for one user; trigger any that hit entry. */
export async function processPendingSetupsForUser(
  email: string,
  liveTradingAllowed: boolean
): Promise<TriggerResult[]> {
  const armed = await listPendingSetups(email, { status: 'armed' })
  const results: TriggerResult[] = []

  for (const pending of armed) {
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      await patchPendingSetup(email, pending.id, { status: 'expired' })
      results.push({ id: pending.id, symbol: pending.symbol, outcome: 'expired' })
      continue
    }

    let price: number
    try {
      const q = await fetchYahooQuote(pending.symbol)
      if (q?.price == null) {
        results.push({
          id: pending.id,
          symbol: pending.symbol,
          outcome: 'error',
          detail: 'Quote unavailable',
        })
        continue
      }
      price = q.price
    } catch (err) {
      results.push({
        id: pending.id,
        symbol: pending.symbol,
        outcome: 'error',
        detail: err instanceof Error ? err.message : 'Quote failed',
      })
      continue
    }

    await patchPendingSetup(email, pending.id, { lastPrice: price })

    if (!isEntryTriggered(pending.bias, pending.entry, price, pending.symbol)) {
      results.push({
        id: pending.id,
        symbol: pending.symbol,
        outcome: 'waiting',
        price,
        detail: `Waiting for ${pending.bias} @ ${pending.entry}`,
      })
      continue
    }

    await patchPendingSetup(email, pending.id, {
      status: 'triggered',
      triggeredAt: new Date().toISOString(),
      lastPrice: price,
    })

    const exec = await executePending(email, pending, liveTradingAllowed)
    results.push({ ...exec, price })
  }

  return results
}
