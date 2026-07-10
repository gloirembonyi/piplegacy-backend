/**
 * Agent tool registry - Gemini function-calling declarations + executors.
 *
 * Each tool wraps an existing module (Finnhub, candles, calendar, sessions)
 * or adds a new free capability (DuckDuckGo, Google News). The agent loop
 * in `lib/agent/run.ts` chooses which to call to answer the user.
 */

import { fetchMarketCandles } from '@/lib/candle-providers'
import { fetchChartOverlayCandles } from '@/lib/chart-overlay-candles'
import { fetchEconomicCalendar, getHighImpactEvents } from '@/lib/economic-calendar'
import {
  fetchCompanyNews,
  fetchMarketNewsFeed,
  fetchQuote,
  fetchQuotes,
  formatTimeAgo,
  searchSymbols,
} from '@/lib/finnhub'
import {
  getActiveSessionNames,
  getMarketLiquidity,
  getMarketStatusForSymbol,
  getMinutesUntilNextSession,
  formatOpensIn,
  generateMarketNotes,
  isForexMarketOpen,
  isUsStockMarketOpen,
} from '@/lib/market-sessions'
import { buildNewsSearchQuery, searchNews, searchWeb, searchWebWithMeta, fetchWebPageText } from '@/lib/ai-tools/web-search'
import {
  fetchCoinGeckoQuote,
  fetchCryptoFearGreed,
  fetchCryptoGlobal,
  fetchCryptoTopMovers,
} from '@/lib/ai-tools/crypto-providers'
import {
  computeVolumeProfile,
  fetchOrderBookDepth,
} from '@/lib/ai-tools/deep-market'
import { fetchDeepMarketData } from '@/lib/ai-tools/deep-market-router'
import { fetchMetalsDeepMarket } from '@/lib/ai-tools/metals-deep-market'
import { displaySymbolLabel, resolveQuoteSymbol } from '@/lib/symbols'
import {
  computeTechnicalSummary,
  type TechnicalSummary,
} from '@/lib/ai-tools/technical-indicators'
import { analyzeMultiTimeframe } from '@/lib/ai-tools/multi-timeframe-analysis'
import {
  analyzeLiquidityAndInducement,
  assessTradeContext,
} from '@/lib/ai-tools/trade-context-analysis'
import {
  chartMcpToolDeclarations,
  getChartMcpToolByName,
} from '@/lib/chart-mcp/agent-tools'
import {
  getMetaAgentToolByName,
  metaAgentToolDeclarations,
} from '@/lib/agent/meta-tools/registry'
import {
  getTradingViewMcpToolByName,
  tradingViewMcpToolDeclarations,
} from '@/lib/tradingview-mcp/agent-tools'
import type { ToolContext, ToolDefinition, ToolTraceEntry } from '@/lib/ai-tools/types'

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/** World markets snapshot - major indices, FX, metals, crypto (Finnhub-backed). */
const GLOBAL_MARKET_SYMBOLS = [
  'SPY',
  'QQQ',
  'DXY',
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
  'XAUUSD',
  'XAGUSD',
  'BTCUSD',
  'ETHUSD',
] as const

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim().length ? v.trim() : fallback
}

function asInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

async function timed<T>(
  trace: ToolTraceEntry[],
  tool: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
  summarize: (r: T) => string
): Promise<T> {
  const start = Date.now()
  try {
    const result = await fn()
    const hasError =
      result != null &&
      typeof result === 'object' &&
      'error' in (result as object) &&
      (result as { error?: unknown }).error != null
    trace.push({
      tool,
      args,
      ok: !hasError,
      durationMs: Date.now() - start,
      summary: summarize(result),
      error: hasError ? String((result as { error?: unknown }).error) : undefined,
    })
    void import('@/lib/tool-usage-tracker').then(({ recordToolCall }) =>
      recordToolCall(tool, !hasError)
    )
    if (hasError) {
      void import('@/lib/admin-error-log').then(({ recordAdminError }) =>
        recordAdminError({
          kind: 'tool',
          target: tool,
          message: String((result as { error?: unknown }).error),
        })
      )
    }
    return result
  } catch (err) {
    trace.push({
      tool,
      args,
      ok: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    })
    void import('@/lib/tool-usage-tracker').then(({ recordToolCall }) => recordToolCall(tool, false))
    void import('@/lib/admin-error-log').then(({ recordAdminError }) =>
      recordAdminError({
        kind: 'tool',
        target: tool,
        message: err instanceof Error ? err.message : String(err),
      })
    )
    throw err
  }
}

export const TOOLS: ToolDefinition[] = [
  // ─── Quotes ───────────────────────────────────────────────
  {
    declaration: {
      name: 'get_quote',
      description:
        'Get the live quote (last price, change, day high/low, prev close) for a symbol. Use this before suggesting any trade setup so the entry/stop/target are anchored to the real current price.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description:
              'Ticker or pair, e.g. "AAPL", "NVDA", "EURUSD", "BTCUSD", "SPY", "XAUUSD". Defaults to the chart symbol when omitted.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, ctx.defaultSymbol ?? '')
      if (!symbol) return { error: 'No symbol provided.' }
      return timed(
        ctx.trace,
        'get_quote',
        { symbol },
        async () => {
          const q = await fetchQuote(symbol)
          if (!q) return { symbol, available: false }
          return {
            symbol,
            label: displaySymbolLabel(symbol),
            price: q.c,
            change: q.d,
            changePercent: q.dp,
            dayHigh: q.h,
            dayLow: q.l,
            open: q.o,
            prevClose: q.pc,
            asOf: new Date(q.t * 1000).toISOString(),
          }
        },
        (r) =>
          'available' in r && r.available === false
            ? `quote unavailable for ${symbol}`
            : `${displaySymbolLabel(symbol)} ${(r as { price: number }).price}`
      )
    },
  },

  // ─── Multi-symbol snapshot ─────────────────────────────────
  {
    declaration: {
      name: 'get_quotes_batch',
      description:
        'Get live quotes for several symbols at once (max 8). Useful for cross-asset / risk-on-vs-risk-off analysis.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbols: {
            type: 'ARRAY',
            description: 'Symbols to quote, e.g. ["SPY","QQQ","DXY","XAUUSD","BTCUSD"].',
            items: { type: 'STRING' },
          },
        },
        required: ['symbols'],
      },
    },
    execute: async (args, ctx) => {
      const raw = Array.isArray(args.symbols) ? (args.symbols as unknown[]) : []
      const symbols = raw
        .map((s) => asString(s))
        .filter(Boolean)
        .slice(0, 8)
      if (!symbols.length) return { quotes: [] }

      return timed(
        ctx.trace,
        'get_quotes_batch',
        { symbols },
        async () => {
          const quotes = await fetchQuotes(
            symbols.map((s) => ({ symbol: s, label: displaySymbolLabel(s) }))
          )
          return { quotes }
        },
        (r) => `${r.quotes.length}/${symbols.length} quotes`
      )
    },
  },

  // ─── Technical analysis on daily candles ───────────────────
  {
    declaration: {
      name: 'get_technical_analysis',
      description:
        'Compute live technical indicators from real daily OHLC: trend (SMA20/50 alignment), RSI14, ATR14, recent swing highs/lows, 5d & 20d return. Use this BEFORE proposing a setup to verify trend/structure/momentum.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description: 'Symbol to analyze. Defaults to the chart symbol.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, ctx.defaultSymbol ?? '')
      if (!symbol) return { error: 'No symbol provided.' }

      return timed(
        ctx.trace,
        'get_technical_analysis',
        { symbol },
        async () => {
          const candles = await fetchMarketCandles(symbol, 'D')
          if (!candles.data.length) return { symbol, available: false }
          const tech = computeTechnicalSummary(candles.data)
          if (!tech) return { symbol, available: false }
          return {
            symbol,
            label: displaySymbolLabel(symbol),
            source: candles.source,
            ...tech,
            // round long decimals so the model picks clean numbers
            sma20: tech.sma20 != null ? Number(tech.sma20.toFixed(4)) : null,
            sma50: tech.sma50 != null ? Number(tech.sma50.toFixed(4)) : null,
            ema21: tech.ema21 != null ? Number(tech.ema21.toFixed(4)) : null,
            rsi14: tech.rsi14 != null ? Number(tech.rsi14.toFixed(1)) : null,
            atr14: tech.atr14 != null ? Number(tech.atr14.toFixed(4)) : null,
            changePct5:
              tech.changePct5 != null ? Number(tech.changePct5.toFixed(2)) : null,
            changePct20:
              tech.changePct20 != null ? Number(tech.changePct20.toFixed(2)) : null,
          } as Record<string, unknown> & TechnicalSummary
        },
        (r) => {
          const t = r as { trend?: string; rsi14?: number | null }
          return t.trend ? `${symbol} ${t.trend} rsi=${t.rsi14}` : `${symbol} n/a`
        }
      )
    },
  },

  // ─── Multi-timeframe alignment (chart TF + lower/higher context) ──
  {
    declaration: {
      name: 'analyze_multi_timeframe',
      description:
        'Compare trend/bias across the user chart timeframe plus adjacent lower and higher timeframes (5m–1d). Returns alignment (strong/partial/conflicting), dominant bias, and WAIT when lower-TF momentum fights higher-TF structure. CALL BEFORE any BUY/SELL setup so you do not signal on a fast TF against HTF resistance or smart-money continuation.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING', description: 'Symbol. Defaults to chart symbol.' },
          resolution: {
            type: 'STRING',
            description: 'User chart resolution (1, 5, 15, 60, 240, D). Defaults to chart TF.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, ctx.defaultSymbol ?? '')
      const resolution = asString(args.resolution, ctx.defaultResolution ?? '60')
      if (!symbol) return { error: 'No symbol provided.' }

      return timed(
        ctx.trace,
        'analyze_multi_timeframe',
        { symbol, resolution },
        async () => analyzeMultiTimeframe({ symbol, resolution }),
        (r) => {
          const a = r as { alignment?: string; recommendation?: string; chartTimeframe?: string }
          return `${symbol} ${a.chartTimeframe ?? resolution} ${a.alignment ?? '?'} → ${a.recommendation ?? '?'}`
        }
      )
    },
  },

  // ─── Smart money: liquidity pools, inducement, sweeps ───────
  {
    declaration: {
      name: 'analyze_liquidity_and_inducement',
      description:
        'Rule-based Smart Money scan: equal highs/lows (liquidity pools), stop-hunt sweeps, inducement fake-outs, order blocks, FVG, BOS/CHoCH on chart TF + higher TF. Returns confirmed vs speculative signals and fake-out/stop-hunt risk. CALL before BUY/SELL or when user asks about liquidity, inducement, traps, or smart money.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING', description: 'Symbol. Defaults to chart symbol.' },
          resolution: {
            type: 'STRING',
            description: 'Chart resolution (1, 5, 15, 60, 240, D). Defaults to chart TF.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, ctx.defaultSymbol ?? '')
      const resolution = asString(args.resolution, ctx.defaultResolution ?? '60')
      if (!symbol) return { error: 'No symbol provided.' }

      return timed(
        ctx.trace,
        'analyze_liquidity_and_inducement',
        { symbol, resolution },
        async () => analyzeLiquidityAndInducement({ symbol, resolution }),
        (r) => {
          const a = r as { summary?: string }
          return a.summary?.slice(0, 80) ?? `${symbol} SMC`
        }
      )
    },
  },

  // ─── Full trader context: session + event + MTF + SMC + GO/WAIT ─
  {
    declaration: {
      name: 'assess_trade_context',
      description:
        'One-shot pre-trade desk check: active session & killzone, next high-impact event, multi-timeframe alignment, liquidity/inducement/sweeps, and a GO_BUY / GO_SELL / WAIT decision with watchFor triggers. CALL FIRST on setup, entry timing, or "should I buy/sell/wait" questions before proposing levels.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING', description: 'Symbol. Defaults to chart symbol.' },
          resolution: {
            type: 'STRING',
            description: 'Chart resolution. Defaults to chart TF.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, ctx.defaultSymbol ?? '')
      const resolution = asString(args.resolution, ctx.defaultResolution ?? '60')
      if (!symbol) return { error: 'No symbol provided.' }

      return timed(
        ctx.trace,
        'assess_trade_context',
        { symbol, resolution },
        async () => assessTradeContext({ symbol, resolution }),
        (r) => {
          const a = r as { decision?: { action?: string }; traderNote?: string }
          return a.decision?.action
            ? `${symbol} → ${a.decision.action}`
            : a.traderNote?.slice(0, 60) ?? `${symbol} context`
        }
      )
    },
  },

  // ─── Intraday candles for the requested timeframe ─────────
  {
    declaration: {
      name: 'get_intraday_candles',
      description:
        'Fetch the last ~150 OHLC bars for an intraday timeframe (1, 5, 15, 60 minutes) so you can read recent structure / supply-demand zones on the actual trading timeframe.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING', description: 'Symbol. Defaults to chart symbol.' },
          resolution: {
            type: 'STRING',
            enum: ['1', '5', '15', '60', 'D'],
            description: 'Chart timeframe: 1=1m, 5=5m, 15=15m, 60=1h, D=daily.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, ctx.defaultSymbol ?? '')
      const resolution = asString(args.resolution, ctx.defaultResolution ?? 'D')
      if (!symbol) return { error: 'No symbol provided.' }

      return timed(
        ctx.trace,
        'get_intraday_candles',
        { symbol, resolution },
        async () => {
          const bars = await fetchChartOverlayCandles(symbol, resolution)
          const recent = bars.slice(-30)
          return {
            symbol,
            resolution,
            barsReturned: recent.length,
            totalAvailable: bars.length,
            lastBars: recent.map((b) => ({
              t: b.t,
              o: b.o,
              h: b.h,
              l: b.l,
              c: b.c,
            })),
          }
        },
        (r) => `${(r as { barsReturned: number }).barsReturned} bars`
      )
    },
  },

  // ─── Per-symbol company news ───────────────────────────────
  {
    declaration: {
      name: 'get_company_news',
      description:
        'Fetch recent company-specific news headlines for an equity ticker (AAPL, NVDA, TSLA…). Returns empty for FX/crypto - use search_news or get_market_news for those.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING', description: 'Equity ticker. Defaults to chart symbol.' },
          daysBack: {
            type: 'INTEGER',
            description: 'How many days of news to scan (1–30). Default 7.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, ctx.defaultSymbol ?? '')
      const daysBack = clamp(asInt(args.daysBack, 7), 1, 30)
      if (!symbol) return { error: 'No symbol provided.' }

      return timed(
        ctx.trace,
        'get_company_news',
        { symbol, daysBack },
        async () => {
          const news = await fetchCompanyNews(symbol, daysBack, 8)
          return {
            symbol,
            count: news.length,
            news: news.map((n) => ({
              headline: n.headline,
              source: n.source,
              url: n.url,
              when: formatTimeAgo(n.datetime),
              summary: n.summary?.slice(0, 280) ?? '',
            })),
          }
        },
        (r) => `${(r as { count: number }).count} headlines`
      )
    },
  },

  // ─── Cross-market headlines ────────────────────────────────
  {
    declaration: {
      name: 'get_market_news',
      description:
        'Broad market / forex headlines (Finnhub general + forex feed). Use for risk-on/off, USD strength, geopolitics, central banks.',
      parameters: {
        type: 'OBJECT',
        properties: {
          limit: {
            type: 'INTEGER',
            description: 'Max items (1–15). Default 8.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const limit = clamp(asInt(args.limit, 8), 1, 15)
      return timed(
        ctx.trace,
        'get_market_news',
        { limit },
        async () => {
          const news = await fetchMarketNewsFeed(limit)
          return {
            count: news.length,
            news: news.map((n) => ({
              headline: n.headline,
              source: n.source,
              url: n.url,
              when: formatTimeAgo(n.datetime),
            })),
          }
        },
        (r) => `${(r as { count: number }).count} headlines`
      )
    },
  },

  // ─── Global cross-market snapshot ─────────────────────────
  {
    declaration: {
      name: 'get_global_market_snapshot',
      description:
        'Live quotes across world markets in one call: US indices (SPY/QQQ), DXY, major FX pairs, gold/silver, BTC/ETH. Use for risk-on/off, global context, or when user asks about "markets" broadly.',
      parameters: {
        type: 'OBJECT',
        properties: {
          include_crypto: {
            type: 'BOOLEAN',
            description: 'Include BTCUSD and ETHUSD. Default true.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const includeCrypto = args.include_crypto !== false
      const symbols = includeCrypto
        ? [...GLOBAL_MARKET_SYMBOLS]
        : GLOBAL_MARKET_SYMBOLS.filter((s) => !/^BTC|^ETH/.test(s))

      return timed(
        ctx.trace,
        'get_global_market_snapshot',
        { includeCrypto },
        async () => {
          const quotes = await fetchQuotes(
            symbols.map((s) => ({ symbol: s, label: displaySymbolLabel(s) }))
          )
          return { quotes, count: quotes.length, symbols: symbols.slice(0, quotes.length) }
        },
        (r) => `${(r as { count: number }).count} global quotes`
      )
    },
  },

  // ─── Internet search (MCP-style broad web) ─────────────────
  {
    declaration: {
      name: 'search_internet',
      description:
        'Search the open internet for anything traders need: central bank speeches, geopolitics, exchange rules, on-chain data headlines, analyst reports, commodity supply news. Google CSE when configured, else DuckDuckGo.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'Full web search query.' },
          limit: { type: 'INTEGER', description: 'Max results (1–8). Default 6.' },
        },
        required: ['query'],
      },
    },
    execute: async (args, ctx) => {
      const query = asString(args.query)
      const limit = clamp(asInt(args.limit, 6), 1, 8)
      if (!query) return { results: [] }

      return timed(
        ctx.trace,
        'search_internet',
        { query, limit },
        async () => {
          const { results, meta } = await searchWebWithMeta(query, limit)
          return { query, count: results.length, results, searchProvider: meta.provider }
        },
        (r) => `${(r as { count: number }).count} web hits`
      )
    },
  },

  // ─── Fetch public web page (MCP-style read) ────────────────
  {
    declaration: {
      name: 'fetch_web_page',
      description:
        'Read text content from a public HTTPS URL (news article, central bank page, exchange announcement). Use after search_internet when you need details from a specific link.',
      parameters: {
        type: 'OBJECT',
        properties: {
          url: { type: 'STRING', description: 'Public https:// URL to fetch.' },
        },
        required: ['url'],
      },
    },
    execute: async (args, ctx) => {
      const url = asString(args.url)
      if (!url) return { error: 'No URL provided.' }

      return timed(
        ctx.trace,
        'fetch_web_page',
        { url },
        async () => {
          const page = await fetchWebPageText(url)
          if (!page) return { error: 'Could not fetch URL (blocked, private, or timeout).' }
          return page
        },
        (r) =>
          'error' in (r as object)
            ? 'fetch failed'
            : `${((r as { title: string }).title || 'page').slice(0, 40)}`
      )
    },
  },

  // ─── Free-form web search ──────────────────────────────────
  {
    declaration: {
      name: 'search_web',
      description:
        'Search the entire web for market research: earnings, central bank speeches, geopolitics, crypto on-chain news, analyst notes. Uses Google Custom Search when GOOGLE_CUSTOM_SEARCH_API_KEY is set; falls back to DuckDuckGo.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'Search query.' },
          limit: { type: 'INTEGER', description: 'Max results (1–8). Default 5.' },
        },
        required: ['query'],
      },
    },
    execute: async (args, ctx) => {
      const query = asString(args.query)
      const limit = clamp(asInt(args.limit, 5), 1, 8)
      if (!query) return { results: [] }

      return timed(
        ctx.trace,
        'search_web',
        { query, limit },
        async () => {
          const { results, meta } = await searchWebWithMeta(query, limit)
          return { query, count: results.length, results, searchProvider: meta.provider }
        },
        (r) => `${(r as { count: number }).count} hits`
      )
    },
  },

  // ─── Fresh news search (Google News) ───────────────────────
  {
    declaration: {
      name: 'search_news',
      description:
        'Search the latest news for any keyword via Google News RSS. Best for breaking events, named people/companies, FX or crypto headlines.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: 'News query (e.g. "EUR/USD ECB", "NVDA earnings", "Bitcoin ETF").',
          },
          limit: { type: 'INTEGER', description: 'Max items (1–10). Default 6.' },
        },
        required: ['query'],
      },
    },
    execute: async (args, ctx) => {
      const query = asString(args.query)
      const limit = clamp(asInt(args.limit, 6), 1, 10)
      if (!query) return { results: [] }
      const newsQuery = buildNewsSearchQuery(query)

      return timed(
        ctx.trace,
        'search_news',
        { query: newsQuery, limit },
        async () => {
          const results = await searchNews(newsQuery, limit)
          return { query: newsQuery, count: results.length, results }
        },
        (r) => `${(r as { count: number }).count} articles`
      )
    },
  },

  // ─── Economic calendar ─────────────────────────────────────
  {
    declaration: {
      name: 'get_economic_calendar',
      description:
        'Upcoming or recent economic events (CPI, NFP, FOMC, ECB, BOJ, retail sales, PMIs). Filter by impact, currency, day range.',
      parameters: {
        type: 'OBJECT',
        properties: {
          daysAhead: {
            type: 'INTEGER',
            description: '0–30 days ahead. Default 7.',
          },
          daysBack: {
            type: 'INTEGER',
            description: '0–7 days back (for released figures). Default 0.',
          },
          currency: {
            type: 'STRING',
            description: 'Optional ISO currency filter (USD, EUR, GBP, JPY, AUD, CAD, CHF, NZD, CNY).',
          },
          highImpactOnly: {
            type: 'BOOLEAN',
            description: 'If true, return only high-impact events.',
          },
          limit: {
            type: 'INTEGER',
            description: 'Max items (1–40). Default 15.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const daysAhead = clamp(asInt(args.daysAhead, 7), 0, 30)
      const daysBack = clamp(asInt(args.daysBack, 0), 0, 7)
      const currency = asString(args.currency).toUpperCase() || undefined
      const highImpactOnly = args.highImpactOnly === true
      const limit = clamp(asInt(args.limit, 15), 1, 40)

      return timed(
        ctx.trace,
        'get_economic_calendar',
        { daysAhead, daysBack, currency, highImpactOnly, limit },
        async () => {
          const from = new Date(Date.now() - daysBack * 86_400_000)
            .toISOString()
            .split('T')[0]
          const to = new Date(Date.now() + daysAhead * 86_400_000)
            .toISOString()
            .split('T')[0]
          const calendar = await fetchEconomicCalendar(from, to)
          let events = calendar.data
          if (currency) events = events.filter((e) => e.currency === currency)
          if (highImpactOnly)
            events = events.filter((e) => e.impact === 'high')
          else
            events = events.filter(
              (e) => e.impact === 'high' || e.impact === 'medium'
            )
          events = events.slice(0, limit)
          const top = getHighImpactEvents(events, 3)

          return {
            range: { from, to },
            count: events.length,
            sources: calendar.sources,
            topHighImpact: top.map((e) => ({
              date: e.date,
              time: e.time,
              event: e.event,
              currency: e.currency,
              impact: e.impact,
              forecast: e.forecast,
              previous: e.previous,
              actual: e.actual,
            })),
            events: events.map((e) => ({
              date: e.date,
              time: e.time,
              event: e.event,
              currency: e.currency,
              impact: e.impact,
              forecast: e.forecast,
              previous: e.previous,
              actual: e.actual,
            })),
          }
        },
        (r) => `${(r as { count: number }).count} events`
      )
    },
  },

  // ─── Market sessions / hours ───────────────────────────────
  {
    declaration: {
      name: 'get_market_sessions',
      description:
        'Live market session status: which sessions (Sydney/Tokyo/London/New York) are open, current liquidity, minutes until next session, FX/US market open flag. Use before suggesting a trade so the timing is right.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    execute: async (args, ctx) => {
      return timed(
        ctx.trace,
        'get_market_sessions',
        {},
        async () => {
          const symbol = ctx.defaultSymbol
          const sessions = getActiveSessionNames()
          const liquidity = getMarketLiquidity()
          const status = symbol ? getMarketStatusForSymbol(symbol) : null
          const nextSession = getMinutesUntilNextSession()
          return {
            activeSessions: sessions,
            liquidity,
            forexOpen: isForexMarketOpen(),
            usStockOpen: isUsStockMarketOpen(),
            forSymbol: status,
            nextSession: nextSession
              ? {
                  name: nextSession.name,
                  currency: nextSession.currency,
                  minutesUntil: nextSession.minutes,
                  opensIn: formatOpensIn(nextSession.minutes),
                }
              : null,
            notes: generateMarketNotes(sessions),
          }
        },
        (r) => {
          const s = r as { activeSessions: string[]; liquidity: string }
          return `${s.activeSessions.length} sessions / ${s.liquidity}`
        }
      )
    },
  },

  // ─── Symbol search ─────────────────────────────────────────
  {
    declaration: {
      name: 'search_symbols',
      description:
        'Resolve a free-text instrument name to a tradable symbol (e.g. "apple" → AAPL, "euro dollar" → OANDA:EUR_USD). Use when the user mentions an asset by name.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING' },
          limit: { type: 'INTEGER', description: 'Max matches (1–10). Default 5.' },
        },
        required: ['query'],
      },
    },
    execute: async (args, ctx) => {
      const query = asString(args.query)
      const limit = clamp(asInt(args.limit, 5), 1, 10)
      if (!query) return { matches: [] }

      return timed(
        ctx.trace,
        'search_symbols',
        { query, limit },
        async () => {
          const matches = await searchSymbols(query, limit)
          return { query, count: matches.length, matches }
        },
        (r) => `${(r as { count: number }).count} matches`
      )
    },
  },

  // ─── Resolved symbol metadata (no API hit) ─────────────────
  {
    declaration: {
      name: 'resolve_symbol',
      description:
        'Resolve a user-friendly ticker to its provider-qualified form and label, e.g. "BTC" → "BINANCE:BTCUSDT".',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description: 'Ticker or name, e.g. BTC, EURUSD, apple',
          },
          query: {
            type: 'STRING',
            description: 'Alias for symbol when resolving free text.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, asString(args.query, ctx.defaultSymbol ?? ''))
      if (!symbol) return { error: 'Provide symbol or query.' }

      ctx.trace.push({
        tool: 'resolve_symbol',
        args: { symbol },
        ok: true,
        durationMs: 0,
        summary: displaySymbolLabel(symbol),
      })
      return {
        input: symbol,
        resolved: resolveQuoteSymbol(symbol),
        label: displaySymbolLabel(symbol),
      }
    },
  },

  // ─── Crypto deep-data (CoinGecko, no key) ─────────────────
  {
    declaration: {
      name: 'get_crypto_quote',
      description:
        'Free CoinGecko quote for a crypto asset - adds market cap, 24h volume, ATH, ATH distance % that Finnhub does not provide. Use ONLY for crypto symbols (BTC, ETH, SOL, etc.).',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description: 'Ticker (BTC, ETH, SOL…) or BINANCE:BTCUSDT-style.',
          },
        },
        required: ['symbol'],
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, asString(ctx.defaultSymbol))
      if (!symbol) return { error: 'No symbol provided.' }
      const start = Date.now()
      const q = await fetchCoinGeckoQuote(symbol)
      const durationMs = Date.now() - start
      if (!q) {
        ctx.trace.push({
          tool: 'get_crypto_quote',
          args: { symbol },
          ok: false,
          durationMs,
          error: 'no data',
        })
        return { error: `No CoinGecko data for "${symbol}".` }
      }
      ctx.trace.push({
        tool: 'get_crypto_quote',
        args: { symbol },
        ok: true,
        durationMs,
        summary: `${q.symbol} ${q.price} (${q.changePct24h.toFixed(2)}% 24h)`,
      })
      return q
    },
  },
  {
    declaration: {
      name: 'get_crypto_global',
      description:
        'Global crypto market metrics: total market cap, 24h change, BTC + ETH dominance, total volume, active coin count. Use to gauge broad crypto risk-on/off.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    execute: async (_args, ctx) => {
      const start = Date.now()
      const g = await fetchCryptoGlobal()
      const durationMs = Date.now() - start
      if (!g) {
        ctx.trace.push({
          tool: 'get_crypto_global',
          args: {},
          ok: false,
          durationMs,
          error: 'no data',
        })
        return { error: 'CoinGecko global metrics unavailable.' }
      }
      ctx.trace.push({
        tool: 'get_crypto_global',
        args: {},
        ok: true,
        durationMs,
        summary: `Cap $${(g.totalMarketCapUsd / 1e12).toFixed(2)}T (${g.marketCapChangePct24h.toFixed(2)}%) · BTC dom ${g.btcDominancePct.toFixed(1)}%`,
      })
      return g
    },
  },
  {
    declaration: {
      name: 'get_crypto_movers',
      description:
        'Top crypto gainers OR losers in the last 24h (from the top 100 by market cap). Use to spot rotations and risk-on themes.',
      parameters: {
        type: 'OBJECT',
        properties: {
          direction: {
            type: 'STRING',
            enum: ['gainers', 'losers'],
            description: 'gainers or losers',
          },
          limit: {
            type: 'NUMBER',
            description: 'Max rows returned (1-15, default 8).',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const direction =
        asString(args.direction).toLowerCase() === 'losers' ? 'losers' : 'gainers'
      const limit = clamp(asInt(args.limit, 8), 1, 15)
      const start = Date.now()
      const rows = await fetchCryptoTopMovers(direction, limit)
      const durationMs = Date.now() - start
      ctx.trace.push({
        tool: 'get_crypto_movers',
        args: { direction, limit },
        ok: rows.length > 0,
        durationMs,
        summary: rows.length
          ? `${direction}: ${rows
              .slice(0, 3)
              .map((r) => `${r.symbol} ${r.changePct24h.toFixed(1)}%`)
              .join(', ')}`
          : 'no movers',
      })
      return { direction, count: rows.length, movers: rows }
    },
  },
  {
    declaration: {
      name: 'get_crypto_fear_greed',
      description:
        'Crypto Fear & Greed index (Alternative.me, 0-100). Use as sentiment confirmation for BTC/ETH setups - extremes often contrarian.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    execute: async (_args, ctx) => {
      const start = Date.now()
      const f = await fetchCryptoFearGreed()
      const durationMs = Date.now() - start
      if (!f) {
        ctx.trace.push({
          tool: 'get_crypto_fear_greed',
          args: {},
          ok: false,
          durationMs,
          error: 'no data',
        })
        return { error: 'Fear & Greed unavailable.' }
      }
      ctx.trace.push({
        tool: 'get_crypto_fear_greed',
        args: {},
        ok: true,
        durationMs,
        summary: `${f.value} (${f.label})`,
      })
      return f
    },
  },

  // ─── Deep market: L2 order-book depth ─────────────────────
  {
    declaration: {
      name: 'get_orderbook_depth',
      description:
        'Free Level-2 order-book depth for a crypto pair via Binance / Coinbase / Bybit (no key). Returns best bid/ask, spread (bps), bid/ask volume, order-flow IMBALANCE (-1..+1), and the largest BID and ASK walls. Use AT THE MOMENT OF AN ENTRY DECISION or near key levels to confirm bid/ask pressure. Crypto only - returns an error for FX/equities.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description:
              'Crypto symbol: BTC, ETH, BINANCE:BTCUSDT, COINBASE:BTC-USD, etc.',
          },
          exchange: {
            type: 'STRING',
            enum: ['binance', 'coinbase', 'bybit'],
            description: 'Preferred exchange (optional, default binance).',
          },
          limit: {
            type: 'NUMBER',
            description: 'Levels per side (5-100, default 20).',
          },
        },
        required: ['symbol'],
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, asString(ctx.defaultSymbol))
      if (!symbol) return { error: 'No symbol provided.' }
      const exchangeRaw = asString(args.exchange).toLowerCase()
      const exchange =
        exchangeRaw === 'coinbase' || exchangeRaw === 'bybit'
          ? (exchangeRaw as 'coinbase' | 'bybit')
          : exchangeRaw === 'binance'
            ? 'binance'
            : undefined
      const limit = clamp(asInt(args.limit, 20), 5, 100)

      const start = Date.now()
      const snap = await fetchOrderBookDepth(symbol, { exchange, limit })
      const durationMs = Date.now() - start
      if (!snap) {
        ctx.trace.push({
          tool: 'get_orderbook_depth',
          args: { symbol, exchange, limit },
          ok: false,
          durationMs,
          error: 'no L2 data (likely non-crypto or exchange offline)',
        })
        return {
          error:
            'Order-book depth not available for this asset. Free L2 only exists for crypto (Binance / Coinbase / Bybit).',
        }
      }
      const imbPct = (snap.imbalance * 100).toFixed(1)
      const side =
        snap.imbalance > 0.1
          ? 'BID-heavy'
          : snap.imbalance < -0.1
            ? 'ASK-heavy'
            : 'balanced'
      ctx.trace.push({
        tool: 'get_orderbook_depth',
        args: { symbol, exchange, limit },
        ok: true,
        durationMs,
        summary: `${snap.exchange} ${snap.symbol} spread ${snap.spreadBps.toFixed(1)}bps · imbalance ${imbPct}% ${side}`,
      })
      // Trim to top 10 each side to keep tool response under 2 KB.
      return {
        ...snap,
        bidLevels: snap.bidLevels.slice(0, 10),
        askLevels: snap.askLevels.slice(0, 10),
      }
    },
  },

  // ─── Deep market: volume profile (works for any asset class) ──
  {
    declaration: {
      name: 'get_volume_profile',
      description:
        "Compute a Volume Profile (Point of Control, Value Area High/Low) from intraday candles for ANY asset. Use to find high-volume nodes (HVN - magnetic prices) and low-volume nodes (LVN - break-and-run zones). The POC often acts as a magnet; price tends to revert toward it inside the value area and accelerate outside it.",
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING' },
          resolution: {
            type: 'STRING',
            enum: ['1', '5', '15', '60', 'D'],
            description: 'Candle resolution (default 60).',
          },
          binCount: {
            type: 'NUMBER',
            description: 'Number of price bins (8-50, default 24).',
          },
        },
        required: ['symbol'],
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, asString(ctx.defaultSymbol))
      if (!symbol) return { error: 'No symbol provided.' }
      const resolution = asString(args.resolution, '60')
      const binCount = clamp(asInt(args.binCount, 24), 8, 50)

      const start = Date.now()
      const bars = await fetchChartOverlayCandles(symbol, resolution)
      if (!bars || bars.length < 10) {
        const durationMs = Date.now() - start
        ctx.trace.push({
          tool: 'get_volume_profile',
          args: { symbol, resolution, binCount },
          ok: false,
          durationMs,
          error: 'not enough candle data',
        })
        return { error: 'Not enough candle data to compute volume profile.' }
      }
      const profile = computeVolumeProfile(
        bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
        { binCount }
      )
      const durationMs = Date.now() - start
      if (!profile) {
        ctx.trace.push({
          tool: 'get_volume_profile',
          args: { symbol, resolution, binCount },
          ok: false,
          durationMs,
          error: 'profile unavailable',
        })
        return { error: 'Could not compute volume profile.' }
      }
      const hasRealVol = bars.some((b) => typeof b.v === 'number' && b.v > 0)
      ctx.trace.push({
        tool: 'get_volume_profile',
        args: { symbol, resolution, binCount },
        ok: true,
        durationMs,
        summary: `POC ${profile.pocPrice.toFixed(4)} · VA ${profile.valueAreaLow.toFixed(4)}-${profile.valueAreaHigh.toFixed(4)} (${profile.bars} bars${hasRealVol ? ', real vol' : ''})`,
      })
      // Return only top-volume bins to keep payload small.
      const topBins = [...profile.bins]
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 8)
      return {
        ...profile,
        bins: topBins.sort((a, b) => a.priceLow - b.priceLow),
      }
    },
  },

  // ─── Unified deep market (L2 / volume / timing per asset class) ──
  {
    declaration: {
      name: 'get_deep_market_data',
      description:
        'Unified deep-market snapshot for ANY tradable symbol. Auto-routes by asset class: crypto → L2 order book + imbalance + walls; metals → COMEX futures + COT; FX/stocks/ETFs → volume profile (POC/VA) + session liquidity + fill-timing estimates. Returns pending-order proxy, volume analysis, and orderTiming (best fill window, price-reach ETA, depth absorption for crypto). CALL BEFORE final BUY/SELL/WAIT setup on every symbol.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING', description: 'Any tradable symbol (BTC, AAPL, XAUUSD, EURUSD, SPY…).' },
          resolution: {
            type: 'STRING',
            enum: ['1', '5', '15', '60', 'D'],
            description: 'Candle resolution for volume profile + timing (default 60).',
          },
          targetPrice: {
            type: 'NUMBER',
            description: 'Planned entry/limit price - enables price-reach and depth-absorption ETA.',
          },
          entryPrice: {
            type: 'NUMBER',
            description: 'Alias for targetPrice (planned entry).',
          },
        },
        required: ['symbol'],
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, asString(ctx.defaultSymbol))
      if (!symbol) return { error: 'No symbol provided.' }
      const resolution = asString(args.resolution, '60')
      const targetPrice =
        typeof args.targetPrice === 'number' && Number.isFinite(args.targetPrice)
          ? args.targetPrice
          : typeof args.entryPrice === 'number' && Number.isFinite(args.entryPrice)
            ? args.entryPrice
            : undefined

      const start = Date.now()
      const snap = await fetchDeepMarketData(symbol, { resolution, targetPrice })
      const durationMs = Date.now() - start

      if ('error' in snap) {
        ctx.trace.push({
          tool: 'get_deep_market_data',
          args: { symbol, resolution, targetPrice },
          ok: false,
          durationMs,
          error: snap.error,
        })
        return snap
      }

      const poc = snap.volumeAnalysis?.poc
      const imb = snap.pendingOrdersProxy?.imbalanceLabel ?? snap.market.label
      ctx.trace.push({
        tool: 'get_deep_market_data',
        args: { symbol, resolution, targetPrice },
        ok: true,
        durationMs,
        summary: `${snap.market.marketClass} · ${imb}${poc ? ` · POC ${poc.toFixed(2)}` : ''}`,
      })

      return {
        ...snap,
        orderbook: snap.orderbook
          ? {
              ...snap.orderbook,
              bidLevels: snap.orderbook.bidLevels.slice(0, 8),
              askLevels: snap.orderbook.askLevels.slice(0, 8),
            }
          : undefined,
        volumeProfile: snap.volumeProfile
          ? {
              ...snap.volumeProfile,
              bins: snap.volumeProfile.bins.slice(0, 6),
            }
          : undefined,
      }
    },
  },

  // ─── Multi-source catalyst research ───────────────────────
  {
    declaration: {
      name: 'research_catalysts',
      description:
        "Deep research on what could drive a SPECIFIC asset over the next days/weeks. Fans out to news (Google News), web (DuckDuckGo), Finnhub company news, and the economic calendar IN PARALLEL, then returns a combined catalyst brief. Use when the user asks: 'what could move X', 'upcoming catalysts', 'why is X moving', 'narrative around X', 'is X a buy long-term'. Only call when the question is forward-looking or thesis-oriented - not for simple price checks.",
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description: 'Asset symbol or theme (e.g. AAPL, BTC, "AI stocks").',
          },
          theme: {
            type: 'STRING',
            description:
              'Optional narrative angle (e.g. "ETF approval", "earnings", "Fed policy").',
          },
          horizonDays: {
            type: 'NUMBER',
            description: 'Forward calendar window in days (1-90, default 14).',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, asString(ctx.defaultSymbol))
      const theme = asString(args.theme)
      const subject = symbol || theme
      if (!subject) return { error: 'Provide a symbol or theme.' }

      const horizonDays = clamp(asInt(args.horizonDays, 14), 1, 90)

      return timed(
        ctx.trace,
        'research_catalysts',
        { symbol: symbol || undefined, theme: theme || undefined, horizonDays },
        async () => {
          const newsQuery = theme ? (symbol ? `${symbol} ${theme}` : theme) : symbol
          const webQuery = theme
            ? `${subject} ${theme} catalyst 2026`
            : `${subject} upcoming catalyst 2026`
          const fromDate = new Date()
          const toDate = new Date(fromDate.getTime() + horizonDays * 86_400_000)
          const fmt = (d: Date) => d.toISOString().slice(0, 10)
          const isStockTicker = Boolean(symbol && /^[A-Z]{1,5}$/.test(symbol))

          const [news, web, companyNews, calendar] = await Promise.all([
            searchNews(newsQuery, 6).catch(() => []),
            searchWeb(webQuery, 4).catch(() => []),
            isStockTicker
              ? fetchCompanyNews(symbol, 7, 4).catch(() => [])
              : Promise.resolve([]),
            fetchEconomicCalendar(fmt(fromDate), fmt(toDate)).catch(() => ({
              data: [],
              sources: [] as string[],
            })),
          ])

          return {
            symbol: symbol || null,
            theme: theme || null,
            subject,
            horizonDays,
            news,
            web,
            companyNews,
            upcomingEvents: Array.isArray(calendar.data)
              ? getHighImpactEvents(calendar.data, 8)
              : [],
            sources: calendar.sources,
          }
        },
        (r) => {
          const data = r as {
            news?: unknown[]
            web?: unknown[]
            companyNews?: unknown[]
            upcomingEvents?: unknown[]
          }
          return `news ${data.news?.length ?? 0} · web ${data.web?.length ?? 0} · company ${data.companyNews?.length ?? 0} · cal ${data.upcomingEvents?.length ?? 0}`
        }
      )
    },
  },

  // ─── Precious metals deep market (XAUUSD, XAGUSD) ─────────
  {
    declaration: {
      name: 'get_metals_deep_market',
      description:
        "Deep-market intel for GOLD (XAUUSD) and SILVER (XAGUSD). Gold/silver trade OTC so there is no public L2 book - but this tool fans out to THREE free institutional-grade sources in parallel: (1) COMEX futures (GC=F / SI=F) via Yahoo for bid/ask + volume + open interest, (2) CFTC Commitments of Traders (Socrata, weekly) for COMMERCIAL vs MANAGED-MONEY positioning (the most powerful long-horizon signal for metals), (3) Goldprice.org live spot composite. Returns futures/spot basis, relative volume vs 3-month avg, COT divergence flags, and human-readable notes. Use whenever the user asks about gold/silver setups, why gold is moving, or any deep-market view of metals.",
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description:
              'XAUUSD / GOLD / XAU (gold) or XAGUSD / SILVER / XAG. Defaults to gold.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const symbol = (
        asString(args.symbol, asString(ctx.defaultSymbol, 'XAUUSD')) || 'XAUUSD'
      ).toUpperCase()
      const start = Date.now()
      const snap = await fetchMetalsDeepMarket(symbol)
      const durationMs = Date.now() - start
      if (!snap) {
        ctx.trace.push({
          tool: 'get_metals_deep_market',
          args: { symbol },
          ok: false,
          durationMs,
          error: 'all sources unavailable',
        })
        return {
          error:
            'Metals deep-market data unavailable right now. Try get_quote (OANDA:XAU_USD) + get_technical_analysis as a fallback.',
        }
      }
      const summaryParts: string[] = []
      if (snap.spot) summaryParts.push(`spot $${snap.spot.pricePerOzUsd.toFixed(2)}`)
      if (snap.futures)
        summaryParts.push(
          `${snap.futures.symbol} $${snap.futures.price.toFixed(2)} vol ${snap.futures.volume.toLocaleString()}`
        )
      if (snap.cot)
        summaryParts.push(
          `COT ${snap.cot.reportDate}: comm ${snap.cot.commercialBias}, MM ${snap.cot.managedMoneyBias}${snap.cot.divergent ? ' (DIVERGENT)' : ''}`
        )
      ctx.trace.push({
        tool: 'get_metals_deep_market',
        args: { symbol },
        ok: true,
        durationMs,
        summary: summaryParts.join(' · ') || `${snap.metal} snapshot`,
      })
      return snap
    },
  },
]

export function getToolByName(name: string): ToolDefinition | undefined {
  return (
    getMetaAgentToolByName(name) ??
    getChartMcpToolByName(name) ??
    getTradingViewMcpToolByName(name) ??
    TOOLS.find((t) => t.declaration.name === name)
  )
}

type NamedDecl = { name: string }

/** All registered agent tool names (core + chart MCP + TradingView MCP). */
export function listRegisteredToolNames(): string[] {
  const chartDecls = chartMcpToolDeclarations() as NamedDecl[]
  const tvDecls = tradingViewMcpToolDeclarations() as NamedDecl[]
  return [
    ...TOOLS.map((t) => t.declaration.name),
    ...(metaAgentToolDeclarations() as Array<{ name: string }>).map((d) => d.name),
    ...chartDecls.map((d) => d.name),
    ...tvDecls.map((d) => d.name),
  ]
}

export function toolDeclarationsForGemini(allowedNames?: string[]): unknown {
  const allow = allowedNames?.length ? new Set(allowedNames) : null
  const include = (name: string) => !allow || allow.has(name)

  type NamedDecl = { name: string }
  const chartDecls = chartMcpToolDeclarations() as NamedDecl[]
  const tvDecls = tradingViewMcpToolDeclarations() as NamedDecl[]

  const declarations = [
    ...TOOLS.map((t) => t.declaration).filter((d) => include(d.name)),
    ...(metaAgentToolDeclarations() as Array<{ name: string }>).filter((d) => include(d.name)),
    ...chartDecls.filter((d) => include(d.name)),
    ...tvDecls.filter((d) => include(d.name)),
  ]

  return [{ functionDeclarations: declarations }]
}

export function makeToolContext(opts: {
  defaultSymbol?: string
  defaultResolution?: string
  sessionKey?: string
  chartState?: import('@/lib/chart-state').ChartStateSnapshot | null
}): ToolContext {
  return {
    defaultSymbol: opts.defaultSymbol,
    defaultResolution: opts.defaultResolution,
    sessionKey: opts.sessionKey,
    chartState: opts.chartState ?? null,
    trace: [],
  }
}
