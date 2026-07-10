/**
 * Free, no-key crypto data sources for the agent.
 *
 * Sources used:
 *   - CoinGecko public API   - quotes, market cap, dominance, top movers, trending
 *   - Alternative.me         - crypto fear & greed index (no key)
 *
 * No API key required. Best-effort: returns null/[] on failure so the
 * agent can keep reasoning with whatever did come back.
 */

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3'
const FNG_BASE = 'https://api.alternative.me/fng/'

/** Symbol → CoinGecko id, expanded conservatively. */
const SYMBOL_TO_CG_ID: Record<string, string> = {
  BTC: 'bitcoin',
  BTCUSD: 'bitcoin',
  BTCUSDT: 'bitcoin',
  XBT: 'bitcoin',
  ETH: 'ethereum',
  ETHUSD: 'ethereum',
  ETHUSDT: 'ethereum',
  SOL: 'solana',
  SOLUSD: 'solana',
  SOLUSDT: 'solana',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  BNB: 'binancecoin',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  DOT: 'polkadot',
  MATIC: 'matic-network',
  LTC: 'litecoin',
  TRX: 'tron',
  ARB: 'arbitrum',
  OP: 'optimism',
  SUI: 'sui',
  TON: 'the-open-network',
  ATOM: 'cosmos',
  NEAR: 'near',
  APT: 'aptos',
  INJ: 'injective-protocol',
}

function coingeckoHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const key = process.env.COINGECKO_API_KEY?.trim()
  if (key) headers['x-cg-demo-api-key'] = key
  return headers
}

async function timeoutFetch(url: string, ms = 6500, attempt = 0): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: coingeckoHeaders(),
    })
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
      return timeoutFetch(url, ms, attempt + 1)
    }
    return res
  } finally {
    clearTimeout(t)
  }
}

function stripExchangePrefix(symbol: string): string {
  const upper = symbol.toUpperCase()
  if (upper.startsWith('BINANCE:')) return upper.slice('BINANCE:'.length)
  if (upper.startsWith('COINBASE:')) return upper.slice('COINBASE:'.length)
  return upper
}

export function resolveCoinGeckoId(symbol: string): string | null {
  const upper = stripExchangePrefix(symbol)
  if (SYMBOL_TO_CG_ID[upper]) return SYMBOL_TO_CG_ID[upper]
  // Strip trailing USD/USDT (BTCUSDT → BTC)
  const trimmed = upper.replace(/(USDT?|USDC|BUSD|EUR|JPY)$/i, '')
  if (SYMBOL_TO_CG_ID[trimmed]) return SYMBOL_TO_CG_ID[trimmed]
  return null
}

// ──────────────────────────────────────────────────────────────────────────
// Per-coin quote
// ──────────────────────────────────────────────────────────────────────────

export type CoinGeckoQuote = {
  id: string
  symbol: string
  name: string
  price: number
  changePct24h: number
  high24h: number
  low24h: number
  marketCap: number
  volume24h: number
  ath: number
  athChangePct: number
  lastUpdatedIso: string
}

type CgMarketsRow = {
  id: string
  symbol: string
  name: string
  current_price: number
  price_change_percentage_24h: number | null
  high_24h: number | null
  low_24h: number | null
  market_cap: number | null
  total_volume: number | null
  ath: number | null
  ath_change_percentage: number | null
  last_updated: string
}

export async function fetchCoinGeckoQuote(
  symbolOrId: string
): Promise<CoinGeckoQuote | null> {
  const id = resolveCoinGeckoId(symbolOrId) || symbolOrId.toLowerCase()
  try {
    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}&price_change_percentage=24h`
    const res = await timeoutFetch(url)
    if (!res.ok) return null
    const data = (await res.json()) as CgMarketsRow[]
    const row = data[0]
    if (!row) return null
    return {
      id: row.id,
      symbol: row.symbol.toUpperCase(),
      name: row.name,
      price: row.current_price,
      changePct24h: row.price_change_percentage_24h ?? 0,
      high24h: row.high_24h ?? row.current_price,
      low24h: row.low_24h ?? row.current_price,
      marketCap: row.market_cap ?? 0,
      volume24h: row.total_volume ?? 0,
      ath: row.ath ?? row.current_price,
      athChangePct: row.ath_change_percentage ?? 0,
      lastUpdatedIso: row.last_updated,
    }
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Global market metrics (dominance, total cap, etc.)
// ──────────────────────────────────────────────────────────────────────────

export type CryptoGlobal = {
  totalMarketCapUsd: number
  totalVolumeUsd: number
  marketCapChangePct24h: number
  btcDominancePct: number
  ethDominancePct: number
  activeCoins: number
  updatedAtIso: string
}

type CgGlobalResponse = {
  data?: {
    active_cryptocurrencies?: number
    total_market_cap?: { usd?: number }
    total_volume?: { usd?: number }
    market_cap_percentage?: { btc?: number; eth?: number }
    market_cap_change_percentage_24h_usd?: number
    updated_at?: number
  }
}

export async function fetchCryptoGlobal(): Promise<CryptoGlobal | null> {
  try {
    const res = await timeoutFetch(`${COINGECKO_BASE}/global`)
    if (!res.ok) return null
    const json = (await res.json()) as CgGlobalResponse
    const d = json.data
    if (!d) return null
    return {
      totalMarketCapUsd: d.total_market_cap?.usd ?? 0,
      totalVolumeUsd: d.total_volume?.usd ?? 0,
      marketCapChangePct24h: d.market_cap_change_percentage_24h_usd ?? 0,
      btcDominancePct: d.market_cap_percentage?.btc ?? 0,
      ethDominancePct: d.market_cap_percentage?.eth ?? 0,
      activeCoins: d.active_cryptocurrencies ?? 0,
      updatedAtIso: d.updated_at
        ? new Date(d.updated_at * 1000).toISOString()
        : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Top movers (gainers / losers in last 24h)
// ──────────────────────────────────────────────────────────────────────────

export type CryptoMover = {
  symbol: string
  name: string
  price: number
  changePct24h: number
  marketCap: number
}

export async function fetchCryptoTopMovers(
  direction: 'gainers' | 'losers' = 'gainers',
  limit = 10
): Promise<CryptoMover[]> {
  try {
    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h`
    const res = await timeoutFetch(url, 6000)
    if (!res.ok) return []
    const data = (await res.json()) as CgMarketsRow[]
    const filtered = data.filter(
      (r) => typeof r.price_change_percentage_24h === 'number'
    )
    filtered.sort((a, b) => {
      const aChg = a.price_change_percentage_24h ?? 0
      const bChg = b.price_change_percentage_24h ?? 0
      return direction === 'gainers' ? bChg - aChg : aChg - bChg
    })
    return filtered.slice(0, limit).map((r) => ({
      symbol: r.symbol.toUpperCase(),
      name: r.name,
      price: r.current_price,
      changePct24h: r.price_change_percentage_24h ?? 0,
      marketCap: r.market_cap ?? 0,
    }))
  } catch {
    return []
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Crypto Fear & Greed Index (Alternative.me)
// ──────────────────────────────────────────────────────────────────────────

export type FearGreed = {
  value: number
  label: string
  updatedIso: string
}

type FngResponse = {
  data?: Array<{
    value: string
    value_classification: string
    timestamp: string
  }>
}

export async function fetchCryptoFearGreed(): Promise<FearGreed | null> {
  try {
    const res = await timeoutFetch(`${FNG_BASE}?limit=1&format=json`, 4000)
    if (!res.ok) return null
    const json = (await res.json()) as FngResponse
    const row = json.data?.[0]
    if (!row) return null
    const value = Number.parseInt(row.value, 10)
    if (!Number.isFinite(value)) return null
    return {
      value,
      label: row.value_classification,
      updatedIso: new Date(Number(row.timestamp) * 1000).toISOString(),
    }
  } catch {
    return null
  }
}
