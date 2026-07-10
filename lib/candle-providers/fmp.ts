const FMP_BASE = 'https://financialmodelingprep.com/stable'

export type RawCandle = {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

function fmpKey(): string | null {
  return process.env.FMP_API_KEY || process.env.NEXT_PUBLIC_FMP_API_KEY || null
}

/** Bare ticker for FMP (AAPL, XAUUSD, etc.) */
export function toFmpSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase()
  if (upper.startsWith('OANDA:')) {
    return upper.replace('OANDA:', '').replace('_', '')
  }
  if (upper.includes(':')) return upper.split(':')[1] ?? upper
  return upper
}

export async function fetchFmpDailyCandles(symbol: string, limit = 365): Promise<RawCandle[]> {
  const key = fmpKey()
  if (!key) return []

  const fmpSymbol = toFmpSymbol(symbol)
  const url = `${FMP_BASE}/historical-price-eod/full?symbol=${encodeURIComponent(fmpSymbol)}&apikey=${key}`

  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return []

    const data = (await res.json()) as
      | Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>
      | { 'Error Message'?: string }

    if (!Array.isArray(data) || data.length === 0) return []

    return data
      .slice(0, limit)
      .reverse()
      .map((bar) => ({
        t: Math.floor(new Date(bar.date + 'T00:00:00Z').getTime() / 1000),
        o: bar.open,
        h: bar.high,
        l: bar.low,
        c: bar.close,
        v: bar.volume ?? 0,
      }))
  } catch {
    return []
  }
}

export type FmpSearchHit = {
  symbol: string
  name: string
  exchange: string
}

export async function searchFmpSymbols(query: string, limit = 20): Promise<FmpSearchHit[]> {
  const key = fmpKey()
  if (!key || !query.trim()) return []

  const url = `${FMP_BASE}/search-symbol?query=${encodeURIComponent(query.trim())}&apikey=${key}`

  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return []
    const data = (await res.json()) as FmpSearchHit[]
    return Array.isArray(data) ? data.slice(0, limit) : []
  } catch {
    return []
  }
}
