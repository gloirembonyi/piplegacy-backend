/** Default client-side cache TTL: 4 hours */
export const CLIENT_CACHE_TTL_MS = 4 * 60 * 60 * 1000

type CacheEntry<T> = {
  data: T
  savedAt: number
}

export const CLIENT_CACHE_KEYS = {
  marketsIndex: "ms:markets:index-cards",
  indexStrip: "ms:overview:index-strip",
  watchlistQuotes: (symbols: string) => `ms:overview:quotes:${symbols}`,
  marketBrief: "ms:overview:market-brief",
  aiSuggestions: "ms:overview:ai-suggestions",
  headlines: "ms:overview:headlines",
  upNext: (from: string, to: string) => `ms:overview:up-next:${from}:${to}`,
} as const

export function readClientCache<T>(
  key: string,
  ttlMs: number = CLIENT_CACHE_TTL_MS
): T | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry<T>
    if (!entry || typeof entry.savedAt !== "number") return null
    if (Date.now() - entry.savedAt > ttlMs) {
      localStorage.removeItem(key)
      return null
    }
    return entry.data
  } catch {
    return null
  }
}

/** Read cache even when expired - useful as fallback after a failed refresh. */
export function readClientCacheStale<T>(key: string): T | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry<T>
    return entry?.data ?? null
  } catch {
    return null
  }
}

export function writeClientCache<T>(key: string, data: T): void {
  if (typeof window === "undefined") return
  try {
    const entry: CacheEntry<T> = { data, savedAt: Date.now() }
    localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    // Quota or private mode - ignore
  }
}

export function clearClientCache(key: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export function cacheAgeMs(key: string): number | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry<unknown>
    if (!entry?.savedAt) return null
    return Date.now() - entry.savedAt
  } catch {
    return null
  }
}
