/** Canonical Finnhub symbol helpers and curated market lists. */

export type SymbolType = "stock" | "etf" | "forex" | "crypto" | "index" | "other"

export type SymbolMeta = {
  symbol: string
  displaySymbol: string
  description: string
  type: SymbolType
  exchange?: string
}

/** Finnhub-compatible symbol (stocks, OANDA:EUR_USD, BINANCE:BTCUSDT, etc.) */
export const FINNHUB_SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-_:]{0,31}$/

export function normalizeSymbol(input: string): string {
  return input.trim().toUpperCase()
}

export function isValidSymbol(input: string): boolean {
  return FINNHUB_SYMBOL_RE.test(normalizeSymbol(input))
}

export function inferSymbolType(symbol: string, finnhubType?: string): SymbolType {
  const upper = normalizeSymbol(symbol)
  const typeLower = (finnhubType || "").toLowerCase()

  if (upper.startsWith("BINANCE:") || upper.startsWith("COINBASE:")) return "crypto"
  if (upper.startsWith("OANDA:") || typeLower.includes("forex")) return "forex"
  if (typeLower.includes("etf") || typeLower.includes("etp")) return "etf"
  if (typeLower.includes("index")) return "index"
  if (typeLower.includes("crypto")) return "crypto"
  if (typeLower.includes("stock") || typeLower.includes("equity")) return "stock"
  if (/^[A-Z]{1,5}$/.test(upper.split(":").pop() || upper)) return "stock"
  return "other"
}

/** Map bare tickers to Finnhub quote/candle symbols when needed. */
export function resolveQuoteSymbol(symbol: string): string {
  const upper = normalizeSymbol(symbol)
  if (upper.includes(":")) return upper

  const forexPairs: Record<string, string> = {
    EURUSD: "OANDA:EUR_USD",
    GBPUSD: "OANDA:GBP_USD",
    USDJPY: "OANDA:USD_JPY",
    AUDUSD: "OANDA:AUD_USD",
    USDCAD: "OANDA:USD_CAD",
    USDCHF: "OANDA:USD_CHF",
    NZDUSD: "OANDA:NZD_USD",
    XAUUSD: "OANDA:XAU_USD",
    XAGUSD: "OANDA:XAG_USD",
  }
  if (forexPairs[upper]) return forexPairs[upper]

  const cryptoPairs: Record<string, string> = {
    BTCUSD: "BINANCE:BTCUSDT",
    ETHUSD: "BINANCE:ETHUSDT",
    BTCUSDT: "BINANCE:BTCUSDT",
    ETHUSDT: "BINANCE:ETHUSDT",
    SOLUSD: "BINANCE:SOLUSDT",
    XRPUSD: "BINANCE:XRPUSDT",
  }
  if (cryptoPairs[upper]) return cryptoPairs[upper]

  return upper
}

export type CandleEndpoint = "stock" | "forex" | "crypto"

export function getCandleEndpoint(symbol: string): CandleEndpoint {
  const resolved = resolveQuoteSymbol(symbol)
  if (resolved.startsWith("OANDA:")) return "forex"
  if (resolved.startsWith("BINANCE:") || resolved.startsWith("COINBASE:")) return "crypto"
  return "stock"
}

export function displaySymbolLabel(symbol: string): string {
  const resolved = resolveQuoteSymbol(symbol)
  if (resolved.startsWith("OANDA:")) return resolved.replace("OANDA:", "").replace("_", "/")
  if (resolved.includes(":")) return resolved.split(":")[1] ?? resolved
  return resolved
}

/** TradingView widget symbol format - explicit overrides for reliable charts */
const TV_SYMBOL_OVERRIDES: Record<string, string> = {
  "OANDA:XAU_USD": "TVC:GOLD",
  XAUUSD: "TVC:GOLD",
  "OANDA:XAG_USD": "TVC:SILVER",
  XAGUSD: "TVC:SILVER",
  "OANDA:EUR_USD": "FX:EURUSD",
  EURUSD: "FX:EURUSD",
  "OANDA:GBP_USD": "FX:GBPUSD",
  GBPUSD: "FX:GBPUSD",
  "OANDA:USD_JPY": "FX:USDJPY",
  USDJPY: "FX:USDJPY",
}

export function toTradingViewSymbol(symbol: string): string {
  const upper = normalizeSymbol(symbol)
  const resolved = resolveQuoteSymbol(symbol)

  if (TV_SYMBOL_OVERRIDES[upper]) return TV_SYMBOL_OVERRIDES[upper]
  if (TV_SYMBOL_OVERRIDES[resolved]) return TV_SYMBOL_OVERRIDES[resolved]

  if (upper.startsWith("OANDA:")) {
    const pair = upper.replace("OANDA:", "").replace(/_/g, "")
    return `OANDA:${pair}`
  }

  if (upper.startsWith("BINANCE:") || upper.startsWith("COINBASE:")) {
    return upper
  }

  if (upper.includes(":")) return upper

  return upper
}

export function tradingViewInterval(resolution: string): string {
  const map: Record<string, string> = {
    "1":   "1",
    "3":   "3",
    "5":   "5",
    "15":  "15",
    "30":  "30",
    "60":  "60",
    "240": "240",
    D:     "D",
    W:     "W",
  }
  return map[resolution] ?? "D"
}

/** Known search aliases when Finnhub returns nothing */
export const SEARCH_ALIASES: Record<string, SymbolMeta[]> = {
  xauusd: [
    {
      symbol: "OANDA:XAU_USD",
      displaySymbol: "XAU/USD",
      description: "Gold / US Dollar",
      type: "forex",
      exchange: "OANDA",
    },
  ],
  gold: [
    {
      symbol: "OANDA:XAU_USD",
      displaySymbol: "XAU/USD",
      description: "Gold / US Dollar",
      type: "forex",
      exchange: "OANDA",
    },
  ],
  btc: [
    {
      symbol: "BINANCE:BTCUSDT",
      displaySymbol: "BTCUSDT",
      description: "Bitcoin / Tether",
      type: "crypto",
      exchange: "BINANCE",
    },
  ],
  bitcoin: [
    {
      symbol: "BINANCE:BTCUSDT",
      displaySymbol: "BTCUSDT",
      description: "Bitcoin / Tether",
      type: "crypto",
      exchange: "BINANCE",
    },
  ],
  eth: [
    {
      symbol: "BINANCE:ETHUSDT",
      displaySymbol: "ETHUSDT",
      description: "Ethereum / Tether",
      type: "crypto",
      exchange: "BINANCE",
    },
  ],
  ethereum: [
    {
      symbol: "BINANCE:ETHUSDT",
      displaySymbol: "ETHUSDT",
      description: "Ethereum / Tether",
      type: "crypto",
      exchange: "BINANCE",
    },
  ],
}

export function lookupSearchAliases(query: string): SymbolMeta[] {
  const key = query.trim().toLowerCase()
  return SEARCH_ALIASES[key] ?? []
}

export function fmpExchangeToType(exchange: string): SymbolType {
  const ex = exchange.toUpperCase()
  if (ex === "FOREX" || ex === "CCY") return "forex"
  if (ex === "CRYPTO" || ex === "CCC") return "crypto"
  if (ex === "ETF") return "etf"
  if (ex.includes("INDEX")) return "index"
  return "stock"
}

/** Map FMP search hit to app symbol */
export function fmpHitToSymbolMeta(hit: {
  symbol: string
  name: string
  exchange: string
}): SymbolMeta {
  const ex = hit.exchange.toUpperCase()
  let symbol = hit.symbol.toUpperCase()

  if (ex === "FOREX" || ex === "CCY") {
    if (symbol.length === 6) {
      symbol = `OANDA:${symbol.slice(0, 3)}_${symbol.slice(3)}`
    }
  } else if (ex === "CRYPTO" || ex === "CCC") {
    if (!symbol.includes(":")) {
      symbol = `BINANCE:${symbol}`
    }
  }

  return {
    symbol,
    displaySymbol: hit.symbol,
    description: hit.name,
    type: fmpExchangeToType(hit.exchange),
    exchange: hit.exchange,
  }
}

export function mergeSearchResults(...lists: SymbolMeta[][]): SymbolMeta[] {
  const seen = new Set<string>()
  const out: SymbolMeta[] = []
  for (const list of lists) {
    for (const item of list) {
      const key = item.symbol.toUpperCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

/** Rank and filter search hits for cleaner, relevant results */
export function rankSearchResults(query: string, results: SymbolMeta[]): SymbolMeta[] {
  const q = query.trim().toLowerCase()
  if (!q) return results

  const filtered = results.filter((r) => {
    const sym = r.displaySymbol.toLowerCase()
    const desc = r.description.toLowerCase()
    const raw = r.symbol.toLowerCase()
    if (q.includes("xau") || q === "gold") {
      if (r.type === "crypto" && !desc.includes("gold")) return false
    }
    if (!q) return true
  const compact = q.replace(/[^a-z0-9]/g, "")
    return (
      sym.includes(q) ||
      desc.includes(q) ||
      raw.includes(q) ||
      sym.replace(/[^a-z0-9]/g, "").includes(compact) ||
      raw.replace(/[^a-z0-9]/g, "").includes(compact)
    )
  })

  const score = (r: SymbolMeta) => {
    const sym = r.displaySymbol.toLowerCase()
    const desc = r.description.toLowerCase()
    let s = 0
    if (sym === q) s += 100
    if (sym.replace("/", "") === q.replace("/", "")) s += 90
    if (sym.startsWith(q)) s += 50
    if (desc.includes(q)) s += 20
    if (r.type === "forex" && (q.includes("xau") || q.includes("eur") || q.includes("gbp"))) s += 10
    if (r.type === "stock" && q.length <= 5 && sym === q) s += 30
    return s
  }

  return [...filtered].sort((a, b) => score(b) - score(a))
}

export function sortWatchlistWithFavorites(
  watchlist: string[],
  favorites: string[]
): string[] {
  const favSet = new Set(favorites.map(normalizeSymbol))
  const favFirst = favorites
    .map(normalizeSymbol)
    .filter((s) => watchlist.map(normalizeSymbol).includes(s))
  const rest = watchlist
    .map(normalizeSymbol)
    .filter((s) => !favSet.has(s))
  return [...new Set([...favFirst, ...rest])]
}

export const POPULAR_MARKETS: SymbolMeta[] = [
  { symbol: "AAPL", displaySymbol: "AAPL", description: "Apple Inc", type: "stock", exchange: "NASDAQ" },
  { symbol: "MSFT", displaySymbol: "MSFT", description: "Microsoft Corporation", type: "stock", exchange: "NASDAQ" },
  { symbol: "NVDA", displaySymbol: "NVDA", description: "NVIDIA Corporation", type: "stock", exchange: "NASDAQ" },
  { symbol: "TSLA", displaySymbol: "TSLA", description: "Tesla Inc", type: "stock", exchange: "NASDAQ" },
  { symbol: "GOOGL", displaySymbol: "GOOGL", description: "Alphabet Inc", type: "stock", exchange: "NASDAQ" },
  { symbol: "AMZN", displaySymbol: "AMZN", description: "Amazon.com Inc", type: "stock", exchange: "NASDAQ" },
  { symbol: "META", displaySymbol: "META", description: "Meta Platforms Inc", type: "stock", exchange: "NASDAQ" },
  { symbol: "SPY", displaySymbol: "SPY", description: "SPDR S&P 500 ETF", type: "etf", exchange: "NYSE" },
  { symbol: "QQQ", displaySymbol: "QQQ", description: "Invesco QQQ Trust", type: "etf", exchange: "NASDAQ" },
  { symbol: "OANDA:EUR_USD", displaySymbol: "EUR/USD", description: "Euro / US Dollar", type: "forex", exchange: "OANDA" },
  { symbol: "OANDA:GBP_USD", displaySymbol: "GBP/USD", description: "British Pound / US Dollar", type: "forex", exchange: "OANDA" },
  { symbol: "OANDA:USD_JPY", displaySymbol: "USD/JPY", description: "US Dollar / Japanese Yen", type: "forex", exchange: "OANDA" },
  { symbol: "OANDA:XAU_USD", displaySymbol: "XAU/USD", description: "Gold / US Dollar", type: "forex", exchange: "OANDA" },
  { symbol: "BINANCE:BTCUSDT", displaySymbol: "BTCUSDT", description: "Bitcoin / Tether", type: "crypto", exchange: "BINANCE" },
  { symbol: "BINANCE:ETHUSDT", displaySymbol: "ETHUSDT", description: "Ethereum / Tether", type: "crypto", exchange: "BINANCE" },
  { symbol: "BINANCE:SOLUSDT", displaySymbol: "SOLUSDT", description: "Solana / Tether", type: "crypto", exchange: "BINANCE" },
]

export const SYMBOL_TYPE_FILTERS: { id: "all" | SymbolType; label: string }[] = [
  { id: "all", label: "All" },
  { id: "stock", label: "Stocks" },
  { id: "etf", label: "ETFs" },
  { id: "forex", label: "Forex" },
  { id: "crypto", label: "Crypto" },
  { id: "index", label: "Indices" },
]

export const CHART_RESOLUTIONS = [
  { id: "1",   label: "1m",  seconds: 60 * 60 * 6 },
  { id: "3",   label: "3m",  seconds: 60 * 60 * 12 },
  { id: "5",   label: "5m",  seconds: 60 * 60 * 24 },
  { id: "15",  label: "15m", seconds: 60 * 60 * 24 * 3 },
  { id: "30",  label: "30m", seconds: 60 * 60 * 24 * 5 },
  { id: "60",  label: "1H",  seconds: 60 * 60 * 24 * 14 },
  { id: "240", label: "4H",  seconds: 60 * 60 * 24 * 60 },
  { id: "D",   label: "1D",  seconds: 60 * 60 * 24 * 365 },
  { id: "W",   label: "1W",  seconds: 60 * 60 * 24 * 365 * 3 },
] as const
