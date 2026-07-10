/**
 * Unit checks for trade-watch movement detection.
 * Run: npx tsx scripts/test-trade-watch-engine.ts
 */

import {
  detectMovementSignal,
  shouldRunAiScan,
} from '../lib/trade-watch-engine'

let passed = 0
let failed = 0

function assert(name: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`)
  }
}

console.log('detectMovementSignal')

const calm = detectMovementSignal({
  price: 100,
  changePercent: 0.3,
  levels: {
    todayOpen: 99,
    todayHigh: 101,
    todayLow: 98,
    recentHigh: 110,
    recentLow: 90,
    atr14: 2,
  },
})
assert('calm market scores low', calm.signalScore < 25)
assert('calm state', calm.movementState === 'calm')

const mover = detectMovementSignal({
  price: 103,
  changePercent: 2.5,
  levels: {
    todayOpen: 100,
    todayHigh: 104,
    todayLow: 99,
    recentHigh: 110,
    recentLow: 90,
    atr14: 2,
  },
})
assert('2.5% move scores >= 25', mover.signalScore >= 25)
assert('moving or building', ['building', 'moving', 'breakout'].includes(mover.movementState))

const breakout = detectMovementSignal({
  price: 109.8,
  changePercent: 1.5,
  levels: {
    todayOpen: 105,
    todayHigh: 110,
    todayLow: 104,
    recentHigh: 110,
    recentLow: 90,
    atr14: 2,
  },
})
assert('near 20D high detects breakout risk', breakout.signalScore >= 30)
assert('breakout direction up', breakout.direction === 'up')

const velocity = detectMovementSignal({
  price: 101.2,
  changePercent: 0.5,
  levels: {
    todayOpen: 100,
    todayHigh: 101.5,
    todayLow: 99.5,
    recentHigh: 110,
    recentLow: 90,
    atr14: 2,
  },
  prevPrice: 100,
  minutesSincePrev: 5,
})
assert('fast velocity adds score', velocity.signalScore >= 12)

console.log('\nshouldRunAiScan')
assert('runs when no prior scan', shouldRunAiScan(undefined, 60, 55, 3600_000))
assert('skips below threshold', !shouldRunAiScan(undefined, 40, 55, 3600_000))
assert(
  'respects cooldown',
  !shouldRunAiScan(
    {
      symbol: 'BTCUSD',
      lastScanAt: new Date().toISOString(),
      lastPrice: 100,
      changePercent: 0,
      signalScore: 80,
      movementState: 'moving',
      direction: 'up',
      reasons: [],
      lastAiScanAt: new Date().toISOString(),
    },
    80,
    55,
    3600_000
  )
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
