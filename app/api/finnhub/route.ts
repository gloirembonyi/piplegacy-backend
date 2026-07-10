import { NextResponse } from 'next/server'
import { fetchMarketCandles } from '@/lib/candle-providers'
import { isAuthSession, requireAuth } from '@/lib/require-auth'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const { searchParams } = new URL(request.url)
  const symbol = searchParams.get('symbol') || 'AAPL'
  const resolution = searchParams.get('resolution') || 'D'

  try {
    const result = await fetchMarketCandles(symbol, resolution)

    if (result.data.length === 0) {
      return NextResponse.json(
        {
          symbol,
          resolution,
          data: [],
          source: result.source,
          error:
            resolution === 'D'
              ? 'No daily chart data from data providers - use live chart embed'
              : 'Intraday data requires the live TradingView chart',
        },
        { status: 404 }
      )
    }

    return NextResponse.json(
      {
        symbol,
        resolution,
        data: result.data,
        source: result.source,
        count: result.data.length,
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      }
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message, data: [] }, { status: 500 })
  }
}
