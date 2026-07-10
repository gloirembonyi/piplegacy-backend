import type { RawCandle } from '@/lib/candle-providers/fmp'

function avKey(): string | null {
  return (
    process.env.ALPHA_VANTAGE_API_KEY ||
    process.env.NEXT_PUBLIC_ALPHA_VANTAGE_API_KEY ||
    null
  )
}

/** Stock tickers only (no colons). */
export function toAvSymbol(symbol: string): string | null {
  const upper = symbol.trim().toUpperCase()
  if (upper.includes(':')) return null
  if (!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(upper)) return null
  return upper
}

export async function fetchAvDailyCandles(symbol: string, limit = 365): Promise<RawCandle[]> {
  const key = avKey()
  const avSymbol = toAvSymbol(symbol)
  if (!key || !avSymbol) return []

  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(avSymbol)}&outputsize=compact&apikey=${key}`

  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return []

    const data = (await res.json()) as Record<string, unknown>
    if (data.Note || data.Information) return []

    const series = data['Time Series (Daily)'] as
      | Record<string, { '1. open': string; '2. high': string; '3. low': string; '4. close': string; '5. volume': string }>
      | undefined

    if (!series) return []

    const entries = Object.entries(series)
      .slice(0, limit)
      .reverse()

    return entries.map(([date, bar]) => ({
      t: Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000),
      o: parseFloat(bar['1. open']),
      h: parseFloat(bar['2. high']),
      l: parseFloat(bar['3. low']),
      c: parseFloat(bar['4. close']),
      v: parseFloat(bar['5. volume']) || 0,
    }))
  } catch {
    return []
  }
}
