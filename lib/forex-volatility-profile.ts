import { FOREX_SYMBOLS } from '@/lib/finnhub'
import {
  getCurrentTimePercent,
  getLiquidityCurve,
  getVolumeLevel,
  getVolumeLevelForCurve,
  type VolumeLevel,
} from '@/lib/forex-market-hours'

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'demo'
const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1'

const PROFILE_PAIRS = [
  ...FOREX_SYMBOLS.map((f) => f.symbol),
  'OANDA:AUD_USD',
  'OANDA:USD_CAD',
]

const CACHE_TTL_MS = 60 * 60 * 1000

type CandleRow = { t: number; h: number; l: number; c: number }

type ProfileCache = {
  hourly: number[]
  fetchedAt: number
  source: 'finnhub' | 'model'
}

const profileCacheByTz = new Map<string, ProfileCache>()

async function fetchHourlyCandles(symbol: string, fromSec: number, toSec: number): Promise<CandleRow[]> {
  const url = new URL(`${FINNHUB_BASE_URL}/forex/candle`)
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('resolution', '60')
  url.searchParams.set('from', String(fromSec))
  url.searchParams.set('to', String(toSec))
  url.searchParams.set('token', FINNHUB_API_KEY)

  try {
    let res = await fetch(url.toString(), { next: { revalidate: 3600 } })
    if (!res.ok) {
      const alt = new URL(`${FINNHUB_BASE_URL}/stock/candle`)
      alt.searchParams.set('symbol', symbol)
      alt.searchParams.set('resolution', '60')
      alt.searchParams.set('from', String(fromSec))
      alt.searchParams.set('to', String(toSec))
      alt.searchParams.set('token', FINNHUB_API_KEY)
      res = await fetch(alt.toString(), { next: { revalidate: 3600 } })
    }

    if (!res.ok) return []
    const data = (await res.json()) as { s?: string; t?: number[]; h?: number[]; l?: number[]; c?: number[] }
    if (data.s !== 'ok' || !data.t?.length) return []
    return data.t.map((t, i) => ({
      t,
      h: data.h?.[i] ?? 0,
      l: data.l?.[i] ?? 0,
      c: data.c?.[i] ?? 0,
    }))
  } catch {
    return []
  }
}

function getLocalHour(timeZone: string, unixSec: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(unixSec * 1000))
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  return hour === 24 ? 0 : hour
}

function isUtcWeekend(unixSec: number): boolean {
  const d = new Date(unixSec * 1000)
  const day = d.getUTCDay()
  if (day === 6) return true
  if (day === 0 && d.getUTCHours() < 22) return true
  return false
}

function smooth(values: number[], window = 3): number[] {
  const half = Math.floor(window / 2)
  return values.map((_, i) => {
    let sum = 0
    let n = 0
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < values.length) {
        sum += values[j]
        n++
      }
    }
    return n ? sum / n : 0
  })
}

/** Spread hours by volatility rank so lows/troughs and London–NY peaks are visible. */
function rankNormalizeHourly(raw: number[]): number[] {
  const indexed = raw.map((v, i) => ({ v, i }))
  const sorted = [...indexed].sort((a, b) => a.v - b.v)
  const n = sorted.length
  if (n <= 1) return raw.map(() => 0.5)

  const rankMap = new Map<number, number>()
  sorted.forEach((item, idx) => {
    rankMap.set(item.i, n === 1 ? 0.5 : idx / (n - 1))
  })

  return raw.map((_, i) => {
    const r = rankMap.get(i) ?? 0
    return 0.06 + r * 0.94
  })
}

async function buildHourlyVolatilityProfile(timeZone: string): Promise<ProfileCache> {
  const toSec = Math.floor(Date.now() / 1000)
  const fromSec = toSec - 21 * 24 * 60 * 60

  const buckets = Array.from({ length: 24 }, () => ({ sum: 0, count: 0 }))

  const candleSets = await Promise.all(
    PROFILE_PAIRS.map((sym) => fetchHourlyCandles(sym, fromSec, toSec))
  )

  let totalCandles = 0
  for (const candles of candleSets) {
    for (const c of candles) {
      if (!c.c || c.c <= 0 || isUtcWeekend(c.t)) continue
      const rangePct = ((c.h - c.l) / c.c) * 100
      if (!Number.isFinite(rangePct) || rangePct <= 0) continue
      const hour = getLocalHour(timeZone, c.t)
      buckets[hour].sum += rangePct
      buckets[hour].count += 1
      totalCandles++
    }
  }

  if (totalCandles < 48) {
    const model = getLiquidityCurve(timeZone)
    const hourly = Array.from({ length: 24 }, (_, h) => {
      const i = Math.min(model.length - 1, Math.round((h / 24) * (model.length - 1)))
      return model[i] ?? 0
    })
    return { hourly: smooth(hourly, 3), fetchedAt: Date.now(), source: 'model' }
  }

  const raw = buckets.map((b) => (b.count ? b.sum / b.count : 0))
  const hourly = smooth(rankNormalizeHourly(raw), 2)

  return { hourly, fetchedAt: Date.now(), source: 'finnhub' }
}

function hourlyToCurve(hourly: number[]): number[] {
  const points = 96
  const curve: number[] = []
  for (let i = 0; i < points; i++) {
    const hourFloat = (i / points) * 24
    const h0 = Math.floor(hourFloat) % 24
    const h1 = (h0 + 1) % 24
    const t = hourFloat - Math.floor(hourFloat)
    curve.push(hourly[h0] * (1 - t) + hourly[h1] * t)
  }
  return smooth(curve, 3)
}

async function getCachedProfile(timeZone: string): Promise<ProfileCache> {
  const cached = profileCacheByTz.get(timeZone)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached
  }
  const profile = await buildHourlyVolatilityProfile(timeZone)
  profileCacheByTz.set(timeZone, profile)
  return profile
}

async function fetchLiveVolatilityPct(): Promise<number | null> {
  try {
    const quotes = await Promise.all(
      PROFILE_PAIRS.slice(0, 4).map(async (symbol) => {
        try {
          const url = new URL(`${FINNHUB_BASE_URL}/quote`)
          url.searchParams.set('symbol', symbol)
          url.searchParams.set('token', FINNHUB_API_KEY)
          const res = await fetch(url.toString(), { cache: 'no-store' })
          if (!res.ok) return null
          const q = (await res.json()) as { c?: number; h?: number; l?: number }
          if (!q.c || !q.h || !q.l) return null
          return ((q.h - q.l) / q.c) * 100
        } catch {
          return null
        }
      })
    )

    const valid = quotes.filter((v): v is number => v != null && v > 0)
    if (!valid.length) return null
    return valid.reduce((a, b) => a + b, 0) / valid.length
  } catch {
    return null
  }
}

export type ForexVolatilityResponse = {
  curve: number[]
  source: 'finnhub' | 'model' | 'blend'
  liveVolatilityPct: number | null
  liveLevel: VolumeLevel
  typicalLevel: VolumeLevel
  updatedAt: string
}

export async function getForexVolatilityProfile(
  timeZone: string,
  now = new Date()
): Promise<ForexVolatilityResponse> {
  const profile = await getCachedProfile(timeZone)
  const sessionCurve = getLiquidityCurve(timeZone, now)
  const dataCurve = hourlyToCurve(profile.hourly)

  const curve =
    profile.source === 'finnhub'
      ? dataCurve.map((v, i) => {
          const blended = v * 0.88 + (sessionCurve[i] ?? 0) * 0.12
          return Math.min(1, Math.max(0, blended))
        })
      : dataCurve

  const nowPct = getCurrentTimePercent(timeZone, now)
  const idx = Math.min(
    curve.length - 1,
    Math.max(0, Math.round((nowPct / 100) * (curve.length - 1)))
  )
  const typicalLevel = getVolumeLevelForCurve(curve[idx] ?? 0, curve)

  const liveVolatilityPct = await fetchLiveVolatilityPct()
  let liveLevel: VolumeLevel = typicalLevel
  if (liveVolatilityPct != null) {
    const sorted = [...curve].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0.5
    const typicalPct = median * 0.12 + 0.015
    const ratio = liveVolatilityPct / Math.max(typicalPct, 0.008)
    if (ratio < 0.7) liveLevel = 'low'
    else if (ratio < 1.25) liveLevel = 'medium'
    else liveLevel = 'high'
  }

  return {
    curve,
    source: profile.source === 'finnhub' ? 'blend' : 'model',
    liveVolatilityPct,
    liveLevel,
    typicalLevel,
    updatedAt: new Date().toISOString(),
  }
}
