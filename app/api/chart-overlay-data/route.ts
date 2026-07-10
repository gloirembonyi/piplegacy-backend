import { fetchChartOverlayCandles } from '@/lib/chart-overlay-candles'
import { mergeLiveQuoteIntoCandles } from '@/lib/chart-live-candle'
import { computeChartPriceRange, drawingPriceLevels, type ChartDrawing } from '@/lib/chart-drawings'
import { fetchQuote } from '@/lib/finnhub'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { isValidSymbol, normalizeSymbol } from '@/lib/symbols'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const { searchParams } = new URL(req.url)
  const symbol = normalizeSymbol(searchParams.get('symbol') || '')
  const resolution = searchParams.get('resolution') || 'D'

  if (!symbol || !isValidSymbol(symbol)) {
    return Response.json({ error: 'Invalid symbol' }, { status: 400 })
  }

  let drawings: ChartDrawing[] = []
  const drawingsParam = searchParams.get('drawings')
  if (drawingsParam) {
    try {
      const parsed = JSON.parse(drawingsParam) as unknown
      if (Array.isArray(parsed)) drawings = parsed as ChartDrawing[]
    } catch {
      /* ignore */
    }
  }

  const [rawCandles, quote] = await Promise.all([
    fetchChartOverlayCandles(symbol, resolution),
    fetchQuote(symbol),
  ])

  let candles = rawCandles
  if (quote?.c) {
    candles = mergeLiveQuoteIntoCandles(candles, {
      price: quote.c,
      timeSec: quote.t,
    }, resolution)
  }

  const levelPrices = drawingPriceLevels(drawings)
  if (quote?.c) levelPrices.push(quote.c, quote.h, quote.l)

  const priceRange = computeChartPriceRange(candles, levelPrices)

  const cacheHeader =
    resolution === 'D'
      ? 'private, max-age=60, stale-while-revalidate=120'
      : 'no-store, no-cache, must-revalidate'

  return Response.json(
    {
      symbol,
      resolution,
      candles: candles.slice(-300),
      quote: quote
        ? {
            price: quote.c,
            high: quote.h,
            low: quote.l,
            open: quote.o,
            change: quote.d,
            changePercent: quote.dp,
            timeSec: quote.t,
          }
        : null,
      priceRange,
    },
    { headers: { 'Cache-Control': cacheHeader } }
  )
}
