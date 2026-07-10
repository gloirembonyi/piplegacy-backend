/**
 * Live smoke probes for admin Tools & Agents dashboard.
 */

import { makeToolContext, getToolByName, listRegisteredToolNames } from '@/lib/ai-tools/registry'
import { fetchQuote } from '@/lib/finnhub'
import { isTradingViewMcpServerEnabled } from '@/lib/tradingview-mcp/config'

export type ToolProbeResult = {
  ok: boolean
  latencyMs: number
  detail: string
  /** Optional integrations (e.g. TradingView Desktop) - degraded, not offline. */
  optional?: boolean
}

const PROBE_TIMEOUT_MS = 25_000
/** Network-heavy tools (candles, TA, web, multi-quote). */
const SLOW_PROBE_TIMEOUT_MS = 35_000

const SLOW_PROBE_TOOLS = new Set([
  'get_intraday_candles',
  'get_technical_analysis',
  'get_deep_market_data',
  'get_metals_deep_market',
  'get_global_market_snapshot',
  'get_volume_profile',
  'search_internet',
  'search_web',
  'search_news',
  'fetch_web_page',
  'research_catalysts',
  'get_quote',
  'get_quotes_batch',
  'run_specialist_confluence',
  'agent_load_skill',
  'agent_create_background_task',
  'agent_get_background_task',
])

/** CoinGecko free tier - rate-limited; degraded when unavailable, not offline. */
const COINGECKO_PROBE_TOOLS = new Set([
  'get_crypto_quote',
  'get_crypto_global',
  'get_crypto_movers',
  'get_crypto_fear_greed',
])

let probeCache: { at: number; map: Map<string, ToolProbeResult> } | null = null
const PROBE_CACHE_MS = 120_000

export function clearAdminToolProbeCache(): void {
  probeCache = null
}

function probeTimeoutFor(name: string): number {
  return SLOW_PROBE_TOOLS.has(name) ? SLOW_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // If the timeout wins, ignore late rejections from the underlying work.
  void promise.catch(() => {})
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Probe timed out')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function probeOk(result: unknown): boolean {
  if (result == null) return false
  if (typeof result === 'object' && 'error' in result && (result as { error?: unknown }).error) {
    return false
  }
  if (typeof result === 'object' && 'ok' in result && (result as { ok?: boolean }).ok === false) {
    return false
  }
  return true
}

function defaultArgs(tool: string): Record<string, unknown> | null {
  switch (tool) {
    case 'get_quote':
      return { symbol: 'SPY' }
    case 'get_quotes_batch':
      return { symbols: ['SPY', 'EURUSD'] }
    case 'get_technical_analysis':
      return { symbol: 'SPY' }
    case 'get_intraday_candles':
      return { symbol: 'EURUSD', resolution: '60' }
    case 'get_volume_profile':
      return { symbol: 'EURUSD', resolution: '60' }
    case 'get_company_news':
      return { symbol: 'AAPL' }
    case 'get_market_news':
      return { limit: 4 }
    case 'get_global_market_snapshot':
      return { include_crypto: false }
    case 'search_internet':
      return { query: 'forex session overlap', limit: 2 }
    case 'fetch_web_page':
      return { url: 'https://example.com' }
    case 'search_web':
      return { query: 'EURUSD outlook', limit: 2 }
    case 'search_news':
      return { query: 'Federal Reserve', limit: 2 }
    case 'get_economic_calendar':
      return { daysAhead: 5, highImpactOnly: true }
    case 'get_market_sessions':
      return {}
    case 'search_symbols':
      return { query: 'apple' }
    case 'resolve_symbol':
      return { symbol: 'EURUSD' }
    case 'get_crypto_quote':
      return { symbol: 'BTC' }
    case 'get_crypto_global':
      return {}
    case 'get_crypto_movers':
      return { limit: 5 }
    case 'get_crypto_fear_greed':
      return {}
    case 'get_orderbook_depth':
      return { symbol: 'BTCUSDT' }
    case 'chart_mcp_get_state':
      return {}
    case 'run_specialist_confluence':
      return { reason: 'admin health probe' }
    case 'get_deep_market_data':
      return { symbol: 'BTCUSD', resolution: '60' }
    case 'research_catalysts':
      return { theme: 'forex trading session timing', horizonDays: 7 }
    case 'get_metals_deep_market':
      return { symbol: 'XAUUSD' }
    case 'chart_mcp_status':
      return {}
    case 'chart_mcp_clear':
      return {}
    case 'chart_mcp_draw_setup':
      return {
        symbol: 'EURUSD',
        resolution: '60',
        bias: 'WAIT',
        entry: 1.08,
        stopLoss: 1.07,
        takeProfit: 1.09,
      }
    case 'tradingview_health_check':
      return {}
    case 'tradingview_sync_chart':
      return { symbol: 'EURUSD', resolution: '60' }
    case 'tradingview_draw_setup':
      return { symbol: 'EURUSD', resolution: '60', bias: 'WAIT', entry: 1.08 }
    case 'tradingview_clear_drawings':
      return {}
    case 'agent_todo_write':
      return {
        todos: [{ content: 'Probe health check', activeForm: 'Probing', status: 'completed' }],
      }
    case 'agent_ask_user':
      return { question: 'Which symbol should I analyze?' }
    case 'agent_search_tools':
      return { query: 'economic calendar' }
    case 'agent_load_skill':
      return { skill: 'ui-ux-pro-max' }
    case 'agent_create_background_task':
      return { kind: 'research_brief', prompt: 'forex session timing' }
    case 'agent_get_background_task':
      return null
    case 'agent_list_background_tasks':
      return {}
    default:
      return null
  }
}

export async function probeAdminTool(
  name: string,
  ctx = makeToolContext({ defaultSymbol: 'EURUSD', defaultResolution: '60' })
): Promise<ToolProbeResult> {
  const start = Date.now()

  if (name === 'agent_get_background_task') {
    try {
      const { createBackgroundTask, materializeBackgroundTask } = await import(
        '@/lib/agent/meta-tools/background-tasks'
      )
      const task = createBackgroundTask({
        kind: 'research_brief',
        prompt: 'admin health probe',
        symbols: [],
      })
      const done = await withTimeout(materializeBackgroundTask(task.id), PROBE_TIMEOUT_MS)
      return {
        ok: done?.status === 'done',
        latencyMs: Date.now() - start,
        detail: done?.status ?? 'error',
      }
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }

  if (name.startsWith('tradingview_') && !isTradingViewMcpServerEnabled()) {
    return {
      ok: true,
      latencyMs: Date.now() - start,
      detail: 'Optional - embedded chart MCP handles drawings',
      optional: true,
    }
  }

  if (name === 'get_quote') {
    try {
      const q = await withTimeout(fetchQuote('SPY'), PROBE_TIMEOUT_MS)
      return {
        ok: Boolean(q?.c),
        latencyMs: Date.now() - start,
        detail: q?.c ? `SPY ${q.c.toFixed(2)}` : 'No quote',
      }
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }

  if (name === 'run_specialist_confluence') {
    return {
      ok: true,
      latencyMs: Date.now() - start,
      detail: 'Runs inside agent turn with live grounding - smoke skipped',
      optional: true,
    }
  }

  const tool = getToolByName(name)
  if (!tool) {
    return { ok: false, latencyMs: 0, detail: 'Not registered' }
  }

  const args = defaultArgs(name)
  if (!args) {
    return { ok: true, latencyMs: 0, detail: 'No smoke args', optional: true }
  }

  try {
    const probeCtx = makeToolContext({
      defaultSymbol: ctx.defaultSymbol,
      defaultResolution: ctx.defaultResolution,
    })
    const timeoutMs = probeTimeoutFor(name)
    const result = await withTimeout(tool.execute(args, probeCtx), timeoutMs)
    const ok = probeOk(result)
    let detail = 'Smoke ok'

    if (name === 'get_market_sessions') {
      const n = (result as { activeSessions?: string[] })?.activeSessions?.length ?? 0
      detail = `${n} active sessions`
    } else if (name === 'get_economic_calendar') {
      detail = `${(result as { count?: number })?.count ?? 0} events`
    } else if (name === 'get_quotes_batch') {
      detail = `${(result as { quotes?: unknown[] })?.quotes?.length ?? 0} quotes`
    } else if (name.startsWith('search_')) {
      detail = `${(result as { count?: number })?.count ?? 0} hits`
    } else if (name === 'research_catalysts') {
      const r = result as { news?: unknown[]; web?: unknown[] }
      detail = `news ${r.news?.length ?? 0} · web ${r.web?.length ?? 0}`
    } else if (name === 'chart_mcp_status') {
      detail = 'Embedded chart MCP ready'
    } else if (name === 'chart_mcp_draw_setup') {
      detail = `${(result as { drawingCount?: number })?.drawingCount ?? 0} drawings queued`
    } else if (name === 'tradingview_health_check') {
      detail = (result as { connected?: boolean })?.connected
        ? 'TradingView Desktop connected'
        : 'TV Desktop offline - use embedded chart'
    } else if (!ok && result && typeof result === 'object' && 'error' in result) {
      detail = String((result as { error?: unknown }).error)
    } else if (name === 'get_technical_analysis') {
      const t = result as { trend?: string; rsi14?: number }
      detail = t.trend ? `${t.trend} RSI ${t.rsi14}` : 'TA computed'
    }

    if (!ok && COINGECKO_PROBE_TOOLS.has(name)) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        detail: detail.startsWith('CoinGecko') ? detail : `CoinGecko rate limit - ${detail}`,
        optional: true,
      }
    }

    return { ok, latencyMs: Date.now() - start, detail }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (COINGECKO_PROBE_TOOLS.has(name)) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        detail: detail.includes('CoinGecko') ? detail : `CoinGecko: ${detail}`,
        optional: true,
      }
    }
    return {
      ok: false,
      latencyMs: Date.now() - start,
      detail,
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0
  async function worker() {
    while (index < items.length) {
      const i = index++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

export async function probeAllAdminTools(opts?: {
  force?: boolean
}): Promise<Map<string, ToolProbeResult>> {
  if (!opts?.force && probeCache && Date.now() - probeCache.at < PROBE_CACHE_MS) {
    return probeCache.map
  }

  const names = listRegisteredToolNames()
  const ctx = makeToolContext({ defaultSymbol: 'EURUSD', defaultResolution: '60' })
  /** Low concurrency avoids Finnhub/Yahoo rate limits during full dashboard probe. */
  const settled = await mapWithConcurrency(names, 2, async (name) => {
    try {
      return { name, result: await probeAdminTool(name, ctx) }
    } catch (err) {
      return {
        name,
        result: {
          ok: false,
          latencyMs: 0,
          detail: err instanceof Error ? err.message : String(err),
        } satisfies ToolProbeResult,
      }
    }
  })
  const map = new Map<string, ToolProbeResult>()
  for (const { name, result } of settled) {
    map.set(name, result)
  }
  probeCache = { at: Date.now(), map }
  return map
}

export function resolveToolHealth(
  probe: ToolProbeResult | undefined,
  usage: { calls: number; errors: number; successRate: number | null }
): 'healthy' | 'degraded' | 'unknown' | 'offline' {
  if (probe) {
    if (probe.ok) return probe.latencyMs > 15_000 ? 'degraded' : 'healthy'
    if (probe.optional) return 'degraded'
    const timedOut = /timed out/i.test(probe.detail)
    if (timedOut && usage.calls > 0 && usage.successRate != null && usage.successRate >= 70) {
      return 'degraded'
    }
    if (timedOut && usage.calls === 0) return 'unknown'
    return 'offline'
  }
  if (usage.calls === 0) return 'unknown'
  if (usage.successRate != null && usage.successRate >= 90) return 'healthy'
  if (usage.successRate != null && usage.successRate >= 70) return 'degraded'
  if (usage.errors >= usage.calls) return 'offline'
  return 'degraded'
}

/** Core tools shown in the canary strip (fast subset). */
export const CANARY_TOOL_NAMES = [
  'get_market_sessions',
  'get_economic_calendar',
  'get_quote',
  'get_quotes_batch',
  'search_web',
  'research_catalysts',
  'get_technical_analysis',
  'chart_mcp_status',
] as const
