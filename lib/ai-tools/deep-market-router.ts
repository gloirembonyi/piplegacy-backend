/**
 * Unified deep-market router - one call, asset-class-aware depth + volume + timing.
 */

import { fetchChartOverlayCandles } from '@/lib/chart-overlay-candles'
import type { ChartCandle } from '@/lib/chart-drawings'
import { fetchQuote } from '@/lib/finnhub'
import {
  formatOpensIn,
  getActiveSessionNames,
  getMarketLiquidity,
  getMarketStatusForSymbol,
  getMinutesUntilNextSession,
} from '@/lib/market-sessions'
import { resolveQuoteSymbol } from '@/lib/symbols'
import {
  computeVolumeProfile,
  fetchOrderBookDepth,
  type OrderBookSnapshot,
  type VolumeProfile,
} from '@/lib/ai-tools/deep-market'
import { fetchMetalsDeepMarket } from '@/lib/ai-tools/metals-deep-market'
import { classifyTradableMarket, type MarketProfile } from '@/lib/ai-tools/market-universe'

export type OrderTimingEstimate = {
  /** Human-readable window when pending limits typically fill faster. */
  bestFillWindow: string
  /** When major session liquidity returns (FX/global). */
  nextLiquidityEvent?: string
  /** ATR-based estimate for price to reach a target level. */
  priceReachEta?: {
    targetPrice: number
    distancePct: number
    estimatedMinutes: number
    method: string
    confidence: 'low' | 'medium' | 'high'
  }
  /** Crypto L2: rough time to absorb visible depth at a level. */
  depthAbsorptionEta?: {
    levelPrice: number
    visibleQty: number
    estimatedMinutes: number
    note: string
  }
  disclaimer: string
}

export type DeepMarketSnapshot = {
  market: MarketProfile
  symbol: string
  resolvedSymbol: string
  deepDataSources: string[]
  quote?: { price: number; changePct?: number }
  sessions: {
    active: string[]
    liquidity: string
    marketOpen: boolean
    marketLabel: string
    nextSession?: { name: string; opensIn: string }
  }
  orderbook?: OrderBookSnapshot
  volumeProfile?: VolumeProfile & { hasRealVolume: boolean; totalVolume: number }
  metalsFlow?: Awaited<ReturnType<typeof fetchMetalsDeepMarket>>
  pendingOrdersProxy?: {
    source: string
    bidNotionalTop10: number
    askNotionalTop10: number
    imbalance: number
    imbalanceLabel: string
    largestBidWall?: { price: number; quantity: number; notional: number }
    largestAskWall?: { price: number; quantity: number; notional: number }
    topBids: { price: number; quantity: number }[]
    topAsks: { price: number; quantity: number }[]
  }
  volumeAnalysis?: {
    poc: number
    valueAreaHigh: number
    valueAreaLow: number
    hasRealVolume: boolean
    note: string
  }
  orderTiming: OrderTimingEstimate
  fetchedAtIso: string
}

function resolutionMinutes(resolution: string): number {
  const map: Record<string, number> = { '1': 1, '5': 5, '15': 15, '60': 60, D: 1440 }
  return map[resolution] ?? 60
}

function computeAtr(bars: ChartCandle[], period = 14): number | null {
  if (bars.length < period + 1) return null
  const slice = bars.slice(-period - 1)
  let sum = 0
  for (let i = 1; i < slice.length; i++) {
    const cur = slice[i]
    const prev = slice[i - 1]
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c))
    sum += tr
  }
  return sum / period
}

function avgBarVolume(bars: ChartCandle[]): number {
  const vols = bars
    .map((b) => (typeof b.v === 'number' && b.v > 0 ? b.v : 0))
    .filter((v) => v > 0)
  if (!vols.length) return 0
  return vols.reduce((a, b) => a + b, 0) / vols.length
}

function depthAtPrice(book: OrderBookSnapshot, targetPrice: number, side: 'bid' | 'ask'): number {
  const levels = side === 'bid' ? book.bidLevels : book.askLevels
  const tol = book.mid * 0.001
  return levels
    .filter((l) => Math.abs(l.price - targetPrice) <= tol)
    .reduce((s, l) => s + l.quantity, 0)
}

function estimateOrderTiming(opts: {
  market: MarketProfile
  quotePrice?: number
  targetPrice?: number
  orderbook?: OrderBookSnapshot | null
  bars?: ChartCandle[]
  resolution: string
  sessions: DeepMarketSnapshot['sessions']
}): OrderTimingEstimate {
  const { market, quotePrice, targetPrice, orderbook, bars, resolution, sessions } = opts

  const disclaimer =
    'Timing is modelled from session liquidity, ATR, and visible L2 depth - not guaranteed exchange fill times. Spoof walls and news can invalidate estimates instantly.'

  let bestFillWindow = sessions.marketOpen
    ? sessions.liquidity === 'High'
      ? 'Now - major session overlap (best fill liquidity)'
      : sessions.liquidity === 'Medium'
        ? 'Current session active - moderate fill odds for limits near mid'
        : 'Thin liquidity - prefer smaller size or wider limit band'
    : `Wait for market reopen (${sessions.marketLabel})`

  let nextLiquidityEvent: string | undefined
  if (sessions.nextSession) {
    nextLiquidityEvent = `${sessions.nextSession.name} opens in ${sessions.nextSession.opensIn}`
    if (!sessions.marketOpen) {
      bestFillWindow = `After ${sessions.nextSession.name} open (~${sessions.nextSession.opensIn}) - pending limits fill faster once flow returns`
    }
  }

  let priceReachEta: OrderTimingEstimate['priceReachEta']
  if (
    quotePrice &&
    targetPrice &&
    quotePrice > 0 &&
    bars &&
    bars.length >= 15 &&
    Math.abs(targetPrice - quotePrice) / quotePrice > 0.0001
  ) {
    const atr = computeAtr(bars)
    if (atr && atr > 0) {
      const distance = Math.abs(targetPrice - quotePrice)
      const barMin = resolutionMinutes(resolution)
      const barsNeeded = distance / atr
      const estimatedMinutes = Math.round(barsNeeded * barMin)
      priceReachEta = {
        targetPrice,
        distancePct: (distance / quotePrice) * 100,
        estimatedMinutes: Math.max(barMin, Math.min(estimatedMinutes, 7 * 24 * 60)),
        method: `ATR(${barMin}m bars) - ${barsNeeded.toFixed(1)} avg-range units to level`,
        confidence: bars.length >= 30 ? 'medium' : 'low',
      }
    }
  }

  let depthAbsorptionEta: OrderTimingEstimate['depthAbsorptionEta']
  if (orderbook && quotePrice && targetPrice && market.marketClass === 'crypto_spot') {
    const side = targetPrice < quotePrice ? 'bid' : 'ask'
    const visibleQty = depthAtPrice(orderbook, targetPrice, side)
    const barVol = bars ? avgBarVolume(bars) : 0
    const volPerMin =
      barVol > 0 ? barVol / resolutionMinutes(resolution) : orderbook.totalBidQty / 20
    if (visibleQty > 0 && volPerMin > 0) {
      const mins = Math.round(visibleQty / (volPerMin * 0.15))
      depthAbsorptionEta = {
        levelPrice: targetPrice,
        visibleQty,
        estimatedMinutes: Math.max(1, Math.min(mins, 24 * 60)),
        note: `Visible ${side} depth at level vs ~15% of recent bar flow`,
      }
    }
  }

  if (market.marketClass === 'precious_metal') {
    bestFillWindow =
      'London/NY overlap (13:00–17:00 UTC) - COMEX futures volume peaks; spot follows futures.'
  }

  return {
    bestFillWindow,
    nextLiquidityEvent,
    priceReachEta,
    depthAbsorptionEta,
    disclaimer,
  }
}

export async function fetchDeepMarketData(
  symbol: string,
  opts?: {
    resolution?: string
    targetPrice?: number
    entryPrice?: number
    limit?: number
  }
): Promise<DeepMarketSnapshot | { error: string; market?: MarketProfile }> {
  const resolved = resolveQuoteSymbol(symbol)
  const market = classifyTradableMarket(symbol)
  const resolution = opts?.resolution ?? '60'
  const targetPrice = opts?.targetPrice ?? opts?.entryPrice

  const [quote, bars, orderbook, metalsFlow] = await Promise.all([
    fetchQuote(resolved).catch(() => null),
    fetchChartOverlayCandles(symbol, resolution),
    market.deepSources.includes('l2_orderbook')
      ? fetchOrderBookDepth(symbol, { limit: opts?.limit ?? 20 })
      : Promise.resolve(null),
    market.marketClass === 'precious_metal'
      ? fetchMetalsDeepMarket(symbol).catch(() => null)
      : Promise.resolve(null),
  ])

  const active = getActiveSessionNames()
  const liquidity = getMarketLiquidity()
  const status = getMarketStatusForSymbol(resolved)
  const next = getMinutesUntilNextSession()

  const sessions: DeepMarketSnapshot['sessions'] = {
    active,
    liquidity,
    marketOpen: status.isOpen,
    marketLabel: status.label,
    nextSession: next ? { name: next.name, opensIn: formatOpensIn(next.minutes) } : undefined,
  }

  const hasRealVolume = bars.some((b) => typeof b.v === 'number' && b.v > 0)
  const profile = bars.length >= 10 ? computeVolumeProfile(bars, { binCount: 24 }) : null

  const volumeProfile = profile
    ? {
        ...profile,
        hasRealVolume,
        totalVolume: bars.reduce((s, b) => s + (b.v ?? 0), 0),
      }
    : undefined

  const volumeAnalysis = profile
    ? {
        poc: profile.pocPrice,
        valueAreaHigh: profile.valueAreaHigh,
        valueAreaLow: profile.valueAreaLow,
        hasRealVolume,
        note: hasRealVolume
          ? 'POC = highest traded volume node (magnetic). VA bounds = fair-value range.'
          : 'Volume is approximated from price coverage - treat POC as structural, not tick-accurate.',
      }
    : undefined

  let pendingOrdersProxy: DeepMarketSnapshot['pendingOrdersProxy']
  if (orderbook) {
    const imb = orderbook.imbalance
    pendingOrdersProxy = {
      source: `${orderbook.exchange} L2 (pending limit orders at price levels)`,
      bidNotionalTop10: orderbook.bidLevels.slice(0, 10).reduce((s, l) => s + l.notional, 0),
      askNotionalTop10: orderbook.askLevels.slice(0, 10).reduce((s, l) => s + l.notional, 0),
      imbalance: imb,
      imbalanceLabel:
        imb > 0.15 ? 'bid-heavy (buyers stacked)' : imb < -0.15 ? 'ask-heavy (sellers stacked)' : 'balanced',
      largestBidWall: orderbook.largestBidWall,
      largestAskWall: orderbook.largestAskWall,
      topBids: orderbook.bidLevels.slice(0, 5).map((l) => ({ price: l.price, quantity: l.quantity })),
      topAsks: orderbook.askLevels.slice(0, 5).map((l) => ({ price: l.price, quantity: l.quantity })),
    }
  } else if (metalsFlow && typeof metalsFlow === 'object' && 'futures' in metalsFlow) {
    const f = metalsFlow.futures as { volume?: number; openInterest?: number; bid?: number; ask?: number }
    pendingOrdersProxy = {
      source: 'COMEX futures flow (proxy for institutional pending interest - not spot L2)',
      bidNotionalTop10: 0,
      askNotionalTop10: 0,
      imbalance: 0,
      imbalanceLabel: `Futures vol ${f.volume ?? 'n/a'} · OI ${f.openInterest ?? 'n/a'}`,
      topBids: f.bid ? [{ price: f.bid, quantity: f.volume ?? 0 }] : [],
      topAsks: f.ask ? [{ price: f.ask, quantity: f.volume ?? 0 }] : [],
    }
  } else if (profile) {
    pendingOrdersProxy = {
      source: 'Volume profile proxy (historical traded volume at price - not live pending queue)',
      bidNotionalTop10: 0,
      askNotionalTop10: 0,
      imbalance: 0,
      imbalanceLabel: `POC @ ${profile.pocPrice.toFixed(2)} - magnetic level from traded volume`,
      topBids: [{ price: profile.valueAreaLow, quantity: profile.bins[0]?.volume ?? 0 }],
      topAsks: [{ price: profile.valueAreaHigh, quantity: profile.bins.at(-1)?.volume ?? 0 }],
    }
  }

  const deepDataSources = [...market.deepSources.map(String)]
  if (orderbook) deepDataSources.unshift('l2_orderbook_live')
  if (metalsFlow) deepDataSources.push('metals_cot_futures')

  const quotePrice = quote?.c
  const orderTiming = estimateOrderTiming({
    market,
    quotePrice,
    targetPrice,
    orderbook,
    bars,
    resolution,
    sessions,
  })

  return {
    market,
    symbol,
    resolvedSymbol: resolved,
    deepDataSources,
    quote: quotePrice
      ? { price: quotePrice, changePct: quote.dp }
      : undefined,
    sessions,
    orderbook: orderbook ?? undefined,
    volumeProfile,
    metalsFlow: metalsFlow ?? undefined,
    pendingOrdersProxy,
    volumeAnalysis,
    orderTiming,
    fetchedAtIso: new Date().toISOString(),
  }
}
