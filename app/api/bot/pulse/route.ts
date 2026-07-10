/**
 * GET /api/bot/pulse?symbol=XAUUSD
 *
 * Returns a compact "market pulse" payload for the Chart Analysis middle
 * section:
 *  - live quote (from Yahoo)
 *  - sparkline (last 30 daily closes)
 *  - key levels (today O/H/L, 20-day H/L, ATR(14))
 *
 * Cheap and provider-agnostic - uses Yahoo Finance so it works for stocks,
 * forex, metals, and crypto without any paid API key.
 */

import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { fetchYahooCandles, fetchYahooQuote } from '@/lib/candle-providers/yahoo'
import {
  displaySymbolLabel,
  isValidSymbol,
  normalizeSymbol,
} from '@/lib/symbols'
import { computeTechnicalSummary } from '@/lib/ai-tools/technical-indicators'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const url = new URL(req.url)
  const rawSymbol = url.searchParams.get('symbol') ?? ''
  const symbol = normalizeSymbol(rawSymbol)
  if (!isValidSymbol(symbol)) {
    return Response.json({ error: 'Invalid symbol' }, { status: 400 })
  }

  const [quote, dailyBars] = await Promise.all([
    fetchYahooQuote(symbol),
    fetchYahooCandles(symbol, 'D', 30),
  ])

  const closes = dailyBars.map((b) => b.c)
  const last = dailyBars[dailyBars.length - 1]
  const last20 = dailyBars.slice(-20)

  const recentHigh = last20.length > 0 ? Math.max(...last20.map((b) => b.h)) : null
  const recentLow = last20.length > 0 ? Math.min(...last20.map((b) => b.l)) : null

  const summary = dailyBars.length >= 20 ? computeTechnicalSummary(dailyBars) : null
  const atr14 = summary?.atr14 ?? null

  return Response.json({
    symbol,
    symbolLabel: displaySymbolLabel(symbol),
    quote: quote
      ? {
          price: quote.price,
          prevClose: quote.prevClose,
          changePercent: ((quote.price - quote.prevClose) / quote.prevClose) * 100,
        }
      : null,
    spark: closes,
    levels: {
      todayOpen: last?.o ?? null,
      todayHigh: last?.h ?? null,
      todayLow: last?.l ?? null,
      recentHigh,
      recentLow,
      atr14,
    },
    source: 'yahoo',
  })
}
