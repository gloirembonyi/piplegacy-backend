import {
  fetchMarketNewsFeed,
  fetchQuotes,
  formatTimeAgo,
  sentimentFromHeadline,
  type MarketNewsItem,
} from '@/lib/finnhub'
import { displaySymbolLabel, normalizeSymbol } from '@/lib/symbols'
import { BRAND_NAME } from '@/lib/brand'

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type MarketIdeaCategory =
  | 'stocks'
  | 'forex'
  | 'crypto'
  | 'commodities'
  | 'indices'
  | 'macro'

export type MarketIdea = {
  id: string
  /** Source bucket - drives the icon and accent color in the UI. */
  type: 'news' | 'mover' | 'ai'
  title: string
  summary: string
  /** Trading symbol (Finnhub form, e.g. `AAPL`, `OANDA:EUR_USD`). */
  symbol: string
  /** Human-readable label (`AAPL`, `EUR/USD`). */
  symbolLabel: string
  category: MarketIdeaCategory
  sentiment: 'bullish' | 'bearish' | 'neutral'
  bias?: 'BUY' | 'SELL' | 'HOLD'
  impact: 'high' | 'medium' | 'low'
  /** Latest price snapshot (when available). */
  price?: number
  changePercent?: number
  /** External resource (news source) - only set for type === 'news'. */
  url?: string
  /** Hero image (news) or null when we fall back to embedded mini chart. */
  image?: string
  source: string
  /** Display string ("2h ago"). */
  timeAgo: string
  /** Unix seconds, used for sorting. */
  publishedAt: number
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const MOVER_UNIVERSE: { symbol: string; category: MarketIdeaCategory }[] = [
  { symbol: 'AAPL', category: 'stocks' },
  { symbol: 'MSFT', category: 'stocks' },
  { symbol: 'NVDA', category: 'stocks' },
  { symbol: 'TSLA', category: 'stocks' },
  { symbol: 'GOOGL', category: 'stocks' },
  { symbol: 'AMZN', category: 'stocks' },
  { symbol: 'META', category: 'stocks' },
  { symbol: 'NFLX', category: 'stocks' },
  { symbol: 'AMD', category: 'stocks' },
  { symbol: 'JPM', category: 'stocks' },
  { symbol: 'BAC', category: 'stocks' },
  { symbol: 'BINANCE:BTCUSDT', category: 'crypto' },
  { symbol: 'BINANCE:ETHUSDT', category: 'crypto' },
  { symbol: 'BINANCE:SOLUSDT', category: 'crypto' },
  { symbol: 'OANDA:EUR_USD', category: 'forex' },
  { symbol: 'OANDA:GBP_USD', category: 'forex' },
  { symbol: 'OANDA:USD_JPY', category: 'forex' },
  { symbol: 'OANDA:XAU_USD', category: 'commodities' },
]

const NEWS_SYMBOL_HINTS: { keywords: RegExp; symbol: string; category: MarketIdeaCategory }[] = [
  { keywords: /\bapple|aapl\b/i, symbol: 'AAPL', category: 'stocks' },
  { keywords: /\bmicrosoft|msft\b/i, symbol: 'MSFT', category: 'stocks' },
  { keywords: /\bnvidia|nvda\b/i, symbol: 'NVDA', category: 'stocks' },
  { keywords: /\btesla|tsla\b/i, symbol: 'TSLA', category: 'stocks' },
  { keywords: /\balphabet|google|googl\b/i, symbol: 'GOOGL', category: 'stocks' },
  { keywords: /\bamazon|amzn\b/i, symbol: 'AMZN', category: 'stocks' },
  { keywords: /\bmeta|facebook\b/i, symbol: 'META', category: 'stocks' },
  { keywords: /\bnetflix|nflx\b/i, symbol: 'NFLX', category: 'stocks' },
  { keywords: /\bbitcoin|btc\b/i, symbol: 'BINANCE:BTCUSDT', category: 'crypto' },
  { keywords: /\bethereum|eth\b/i, symbol: 'BINANCE:ETHUSDT', category: 'crypto' },
  { keywords: /\bsolana|sol\b/i, symbol: 'BINANCE:SOLUSDT', category: 'crypto' },
  { keywords: /\bgold|xau\b/i, symbol: 'OANDA:XAU_USD', category: 'commodities' },
  { keywords: /\bsilver|xag\b/i, symbol: 'OANDA:XAG_USD', category: 'commodities' },
  { keywords: /\boil|crude|wti|brent\b/i, symbol: 'USO', category: 'commodities' },
  { keywords: /\beuro|eur\/usd|eurusd\b/i, symbol: 'OANDA:EUR_USD', category: 'forex' },
  { keywords: /\bgbp|sterling|pound\b/i, symbol: 'OANDA:GBP_USD', category: 'forex' },
  { keywords: /\byen|usd\/jpy|usdjpy\b/i, symbol: 'OANDA:USD_JPY', category: 'forex' },
  { keywords: /\bs&p|spx|sp500|spy\b/i, symbol: 'SPY', category: 'indices' },
  { keywords: /\bnasdaq|qqq\b/i, symbol: 'QQQ', category: 'indices' },
  { keywords: /\bdow|djia|dia\b/i, symbol: 'DIA', category: 'indices' },
]

function pickSymbolForNews(
  article: MarketNewsItem
): { symbol: string; category: MarketIdeaCategory } | null {
  // Finnhub returns `related` as a comma-separated string of tickers for
  // company news. Use the first one when we recognise it.
  if (article.related) {
    const first = article.related.split(',')[0]?.trim()
    if (first && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(first)) {
      return { symbol: first, category: 'stocks' }
    }
  }
  const text = `${article.headline ?? ''} ${article.summary ?? ''}`
  for (const hint of NEWS_SYMBOL_HINTS) {
    if (hint.keywords.test(text)) return { symbol: hint.symbol, category: hint.category }
  }
  return null
}

function classifyImpactScore(headline: string, summary: string): 'high' | 'medium' | 'low' {
  const text = `${headline} ${summary}`.toLowerCase()
  if (
    /\b(fed|fomc|rate decision|rate cut|cpi|inflation|gdp|nfp|payroll|ecb|boj|boe|war|crisis|default|sanction)\b/.test(
      text
    )
  ) {
    return 'high'
  }
  if (
    /\b(earnings|forecast|pmi|unemployment|trade balance|oil|gold|bitcoin|forex|merger|acquisition|guidance|downgrade|upgrade)\b/.test(
      text
    )
  ) {
    return 'medium'
  }
  return 'low'
}

function biasFromChange(changePercent: number): 'BUY' | 'SELL' | 'HOLD' {
  if (changePercent >= 1.5) return 'BUY'
  if (changePercent <= -1.5) return 'SELL'
  return 'HOLD'
}

function moverNarrative(
  symbolLabel: string,
  changePercent: number
): { title: string; summary: string } {
  const up = changePercent >= 0
  const magnitude = Math.abs(changePercent)
  const bias = up ? 'bulls' : 'bears'
  const action = up ? 'breakout' : 'breakdown'
  const tone = magnitude >= 3 ? 'aggressive' : magnitude >= 1.5 ? 'firm' : 'cautious'

  const title = `${symbolLabel} ${up ? '+' : ''}${changePercent.toFixed(2)}% - ${
    up ? 'Bullish' : 'Bearish'
  } momentum on the session`

  const summary = up
    ? `${symbolLabel} is showing ${tone} buying - the ${bias} are pressing the offer with a ${magnitude.toFixed(
        2
      )}% session ${action}. Watch the next pullback into support as a potential continuation entry; manage risk below the breakout pivot.`
    : `${symbolLabel} is under ${tone} pressure - the ${bias} have taken control with a ${magnitude.toFixed(
        2
      )}% session ${action}. Watch the next bounce into resistance as a potential continuation short; manage risk above the breakdown pivot.`

  return { title, summary }
}

// ───────────────────────────────────────────────────────────────────────────
// Aggregation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a curated list of "market ideas" from real data: notable news (with
 * recognised symbol + image when possible) and live top movers from a fixed
 * universe. Result is sorted by impact + recency.
 */
export async function buildMarketIdeas(): Promise<MarketIdea[]> {
  const [articles, moverQuotes] = await Promise.all([
    fetchMarketNewsFeed(30).catch(() => []),
    fetchQuotes(MOVER_UNIVERSE.map((m) => ({ symbol: m.symbol }))).catch(() => []),
  ])

  const ideas: MarketIdea[] = []
  const seenSymbols = new Set<string>()

  // 1) News ideas - only keep articles we can map to a symbol so the user
  // can jump to a chart that matches the headline.
  for (const a of articles) {
    const match = pickSymbolForNews(a)
    if (!match) continue
    const impact = classifyImpactScore(a.headline ?? '', a.summary ?? '')
    if (impact === 'low') continue // skip noise
    const sentiment = sentimentFromHeadline(a.headline ?? '')
    const sym = normalizeSymbol(match.symbol)
    seenSymbols.add(sym)
    ideas.push({
      id: `news-${a.id}`,
      type: 'news',
      title: a.headline?.slice(0, 140) || 'Market headline',
      summary: a.summary?.slice(0, 260) || '',
      symbol: sym,
      symbolLabel: displaySymbolLabel(sym),
      category: match.category,
      sentiment,
      bias:
        sentiment === 'bullish' ? 'BUY' : sentiment === 'bearish' ? 'SELL' : 'HOLD',
      impact,
      url: a.url,
      image: a.image && /^https?:/.test(a.image) ? a.image : undefined,
      source: a.source || 'News',
      timeAgo: formatTimeAgo(a.datetime),
      publishedAt: a.datetime,
    })
    if (ideas.length >= 8) break
  }

  // 2) Mover ideas - top 4 absolute movers that weren't already covered.
  const movers = moverQuotes
    .filter((q) => Number.isFinite(q.changePercent) && q.changePercent !== 0)
    .filter((q) => !seenSymbols.has(normalizeSymbol(q.symbol)))
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
    .slice(0, 4)

  const now = Math.floor(Date.now() / 1000)
  for (const q of movers) {
    const meta = MOVER_UNIVERSE.find((m) => m.symbol === q.symbol)
    const label = q.label || displaySymbolLabel(q.symbol)
    const sentiment: MarketIdea['sentiment'] =
      q.changePercent >= 0.5 ? 'bullish' : q.changePercent <= -0.5 ? 'bearish' : 'neutral'
    const { title, summary } = moverNarrative(label, q.changePercent)
    const impact: MarketIdea['impact'] =
      Math.abs(q.changePercent) >= 3
        ? 'high'
        : Math.abs(q.changePercent) >= 1.5
          ? 'medium'
          : 'low'
    ideas.push({
      id: `mover-${q.symbol}-${q.timestamp || now}`,
      type: 'mover',
      title,
      summary,
      symbol: q.symbol,
      symbolLabel: label,
      category: meta?.category ?? 'stocks',
      sentiment,
      bias: biasFromChange(q.changePercent),
      impact,
      price: q.price,
      changePercent: q.changePercent,
      source: BRAND_NAME,
      timeAgo: 'just now',
      publishedAt: now,
    })
  }

  // Sort: high impact first, then more recent.
  const rank = (i: MarketIdea) => (i.impact === 'high' ? 3 : i.impact === 'medium' ? 2 : 1)
  ideas.sort((a, b) => rank(b) - rank(a) || b.publishedAt - a.publishedAt)

  return ideas.slice(0, 12)
}
