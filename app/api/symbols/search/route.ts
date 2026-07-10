import { NextResponse } from "next/server"
import { searchSymbols } from "@/lib/finnhub"
import { searchFmpSymbols } from "@/lib/candle-providers/fmp"
import {
  POPULAR_MARKETS,
  fmpHitToSymbolMeta,
  lookupSearchAliases,
  mergeSearchResults,
  rankSearchResults,
} from "@/lib/symbols"
import { isAuthSession, requireAuth } from "@/lib/require-auth"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const { searchParams } = new URL(request.url)
  const q = searchParams.get("q")?.trim() ?? ""
  const limitRaw = parseInt(searchParams.get("limit") ?? "40", 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(10, limitRaw)) : 40

  if (q.length < 1) {
    return NextResponse.json({ results: POPULAR_MARKETS, source: "popular" })
  }

  const [finnhub, fmp, aliases] = await Promise.all([
    searchSymbols(q, limit),
    searchFmpSymbols(q, limit),
    Promise.resolve(lookupSearchAliases(q)),
  ])

  const fmpMapped = fmp.map(fmpHitToSymbolMeta)
  const merged = mergeSearchResults(aliases, finnhub, fmpMapped)
  const results = rankSearchResults(q, merged)

  return NextResponse.json({
    results,
    source: results.length ? "combined" : "empty",
    query: q,
  })
}
