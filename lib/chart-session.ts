import { buildAppHref } from '@/lib/app-navigation'
import { DEFAULT_WATCHLIST } from '@/lib/user-constants'
import { CHART_RESOLUTIONS } from '@/lib/symbols'
import type { UserPreferences } from '@/lib/user-types'

const STORAGE_KEY = 'market-signal:last-chart'
export const DEFAULT_CHART_TF = '60'

const VALID_TF = new Set<string>(CHART_RESOLUTIONS.map((r) => r.id))

export type ChartSession = {
  symbol: string
  tf: string
  updatedAt: string
}

export function getDefaultChartSymbol(): string {
  return DEFAULT_WATCHLIST[0]
}

function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase().slice(0, 24)
}

function normalizeTf(raw: string | null | undefined): string {
  const tf = (raw ?? '').trim()
  if (tf && VALID_TF.has(tf)) return tf
  return DEFAULT_CHART_TF
}

/** Read last chart symbol + timeframe from localStorage (persists across logout). */
export function readChartSession(): ChartSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ChartSession>
    if (!parsed?.symbol || typeof parsed.symbol !== 'string') return null
    return {
      symbol: normalizeSymbol(parsed.symbol),
      tf: normalizeTf(parsed.tf),
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

/** Persist the chart the user was viewing. */
export function writeChartSession(symbol: string, tf: string): void {
  if (typeof window === 'undefined') return
  const session: ChartSession = {
    symbol: normalizeSymbol(symbol),
    tf: normalizeTf(tf),
    updatedAt: new Date().toISOString(),
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    // private mode / quota
  }
}

type ChartPrefSource = Pick<UserPreferences, 'lastChartSymbol' | 'defaultTimeframe'>

/**
 * Resolve symbol + timeframe from URL params, local session, then server prefs.
 */
export function resolveChartParams(
  urlSymbol: string | null,
  urlTf: string | null,
  prefs?: ChartPrefSource | null
): { symbol: string; tf: string } {
  const session = readChartSession()
  const symbol = normalizeSymbol(
    urlSymbol?.trim() ||
      session?.symbol ||
      prefs?.lastChartSymbol ||
      getDefaultChartSymbol()
  )
  const tf = normalizeTf(urlTf ?? session?.tf ?? prefs?.defaultTimeframe)
  return { symbol, tf }
}

/** Build a chart href; omits symbol/tf to restore the last session. */
export function buildChartNavHref(
  symbol?: string | null,
  tf?: string | null,
  prefs?: ChartPrefSource | null
): string {
  const resolved = resolveChartParams(symbol ?? null, tf ?? null, prefs)
  return buildAppHref('chart', { symbol: resolved.symbol, tf: resolved.tf })
}

/** True when the chart URL should be normalized to the resolved session. */
export function chartUrlNeedsRestore(
  urlSymbol: string | null,
  urlTf: string | null,
  prefs?: ChartPrefSource | null
): { symbol: string; tf: string } | null {
  const resolved = resolveChartParams(urlSymbol, urlTf, prefs)
  const symOk =
    urlSymbol?.trim() &&
    normalizeSymbol(urlSymbol) === resolved.symbol
  const tfOk = urlTf?.trim() === resolved.tf
  if (symOk && tfOk) return null
  return resolved
}
