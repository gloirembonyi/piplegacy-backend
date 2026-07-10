/**
 * Tradable market universe - what exists today and which deep-data sources apply.
 *
 * Used by the deep-market router and agent knowledge base. Free retail APIs
 * cannot expose true exchange pending-order queues for FX/equities; we document
 * proxies honestly so the agent does not hallucinate L2 where none exists.
 */

import { getCandleEndpoint, inferSymbolType, normalizeSymbol, resolveQuoteSymbol } from '@/lib/symbols'

export type TradableMarketClass =
  | 'crypto_spot'
  | 'us_equity'
  | 'us_etf'
  | 'forex_spot'
  | 'precious_metal'
  | 'index_proxy'
  | 'commodity_futures'
  | 'other'

export type DeepDataSource =
  | 'l2_orderbook'
  | 'futures_flow'
  | 'cot_positioning'
  | 'volume_profile'
  | 'session_liquidity'
  | 'quote_spread'

export type MarketProfile = {
  marketClass: TradableMarketClass
  label: string
  deepSources: DeepDataSource[]
  /** What we cannot get on free APIs - agent must not claim otherwise. */
  limitations: string[]
  /** Typical venues / how institutions express flow. */
  venues: string[]
}

const METAL_RE = /XAU|XAG|GOLD|SILVER/i
const COMMODITY_RE = /CL=F|NG=F|BZ=F|HG=F|ZC=F|ZW=F|OIL|CRUDE|NATGAS/i
const INDEX_PROXY_RE = /^(SPY|QQQ|DIA|IWM|VIX|SPX|NDX|US500|NAS100)$/i

export function classifyTradableMarket(symbol: string): MarketProfile {
  const upper = normalizeSymbol(symbol)
  const resolved = resolveQuoteSymbol(upper)
  const endpoint = getCandleEndpoint(resolved)
  const symType = inferSymbolType(resolved)

  if (endpoint === 'crypto' || symType === 'crypto') {
    return {
      marketClass: 'crypto_spot',
      label: 'Crypto spot (CEX)',
      deepSources: ['l2_orderbook', 'volume_profile', 'session_liquidity', 'quote_spread'],
      limitations: [
        'Perp funding/OI and on-chain flow require paid feeds - not in free tier.',
        'L2 is top-of-book snapshot; spoof walls can disappear before fill.',
      ],
      venues: ['Binance', 'Coinbase', 'Bybit (public L2)'],
    }
  }

  if (METAL_RE.test(upper) || METAL_RE.test(resolved)) {
    return {
      marketClass: 'precious_metal',
      label: 'Precious metals (OTC spot + COMEX futures)',
      deepSources: ['futures_flow', 'cot_positioning', 'volume_profile', 'session_liquidity', 'quote_spread'],
      limitations: [
        'No public L2 for gold/silver spot - use COMEX futures volume + COT positioning instead.',
        'COT is weekly (Tuesday cut, Friday release) - not tick-level.',
      ],
      venues: ['COMEX GC/SI futures', 'LBMA spot reference', 'CFTC COT'],
    }
  }

  if (COMMODITY_RE.test(upper)) {
    return {
      marketClass: 'commodity_futures',
      label: 'Commodity futures',
      deepSources: ['futures_flow', 'volume_profile', 'session_liquidity', 'quote_spread'],
      limitations: [
        'Free tier: Yahoo futures quote/volume only - no COT yet except gold/silver.',
        'No DOM/L2 on retail free APIs.',
      ],
      venues: ['CME/NYMEX/COMEX (Yahoo futures proxy)'],
    }
  }

  if (endpoint === 'forex' || symType === 'forex') {
    return {
      marketClass: 'forex_spot',
      label: 'FX spot (interbank)',
      deepSources: ['volume_profile', 'session_liquidity', 'quote_spread'],
      limitations: [
        'True Level-2 / DOM not available on free APIs - use volume profile + session timing.',
        'Weekend gap risk - Sydney reopen is first liquidity return.',
      ],
      venues: ['ECN/interbank (via OANDA/Finnhub quote)', 'London/NY session overlap'],
    }
  }

  if (symType === 'etf' || /^(SPY|QQQ|DIA|IWM|TLT|GLD|SLV|USO|UNG)$/i.test(upper.split(':').pop() ?? '')) {
    return {
      marketClass: 'us_etf',
      label: 'US ETF',
      deepSources: ['volume_profile', 'session_liquidity', 'quote_spread'],
      limitations: [
        'NBBO Level-2 not on free tier - volume profile from candles + RTH session timing.',
        'Pre/post-market liquidity is thinner than regular hours.',
      ],
      venues: ['NYSE Arca / NASDAQ (RTH 09:30–16:00 ET)'],
    }
  }

  if (INDEX_PROXY_RE.test(upper.split(':').pop() ?? upper)) {
    return {
      marketClass: 'index_proxy',
      label: 'Index (ETF proxy)',
      deepSources: ['volume_profile', 'session_liquidity', 'quote_spread'],
      limitations: ['Index cash has no single order book - trade via SPY/QQQ/DIA proxies.'],
      venues: ['SPY', 'QQQ', 'DIA', 'ES/NQ futures (not wired in free tier)'],
    }
  }

  if (symType === 'stock' || endpoint === 'stock') {
    return {
      marketClass: 'us_equity',
      label: 'US equity',
      deepSources: ['volume_profile', 'session_liquidity', 'quote_spread'],
      limitations: [
        'Retail free APIs: no NASDAQ TotalView / NYSE OpenBook - use volume profile + quote spread.',
        'Dark-pool prints invisible until after execution.',
      ],
      venues: ['NYSE', 'NASDAQ (RTH)'],
    }
  }

  return {
    marketClass: 'other',
    label: 'Other / international',
    deepSources: ['volume_profile', 'quote_spread'],
    limitations: [
      'Deep DOM unavailable - volume profile + TA only.',
      'Options chains, bonds, and perps not wired in free tier.',
    ],
    venues: ['Varies by symbol'],
  }
}

/** Compact catalog for agent system prompt injection. */
export const MARKET_UNIVERSE_SUMMARY = `TRADABLE MARKETS TODAY (deep-data availability)

| Class | Examples | Deep data we HAVE (free) | What we DON'T have |
|-------|----------|--------------------------|-------------------|
| Crypto spot | BTC, ETH, SOL (BINANCE:*) | L2 order book (Binance/Coinbase/Bybit), volume profile, 24h vol | Perp funding/OI, on-chain L2 |
| FX spot | EURUSD, GBPUSD, XAUUSD (OANDA:*) | Volume profile, session liquidity, calendar | True DOM / pending order book |
| US stocks/ETFs | AAPL, NVDA, SPY, QQQ | Volume profile (POC/VA), RTH session timing, quote | NBBO L2, dark pool queue |
| Precious metals | XAUUSD, XAGUSD | COMEX futures vol/OI, CFTC COT, spot, volume profile | Spot L2 (OTC) |
| Commodities | CL=F oil, NG=F gas | Yahoo futures quote/vol, volume profile | Full COT (except Au/Ag) |
| Options | SPY calls/puts | - | Not integrated - no chain/greeks |
| Futures (ES/NQ) | @ES, @NQ | - on free tier | Use SPY/QQQ proxy + volume profile |

ALWAYS call get_deep_market_data before a BUY/SELL setup - it routes to the right source per asset class.
For crypto: confirm L2 imbalance aligns with bias. For metals: check COT + futures volume.
For FX/stocks: POC/value area + next liquidity session for pending limit timing.`
