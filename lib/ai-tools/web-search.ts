/**
 * Web + news search for the AI agent.
 *
 * Primary: Google Custom Search JSON API (when GOOGLE_CUSTOM_SEARCH_API_KEY is set).
 * Fallback: DuckDuckGo HTML scrape + Google News RSS (no API key).
 */

import { sanitizeUntrustedContent } from '@/lib/agent/orchestrator/defense'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Default CSE id from user's programmable search engine (cx=50b16243c51df457f). */
export const DEFAULT_GOOGLE_CSE_CX = '50b16243c51df457f'

export type WebSearchResult = {
  title: string
  url: string
  snippet: string
  /** `google_cse` | `duckduckgo` */
  source?: string
}

export type NewsResult = {
  title: string
  url: string
  source: string
  publishedAt: string
}

export type WebSearchMeta = {
  provider: 'google_cse' | 'duckduckgo' | 'mixed' | 'none'
  googleCseConfigured: boolean
}

export type TradingSearchIntent = 'setup' | 'research' | 'macro' | 'catalyst' | 'general'

/**
 * Build a focused web query for trading research - symbol-aware, year-stamped,
 * and tuned to the user's intent so CSE/DDG return actionable hits.
 */
export function buildTradingSearchQuery(opts: {
  message: string
  symbol?: string
  symbolLabel?: string
  intent?: TradingSearchIntent
}): string {
  const msg = opts.message.trim()
  const label = (opts.symbolLabel ?? opts.symbol ?? '').replace(/^BINANCE:|^COINBASE:/i, '')
  const year = new Date().getFullYear()
  const intent = opts.intent ?? inferSearchIntent(msg)

  if (intent === 'setup' && label) {
    return `${label} support resistance key levels technical analysis ${year}`
  }

  if (intent === 'catalyst' && label) {
    const theme = extractTheme(msg)
    return theme
      ? `${label} ${theme} catalyst ${year}`
      : `${label} upcoming catalyst outlook ${year}`
  }

  if (intent === 'macro') {
    const macro = extractMacroKeyword(msg)
    return macro
      ? `${macro} market impact forex stocks ${year}`
      : `macro market outlook ${year}`
  }

  if (intent === 'research') {
    if (/\b(price|trading at|current|live|now|today)\b/i.test(msg) && label) {
      return `${label} price today live ${year}`
    }
    if (/\b(why|benefits?|advantages?|reasons?)\b/i.test(msg) && label) {
      return `why trade ${label} benefits risks ${year}`
    }
    if (label && msg.length < 40) {
      return `${label} trading outlook analysis ${year}`
    }
  }

  if (intent === 'general') {
    let q = msg.slice(0, 160)
    if (!/\b20\d{2}\b/.test(q)) q += ` ${year}`
    if (/\b(new|latest|recent|current|today|now|just released|this week|this month)\b/i.test(msg)) {
      q += ' latest news'
    }
    return q.trim()
  }

  if (msg.length >= 12) {
    let q = msg.slice(0, 160)
    if (/\b(new|latest|recent|current|today|now)\b/i.test(msg) && !/\b20\d{2}\b/.test(q)) {
      q += ` ${year}`
    }
    return q
  }
  if (label) return `${label} market news analysis ${year}`
  return msg || `financial markets outlook ${year}`
}

/** Bias Google News RSS toward recent hits when the user asks for fresh info. */
export function buildNewsSearchQuery(query: string, message?: string): string {
  const q = query.trim()
  const msg = message?.trim() ?? ''
  const wantsFresh =
    /\b(new|latest|recent|current|today|now|breaking|this week|this month|just)\b/i.test(
      msg || q
    )
  if (wantsFresh && !/\bwhen:\d+d\b/i.test(q)) {
    return `${q} when:7d`
  }
  return q
}

function inferSearchIntent(message: string): TradingSearchIntent {
  if (/\b(entry|stop|target|setup|levels?|long|short|scalp)\b/i.test(message)) return 'setup'
  if (/\b(catalyst|thesis|narrative|outlook|forecast|analyst)\b/i.test(message)) return 'catalyst'
  if (/\b(fed|ecb|cpi|nfp|fomc|macro|usd|dxy|calendar)\b/i.test(message)) return 'macro'
  if (/\b(why|benefits?|research|explain|what are)\b/i.test(message)) return 'research'
  return 'general'
}

function extractTheme(message: string): string | null {
  const m = message.match(
    /\b(earnings|etf|halving|approval|merger|guidance|rate cut|rate hike|war|sanctions|regulation)\b/i
  )
  return m ? m[1] : null
}

function extractMacroKeyword(message: string): string | null {
  const m = message.match(
    /\b(Fed|FOMC|ECB|BOJ|CPI|NFP|PPI|GDP|PMI|DXY|yields?|tariffs?)\b/i
  )
  return m ? m[1] : null
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeDDGRedirect(href: string): string {
  try {
    if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
      const u = new URL('https:' + href)
      const real = u.searchParams.get('uddg')
      if (real) return decodeURIComponent(real)
    }
    if (href.startsWith('http')) return href
  } catch {
    /* fall through */
  }
  return href
}

export function getGoogleCseConfig(): { apiKey: string; cx: string } | null {
  const apiKey =
    process.env.GOOGLE_CUSTOM_SEARCH_API_KEY?.trim() ||
    process.env.GOOGLE_CSE_API_KEY?.trim() ||
    ''
  if (!apiKey) return null
  const cx =
    process.env.GOOGLE_CSE_CX?.trim() ||
    process.env.GOOGLE_CUSTOM_SEARCH_CX?.trim() ||
    DEFAULT_GOOGLE_CSE_CX
  return { apiKey, cx }
}

export function isGoogleCseConfigured(): boolean {
  return getGoogleCseConfig() !== null
}

/**
 * Search the entire web via Google Custom Search JSON API.
 * Requires GOOGLE_CUSTOM_SEARCH_API_KEY (+ optional GOOGLE_CSE_CX).
 */
export async function searchWebGoogleCse(
  query: string,
  limit = 5
): Promise<WebSearchResult[]> {
  const cfg = getGoogleCseConfig()
  if (!cfg || !query.trim()) return []

  const results: WebSearchResult[] = []
  let start = 1

  while (results.length < limit && start <= 11) {
    const batchSize = Math.min(10, limit - results.length)
    const url = new URL('https://www.googleapis.com/customsearch/v1')
    url.searchParams.set('key', cfg.apiKey)
    url.searchParams.set('cx', cfg.cx)
    url.searchParams.set('q', query.trim())
    url.searchParams.set('num', String(batchSize))
    url.searchParams.set('start', String(start))

    try {
      const res = await fetch(url.toString(), {
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) break
      const data = (await res.json()) as {
        items?: Array<{ title?: string; link?: string; snippet?: string }>
      }
      const items = data.items ?? []
      if (items.length === 0) break
      for (const item of items) {
        if (results.length >= limit) break
        const title = (item.title ?? '').trim()
        const link = (item.link ?? '').trim()
        if (title && link) {
          results.push({
            title,
            url: link,
            snippet: (item.snippet ?? '').trim(),
            source: 'google_cse',
          })
        }
      }
      if (items.length < batchSize) break
      start += batchSize
    } catch {
      break
    }
  }

  return results
}

/**
 * Search the open web via DuckDuckGo's HTML endpoint.
 */
export async function searchWebDuckDuckGo(
  query: string,
  limit = 5
): Promise<WebSearchResult[]> {
  if (!query.trim()) return []

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []
    const html = await res.text()

    const results: WebSearchResult[] = []
    const blockRegex =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    while ((m = blockRegex.exec(html)) && results.length < limit) {
      const href = decodeDDGRedirect(m[1])
      const title = stripHtml(m[2])
      const snippet = stripHtml(m[3])
      if (title && href) {
        results.push({ title, url: href, snippet, source: 'duckduckgo' })
      }
    }
    return results
  } catch {
    return []
  }
}

/**
 * Unified web search: Google CSE first (full web), DuckDuckGo fallback.
 * De-duplicates by URL.
 */
export async function searchWeb(
  query: string,
  limit = 5
): Promise<WebSearchResult[]> {
  if (!query.trim()) return []

  const cse = await searchWebGoogleCse(query, limit)
  if (cse.length >= limit) return cse.slice(0, limit)

  const remaining = limit - cse.length
  const ddg =
    remaining > 0 ? await searchWebDuckDuckGo(query, remaining + 2) : []

  const seen = new Set(cse.map((r) => r.url.toLowerCase()))
  const merged = [...cse]
  for (const r of ddg) {
    if (merged.length >= limit) break
    const key = r.url.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(r)
  }
  return merged
}

/** Which provider(s) contributed to a searchWeb call. */
export async function searchWebWithMeta(
  query: string,
  limit = 5
): Promise<{ results: WebSearchResult[]; meta: WebSearchMeta }> {
  const googleCseConfigured = isGoogleCseConfigured()
  const results = await searchWeb(query, limit)
  const hasCse = results.some((r) => r.source === 'google_cse')
  const hasDdg = results.some((r) => r.source === 'duckduckgo')
  const provider: WebSearchMeta['provider'] =
    hasCse && hasDdg ? 'mixed' : hasCse ? 'google_cse' : hasDdg ? 'duckduckgo' : 'none'
  return { results, meta: { provider, googleCseConfigured } }
}

/**
 * Search recent news via Google News RSS (no API key, public feed).
 */
export async function searchNews(
  query: string,
  limit = 6
): Promise<NewsResult[]> {
  if (!query.trim()) return []

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    query
  )}&hl=en-US&gl=US&ceid=US:en`

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []
    const xml = await res.text()

    const items: NewsResult[] = []
    const itemRegex = /<item>([\s\S]*?)<\/item>/g
    let m: RegExpExecArray | null
    while ((m = itemRegex.exec(xml)) && items.length < limit) {
      const block = m[1]
      const title = stripHtml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
      const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '').trim()
      const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '').trim()
      const source = stripHtml(
        block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? ''
      )
      if (title && link) {
        items.push({ title, url: link, source: source || 'Google News', publishedAt: pub })
      }
    }
    return items
  } catch {
    return []
  }
}

function isSafePublicUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (!['http:', 'https:'].includes(u.protocol)) return false
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.local') || host === '127.0.0.1') return false
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
    return true
  } catch {
    return false
  }
}

/** Fetch readable text from a public URL (internet MCP-style read). */
export async function fetchWebPageText(
  url: string,
  maxChars = 6000
): Promise<{ url: string; title: string; text: string; truncated: boolean } | null> {
  if (!isSafePublicUrl(url)) return null
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const html = await res.text()
    const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const truncated = text.length > maxChars
    if (truncated) text = text.slice(0, maxChars)
    text = sanitizeUntrustedContent(text, maxChars)
    return { url, title: sanitizeUntrustedContent(title || url, 200), text, truncated }
  } catch {
    return null
  }
}
