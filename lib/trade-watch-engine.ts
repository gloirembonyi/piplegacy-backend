/**
 * Movement detection for Trade Watch - pure functions, easy to test.
 */

import type { MovementState, PairScanState } from '@/lib/trade-watch-types'

export type PulseLevels = {
  todayOpen: number | null
  todayHigh: number | null
  todayLow: number | null
  recentHigh: number | null
  recentLow: number | null
  atr14: number | null
}

export type MovementInput = {
  price: number
  changePercent: number
  levels: PulseLevels
  /** Price from the previous scan (optional). */
  prevPrice?: number | null
  /** Minutes since previous scan. */
  minutesSincePrev?: number
}

export type MovementResult = {
  signalScore: number
  movementState: MovementState
  direction: 'up' | 'down' | 'neutral'
  reasons: string[]
}

function pctDist(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return Infinity
  return (Math.abs(a - b) / Math.abs(b)) * 100
}

export function detectMovementSignal(input: MovementInput): MovementResult {
  const { price, changePercent, levels, prevPrice, minutesSincePrev } = input
  let score = 0
  const reasons: string[] = []
  let direction: 'up' | 'down' | 'neutral' = changePercent > 0.15 ? 'up' : changePercent < -0.15 ? 'down' : 'neutral'

  const absChange = Math.abs(changePercent)
  if (absChange >= 3) {
    score += 35
    reasons.push(`${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}% today - strong move`)
  } else if (absChange >= 2) {
    score += 25
    reasons.push(`${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}% today - watchlist mover`)
  } else if (absChange >= 1.2) {
    score += 15
    reasons.push(`${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}% - momentum building`)
  }

  if (levels.recentHigh != null && price >= levels.recentHigh * 0.997) {
    score += 30
    direction = 'up'
    reasons.push('Testing 20-day high - breakout risk')
  } else if (levels.recentLow != null && price <= levels.recentLow * 1.003) {
    score += 30
    direction = 'down'
    reasons.push('Testing 20-day low - breakdown risk')
  }

  if (
    levels.atr14 != null &&
    levels.atr14 > 0 &&
    levels.todayHigh != null &&
    levels.todayLow != null
  ) {
    const rangeRatio = (levels.todayHigh - levels.todayLow) / levels.atr14
    if (rangeRatio >= 1.4) {
      score += 20
      reasons.push('Volatility expanding - range > 1.4× ATR')
    } else if (rangeRatio >= 1.0) {
      score += 10
      reasons.push('Active session range - movement likely')
    }
  }

  if (
    prevPrice != null &&
    Number.isFinite(prevPrice) &&
    prevPrice > 0 &&
    minutesSincePrev != null &&
    minutesSincePrev > 0 &&
    minutesSincePrev <= 30
  ) {
    const vel = ((price - prevPrice) / prevPrice) * 100
    const absVel = Math.abs(vel)
    if (absVel >= 0.8) {
      score += 25
      direction = vel > 0 ? 'up' : 'down'
      reasons.push(
        `${vel >= 0 ? '+' : ''}${vel.toFixed(2)}% in ~${Math.round(minutesSincePrev)}m - fast move`
      )
    } else if (absVel >= 0.4) {
      score += 12
      direction = vel > 0 ? 'up' : 'down'
      reasons.push(`Price accelerating (${vel >= 0 ? '+' : ''}${vel.toFixed(2)}% recently)`)
    }
  }

  if (levels.recentHigh != null && pctDist(price, levels.recentHigh) <= 0.5 && price < levels.recentHigh) {
    score += 8
    reasons.push('Approaching resistance')
  }
  if (levels.recentLow != null && pctDist(price, levels.recentLow) <= 0.5 && price > levels.recentLow) {
    score += 8
    reasons.push('Approaching support')
  }

  score = Math.min(100, score)

  let movementState: MovementState = 'calm'
  if (score >= 70) movementState = 'breakout'
  else if (score >= 45) movementState = 'moving'
  else if (score >= 25) movementState = 'building'

  return { signalScore: score, movementState, direction, reasons }
}

export function buildPairScanState(
  symbol: string,
  price: number | null,
  changePercent: number | null,
  movement: MovementResult
): PairScanState {
  return {
    symbol,
    lastScanAt: new Date().toISOString(),
    lastPrice: price,
    changePercent,
    signalScore: movement.signalScore,
    movementState: movement.movementState,
    direction: movement.direction,
    reasons: movement.reasons,
  }
}

export function shouldRunAiScan(
  state: PairScanState | undefined,
  signalScore: number,
  threshold: number,
  cooldownMs: number
): boolean {
  if (signalScore < threshold) return false
  if (!state?.lastAiScanAt) return true
  const last = Date.parse(state.lastAiScanAt)
  if (!Number.isFinite(last)) return true
  return Date.now() - last >= cooldownMs
}

export function alertDedupeKey(symbol: string, kind: string): string {
  return `${symbol.toUpperCase()}:${kind}`
}
