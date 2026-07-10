import { NextRequest, NextResponse } from "next/server"
import { fetchQuote } from "@/lib/finnhub"
import { isAuthSession, requireAuth } from "@/lib/require-auth"
import { parseSymbolList } from "@/lib/validation"
import { displaySymbolLabel } from "@/lib/symbols"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  try {
    const { searchParams } = new URL(request.url)
    const symbolsParam = searchParams.get("symbols")

    if (!symbolsParam) {
      return NextResponse.json({ error: "Symbols parameter is required" }, { status: 400 })
    }

    const symbols = parseSymbolList(symbolsParam, 20)
    if (!symbols) {
      return NextResponse.json({ error: "Invalid symbols list (max 20)" }, { status: 400 })
    }

    const data = await Promise.all(
      symbols.map(async (symbol) => {
        const q = await fetchQuote(symbol)
        const label = displaySymbolLabel(symbol)
        if (!q) {
          return {
            symbol,
            label,
            price: 0,
            change: 0,
            changePercent: 0,
            volume: 0,
            timestamp: new Date().toISOString(),
            stale: true,
          }
        }
        return {
          symbol,
          label,
          price: q.c,
          change: q.d,
          changePercent: q.dp,
          volume: 0,
          high: q.h,
          low: q.l,
          open: q.o,
          timestamp: new Date(q.t * 1000).toISOString(),
          stale: false,
        }
      })
    )

    return NextResponse.json(
      { data, timestamp: new Date().toISOString(), symbols },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    )
  } catch (error) {
    console.error("Market data API error:", error)
    return NextResponse.json({ error: "Failed to fetch market data" }, { status: 500 })
  }
}
