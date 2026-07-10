/**
 * Free L2 order-book depth for crypto + volume-profile from candles.
 *
 * All endpoints used here are PUBLIC and KEY-FREE:
 *   - Binance:  https://api.binance.com/api/v3/depth
 *   - Coinbase: https://api.exchange.coinbase.com/products/{p}/book
 *   - Bybit:    https://api.bybit.com/v5/market/orderbook
 *
 * For non-crypto assets (FX, equities), free Level-2 is essentially unavailable
 * on retail APIs. The `get_volume_profile` tool works for ANY asset whose
 * candles we can fetch, and gives us a usable "deep-market" proxy via the
 * Point of Control + Value Area.
 */

import type { ChartCandle } from '@/lib/chart-drawings'

const TIMEOUT_MS = 4500

function timeoutFetch(url: string, ms = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), ms)
  return fetch(url, {
    signal: controller.signal,
    headers: { Accept: 'application/json' },
  }).finally(() => clearTimeout(t))
}

// ──────────────────────────────────────────────────────────────────────────
// Symbol routing - pick the best free exchange for a given input symbol.
// ──────────────────────────────────────────────────────────────────────────

export type DepthExchange = 'binance' | 'coinbase' | 'bybit'

function stripExchangePrefix(symbol: string): {
  prefix?: DepthExchange
  bare: string
} {
  const upper = symbol.toUpperCase()
  if (upper.startsWith('BINANCE:')) {
    return { prefix: 'binance', bare: upper.slice('BINANCE:'.length) }
  }
  if (upper.startsWith('COINBASE:')) {
    return { prefix: 'coinbase', bare: upper.slice('COINBASE:'.length) }
  }
  if (upper.startsWith('BYBIT:')) {
    return { prefix: 'bybit', bare: upper.slice('BYBIT:'.length) }
  }
  return { bare: upper }
}

/** Convert BTC / BTCUSD / BTC/USDT → BTCUSDT (Binance format). */
function toBinanceSymbol(bare: string): string {
  const s = bare.replace(/[\/-]/g, '')
  if (/USDT$|USDC$|BUSD$|FDUSD$/.test(s)) return s
  if (/USD$/.test(s)) return s.replace(/USD$/, 'USDT')
  // Bare ticker like BTC → BTCUSDT
  return `${s}USDT`
}

/** Convert BTC / BTCUSD → BTC-USD (Coinbase format). */
function toCoinbaseSymbol(bare: string): string {
  const s = bare.replace(/[\/]/g, '-')
  if (/-USD(?:C|T)?$/.test(s)) return s
  if (/^[A-Z]{2,6}$/.test(s)) return `${s}-USD`
  if (/^[A-Z]{2,6}USD$/.test(s)) return `${s.replace(/USD$/, '')}-USD`
  return s.includes('-') ? s : `${s}-USD`
}

/** Convert to Bybit linear-perp format (BTCUSDT). Same as Binance. */
function toBybitSymbol(bare: string): string {
  return toBinanceSymbol(bare)
}

// ──────────────────────────────────────────────────────────────────────────
// Per-exchange depth fetchers
// ──────────────────────────────────────────────────────────────────────────

type RawLevel = { price: number; quantity: number }

type RawDepth = { bids: RawLevel[]; asks: RawLevel[] }

async function fetchBinanceDepth(symbol: string, limit: number): Promise<RawDepth | null> {
  try {
    const url = `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`
    const res = await timeoutFetch(url)
    if (!res.ok) return null
    const json = (await res.json()) as {
      bids?: [string, string][]
      asks?: [string, string][]
    }
    if (!json.bids || !json.asks) return null
    return {
      bids: json.bids.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
      asks: json.asks.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
    }
  } catch {
    return null
  }
}

async function fetchCoinbaseDepth(symbol: string): Promise<RawDepth | null> {
  try {
    // level 2 = top 50 bid/ask snapshots
    const url = `https://api.exchange.coinbase.com/products/${symbol}/book?level=2`
    const res = await timeoutFetch(url)
    if (!res.ok) return null
    const json = (await res.json()) as {
      bids?: [string, string, number][]
      asks?: [string, string, number][]
    }
    if (!json.bids || !json.asks) return null
    return {
      bids: json.bids.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
      asks: json.asks.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
    }
  } catch {
    return null
  }
}

async function fetchBybitDepth(symbol: string, limit: number): Promise<RawDepth | null> {
  try {
    const url = `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${symbol}&limit=${limit}`
    const res = await timeoutFetch(url)
    if (!res.ok) return null
    const json = (await res.json()) as {
      result?: { b?: [string, string][]; a?: [string, string][] }
    }
    const r = json.result
    if (!r?.b || !r?.a) return null
    return {
      bids: r.b.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
      asks: r.a.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
    }
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Public API - fetchOrderBookDepth(symbol)
// ──────────────────────────────────────────────────────────────────────────

export type OrderBookLevel = { price: number; quantity: number; notional: number }

export type OrderBookSnapshot = {
  exchange: DepthExchange
  symbol: string
  /** Best bid / best ask (top of book) */
  bestBid: number
  bestAsk: number
  /** Mid price (average of best bid/ask) */
  mid: number
  /** Absolute spread (ask - bid) */
  spread: number
  /** Spread in basis points relative to mid (1bp = 0.01%) */
  spreadBps: number
  /** Cumulative base-asset volume on each side over the returned levels */
  totalBidQty: number
  totalAskQty: number
  /** Notional value of cumulative depth (price * qty summed) */
  totalBidNotional: number
  totalAskNotional: number
  /**
   * Order-flow imbalance in [-1, +1].
   *  +1 = 100% bid heavy (buying pressure)
   *  -1 = 100% ask heavy (selling pressure)
   *   0 = balanced
   */
  imbalance: number
  /** The largest BID wall (single price level) within the returned book. */
  largestBidWall?: OrderBookLevel
  /** The largest ASK wall. */
  largestAskWall?: OrderBookLevel
  /** Top N bid levels (sorted by price desc) */
  bidLevels: OrderBookLevel[]
  /** Top N ask levels (sorted by price asc) */
  askLevels: OrderBookLevel[]
  fetchedAtIso: string
}

function enrich(levels: RawLevel[]): OrderBookLevel[] {
  return levels
    .filter((l) => l.price > 0 && l.quantity > 0)
    .map((l) => ({
      price: l.price,
      quantity: l.quantity,
      notional: l.price * l.quantity,
    }))
}

function findLargest(levels: OrderBookLevel[]): OrderBookLevel | undefined {
  if (!levels.length) return undefined
  let best = levels[0]
  for (const l of levels) {
    if (l.quantity > best.quantity) best = l
  }
  return best
}

function summarize(
  exchange: DepthExchange,
  symbol: string,
  raw: RawDepth
): OrderBookSnapshot | null {
  if (!raw.bids.length || !raw.asks.length) return null
  const bids = enrich(raw.bids).sort((a, b) => b.price - a.price).slice(0, 20)
  const asks = enrich(raw.asks).sort((a, b) => a.price - b.price).slice(0, 20)
  if (!bids.length || !asks.length) return null

  const bestBid = bids[0].price
  const bestAsk = asks[0].price
  if (bestBid >= bestAsk) return null
  const mid = (bestBid + bestAsk) / 2
  const spread = bestAsk - bestBid
  const spreadBps = mid > 0 ? (spread / mid) * 10_000 : 0

  const totalBidQty = bids.reduce((s, l) => s + l.quantity, 0)
  const totalAskQty = asks.reduce((s, l) => s + l.quantity, 0)
  const totalBidNotional = bids.reduce((s, l) => s + l.notional, 0)
  const totalAskNotional = asks.reduce((s, l) => s + l.notional, 0)

  const totalNotional = totalBidNotional + totalAskNotional
  const imbalance =
    totalNotional > 0
      ? (totalBidNotional - totalAskNotional) / totalNotional
      : 0

  return {
    exchange,
    symbol,
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadBps,
    totalBidQty,
    totalAskQty,
    totalBidNotional,
    totalAskNotional,
    imbalance,
    largestBidWall: findLargest(bids),
    largestAskWall: findLargest(asks),
    bidLevels: bids,
    askLevels: asks,
    fetchedAtIso: new Date().toISOString(),
  }
}

/**
 * Fetch L2 depth for a crypto pair. Tries exchanges in order until one
 * returns a valid book. Returns null for non-crypto assets.
 */
export async function fetchOrderBookDepth(
  inputSymbol: string,
  opts?: { exchange?: DepthExchange; limit?: number }
): Promise<OrderBookSnapshot | null> {
  const limit = opts?.limit ?? 20
  const { prefix, bare } = stripExchangePrefix(inputSymbol)
  const preferred = opts?.exchange ?? prefix

  // Heuristic: don't even try for obvious non-crypto symbols.
  const isLikelyCrypto =
    /^(BTC|ETH|SOL|ADA|XRP|DOGE|BNB|AVAX|LINK|DOT|MATIC|LTC|TRX|ARB|OP|SUI|TON|ATOM|NEAR|APT|INJ|XLM|UNI|ALGO|FIL|ICP|TIA|SEI|HBAR|PEPE|SHIB|FET|RNDR|TAO|JTO)/.test(
      bare
    ) ||
    bare.endsWith('USDT') ||
    bare.endsWith('USDC') ||
    bare.endsWith('USD') ||
    Boolean(prefix)
  if (!isLikelyCrypto) return null

  const tryOrder: DepthExchange[] =
    preferred === 'coinbase'
      ? ['coinbase', 'binance', 'bybit']
      : preferred === 'bybit'
        ? ['bybit', 'binance', 'coinbase']
        : ['binance', 'coinbase', 'bybit']

  for (const ex of tryOrder) {
    let raw: RawDepth | null = null
    let sym = ''
    if (ex === 'binance') {
      sym = toBinanceSymbol(bare)
      raw = await fetchBinanceDepth(sym, limit)
    } else if (ex === 'coinbase') {
      sym = toCoinbaseSymbol(bare)
      raw = await fetchCoinbaseDepth(sym)
    } else if (ex === 'bybit') {
      sym = toBybitSymbol(bare)
      raw = await fetchBybitDepth(sym, limit)
    }
    if (raw) {
      const snap = summarize(ex, sym, raw)
      if (snap) return snap
    }
  }
  return null
}

// ──────────────────────────────────────────────────────────────────────────
// Volume profile - bins candle volume by price; works for ANY asset
// ──────────────────────────────────────────────────────────────────────────

export type VolumeProfile = {
  bars: number
  binCount: number
  /** Price with the highest traded volume (Point of Control). */
  pocPrice: number
  /** High end of the 70%-volume value area. */
  valueAreaHigh: number
  /** Low end of the 70%-volume value area. */
  valueAreaLow: number
  /** Per-bin volume (sorted by price ascending). */
  bins: { priceLow: number; priceHigh: number; volume: number; isPoc: boolean }[]
}

/**
 * Compute a volume profile (price → traded volume histogram) from OHLC bars.
 *
 * For each bar we distribute its volume uniformly across its (low, high)
 * range - a common Volume-Profile-by-Price approximation when we don't have
 * tick data.
 */
export function computeVolumeProfile(
  bars: Array<ChartCandle & { v?: number }>,
  options?: { binCount?: number; valueAreaPct?: number }
): VolumeProfile | null {
  const binCount = options?.binCount ?? 24
  const vaPct = Math.min(0.95, Math.max(0.5, options?.valueAreaPct ?? 0.7))

  const valid = bars.filter(
    (b) => Number.isFinite(b.h) && Number.isFinite(b.l) && b.h >= b.l
  )
  if (valid.length < 5) return null

  let minPx = Infinity
  let maxPx = -Infinity
  for (const b of valid) {
    if (b.l < minPx) minPx = b.l
    if (b.h > maxPx) maxPx = b.h
  }
  if (!Number.isFinite(minPx) || !Number.isFinite(maxPx) || maxPx <= minPx) {
    return null
  }

  const range = maxPx - minPx
  const binSize = range / binCount
  const volumeBins = new Array<number>(binCount).fill(0)

  for (const b of valid) {
    // If the bar has a `v` field use it, else use a 1-unit proxy so the
    // profile still reflects price coverage even without true volume.
    const v = typeof b.v === 'number' && b.v > 0 ? b.v : 1
    const lowIdx = Math.max(
      0,
      Math.min(binCount - 1, Math.floor((b.l - minPx) / binSize))
    )
    const highIdx = Math.max(
      0,
      Math.min(binCount - 1, Math.floor((b.h - minPx) / binSize))
    )
    const span = highIdx - lowIdx + 1
    const portion = v / span
    for (let i = lowIdx; i <= highIdx; i++) {
      volumeBins[i] += portion
    }
  }

  // Point of Control
  let pocIdx = 0
  let pocVol = volumeBins[0]
  for (let i = 1; i < binCount; i++) {
    if (volumeBins[i] > pocVol) {
      pocVol = volumeBins[i]
      pocIdx = i
    }
  }

  // Value Area - expand from POC until we capture vaPct of total volume.
  const total = volumeBins.reduce((s, v) => s + v, 0)
  const targetVA = total * vaPct
  let lo = pocIdx
  let hi = pocIdx
  let accVol = volumeBins[pocIdx]
  while (accVol < targetVA && (lo > 0 || hi < binCount - 1)) {
    const up = hi + 1 < binCount ? volumeBins[hi + 1] : -1
    const down = lo - 1 >= 0 ? volumeBins[lo - 1] : -1
    if (up >= down) {
      hi += 1
      accVol += volumeBins[hi]
    } else {
      lo -= 1
      accVol += volumeBins[lo]
    }
  }

  const bins = volumeBins.map((vol, i) => ({
    priceLow: minPx + binSize * i,
    priceHigh: minPx + binSize * (i + 1),
    volume: vol,
    isPoc: i === pocIdx,
  }))

  return {
    bars: valid.length,
    binCount,
    pocPrice: minPx + binSize * (pocIdx + 0.5),
    valueAreaHigh: minPx + binSize * (hi + 1),
    valueAreaLow: minPx + binSize * lo,
    bins,
  }
}
