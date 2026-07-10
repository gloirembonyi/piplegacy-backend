/**
 * Helpers for building in-app URLs that target the `/app` shell.
 *
 * The app shell renders a single page (`app/app/page.tsx`) that switches
 * sub-views off the `view=` query string (e.g. `?view=chart&symbol=AAPL`).
 * `buildAppHref(view, params)` produces a consistent href for that shell so
 * navigation and `router.push` calls stay in sync across the codebase.
 */

export type AppView =
  | 'overview'
  | 'ai'
  | 'trading'
  | 'systems'
  | 'markets'
  | 'explorer'
  | 'chart'
  | 'bot'
  | 'brokers'

type QueryValue = string | number | boolean | null | undefined
export type AppQueryParams = Record<string, QueryValue>

/**
 * Build a stable href into the `/app` shell for the given view.
 *
 * - Omits null/undefined/empty values so we don't emit `?symbol=`
 * - Preserves insertion order so links are deterministic
 * - Always sets `view=<view>` as the first parameter
 *
 * @example
 *   buildAppHref('chart', { symbol: 'AAPL' })           // → /app?view=chart&symbol=AAPL
 *   buildAppHref('chart', { symbol: 'AAPL', tf: '1H' }) // → /app?view=chart&symbol=AAPL&tf=1H
 *   buildAppHref('bot')                                  // → /app?view=bot
 */
export function buildAppHref(view: AppView, params: AppQueryParams = {}): string {
  const search = new URLSearchParams()
  search.set('view', view)

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    const str = String(value)
    if (str === '') continue
    search.set(key, str)
  }

  return `/app?${search.toString()}`
}

/** Parse the current `view` query param into a typed `AppView`, with fallback. */
export function readAppView(search: URLSearchParams | null): AppView {
  const raw = search?.get('view') ?? 'overview'
  const known: AppView[] = [
    'overview',
    'ai',
    'trading',
    'systems',
    'markets',
    'explorer',
    'chart',
    'bot',
    'brokers',
  ]
  return (known as string[]).includes(raw) ? (raw as AppView) : 'overview'
}
