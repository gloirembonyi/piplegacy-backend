import { roundMarketPrice } from '@/lib/format-market-price'
import type { MarketChatSetup } from '@/lib/parse-market-chat-json'

/** Reward ÷ risk (e.g. 2 = 1:2). */
export function computeRiskRewardRatio(
  entry: number | null | undefined,
  stop: number | null | undefined,
  target: number | null | undefined
): number | null {
  if (entry == null || stop == null || target == null) return null
  if (!(entry > 0) || !(stop > 0) || !(target > 0)) return null
  const risk = Math.abs(entry - stop)
  const reward = Math.abs(target - entry)
  if (risk <= 0) return null
  return reward / risk
}

export function formatRiskRewardLabel(ratio: number | null): string | null {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return null
  const snapped = snapToStandardRiskReward(ratio)
  if (Math.abs(snapped - Math.round(snapped)) < 0.05) {
    return `1:${Math.round(snapped)}`
  }
  return `1:${snapped.toFixed(1)}`
}

const STANDARD_RRS = [1, 1.5, 2, 2.5, 3, 4] as const

export function snapToStandardRiskReward(ratio: number): number {
  return STANDARD_RRS.reduce((best, cur) =>
    Math.abs(cur - ratio) < Math.abs(best - ratio) ? cur : best
  )
}

export function inferTradeSide(
  setup: Pick<MarketChatSetup, 'bias' | 'entry' | 'stopLoss' | 'takeProfit'>
): 'long' | 'short' | null {
  if (setup.bias === 'BUY') return 'long'
  if (setup.bias === 'SELL') return 'short'
  const { entry, stopLoss, takeProfit } = setup
  if (entry == null || stopLoss == null || takeProfit == null) return null
  if (takeProfit > entry && stopLoss < entry) return 'long'
  if (takeProfit < entry && stopLoss > entry) return 'short'
  return null
}

export function minRiskRewardForTimeframe(tf: string): number {
  const t = tf.toLowerCase()
  if (/\b(5m|15m|scalp)\b/.test(t)) return 1
  if (/\b(30m|1h)\b/.test(t)) return 1.5
  if (/\b(4h|daily|1d|swing|position)\b/.test(t)) return 2
  return 1.5
}

export function preferredRiskRewardForTimeframe(tf: string): number {
  const t = tf.toLowerCase()
  if (/\b(5m|15m|scalp)\b/.test(t)) return 1.5
  if (/\b(30m|1h)\b/.test(t)) return 2
  if (/\b(4h|daily|1d|swing|position)\b/.test(t)) return 3
  return 2
}

export function validateSetupGeometry(setup: MarketChatSetup): string[] {
  const issues: string[] = []
  const { entry, stopLoss, takeProfit, bias } = setup
  if (entry == null || stopLoss == null || takeProfit == null) return issues

  const side = inferTradeSide(setup)
  if (side === 'long') {
    if (stopLoss >= entry) issues.push('Long setup: stop must be below entry.')
    if (takeProfit <= entry) issues.push('Long setup: target must be above entry.')
  } else if (side === 'short') {
    if (stopLoss <= entry) issues.push('Short setup: stop must be above entry.')
    if (takeProfit >= entry) issues.push('Short setup: target must be below entry.')
  }

  if (bias === 'BUY' && side === 'short') {
    issues.push('BUY bias conflicts with stop/target geometry.')
  }
  if (bias === 'SELL' && side === 'long') {
    issues.push('SELL bias conflicts with stop/target geometry.')
  }

  return issues
}

/**
 * Extend or adjust take-profit so reward meets minimum R:R for the timeframe.
 * Entry and stop are kept; only TP moves when the setup is under-structured.
 */
export function enforceMinimumRiskReward(
  setup: MarketChatSetup,
  symbol?: string
): MarketChatSetup {
  const { entry, stopLoss, takeProfit } = setup
  if (entry == null || stopLoss == null || takeProfit == null) return setup

  const side = inferTradeSide(setup)
  if (!side) return setup

  const minR = minRiskRewardForTimeframe(setup.timeframe ?? '')
  const preferR = preferredRiskRewardForTimeframe(setup.timeframe ?? '')
  const risk = Math.abs(entry - stopLoss)
  if (risk <= 0) return setup

  const currentR = computeRiskRewardRatio(entry, stopLoss, takeProfit) ?? 0
  if (currentR >= minR - 0.04) return setup

  const targetR = snapToStandardRiskReward(Math.max(minR, preferR))
  const rewardDist = risk * targetR
  const newTp =
    side === 'long'
      ? roundMarketPrice(entry + rewardDist, symbol)
      : roundMarketPrice(entry - rewardDist, symbol)

  return { ...setup, takeProfit: newTp }
}

/** Round prices, validate geometry, and enforce minimum R:R on active setups. */
export function normalizeAndValidateSetup(
  setup: MarketChatSetup | null,
  symbol?: string
): MarketChatSetup | null {
  if (!setup) return null
  let next: MarketChatSetup = {
    ...setup,
    entry: setup.entry != null ? roundMarketPrice(setup.entry, symbol) : null,
    stopLoss:
      setup.stopLoss != null ? roundMarketPrice(setup.stopLoss, symbol) : null,
    takeProfit:
      setup.takeProfit != null ? roundMarketPrice(setup.takeProfit, symbol) : null,
    invalidation:
      setup.invalidation != null
        ? roundMarketPrice(setup.invalidation, symbol)
        : null,
    triggerZone: setup.triggerZone
      ? {
          top: roundMarketPrice(setup.triggerZone.top, symbol),
          bottom: roundMarketPrice(setup.triggerZone.bottom, symbol),
        }
      : null,
  }

  if (next.bias === 'BUY' || next.bias === 'SELL') {
    next = enforceMinimumRiskReward(next, symbol)
  }

  return next
}
