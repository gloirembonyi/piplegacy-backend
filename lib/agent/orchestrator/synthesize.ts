/**
 * Compress sub-agent raw tool payloads into readable evidence blocks
 * for the main synthesizer LLM - avoids dumping 12k JSON blobs.
 */

import type { SubAgentBrief } from './types'

function fmtNum(n: unknown, digits = 2): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a'
  return n.toFixed(digits)
}

function formatTechnical(data: unknown): string[] {
  if (!data || typeof data !== 'object') return ['Technical analysis: unavailable']
  const t = data as Record<string, unknown>
  if (t.error) return [`Technical analysis error: ${String(t.error)}`]
  if (t.available === false) return ['Technical analysis: no daily candles']

  const lines: string[] = []
  if (t.symbol) lines.push(`Symbol: ${t.symbol}`)
  if (t.trend) lines.push(`Trend: ${t.trend}`)
  if (t.rsi14 != null) lines.push(`RSI14: ${t.rsi14}`)
  if (t.atr14 != null) lines.push(`ATR14: ${fmtNum(t.atr14, 4)}`)
  if (t.swingHigh20 != null) lines.push(`Swing high (20d): ${fmtNum(t.swingHigh20)}`)
  if (t.swingLow20 != null) lines.push(`Swing low (20d): ${fmtNum(t.swingLow20)}`)
  if (t.sma20 != null && t.sma50 != null) {
    lines.push(`SMA20/50: ${fmtNum(t.sma20, 4)} / ${fmtNum(t.sma50, 4)}`)
  }
  if (t.changePct5 != null) lines.push(`5d change: ${t.changePct5}%`)
  if (t.changePct20 != null) lines.push(`20d change: ${t.changePct20}%`)
  return lines.length ? lines : ['Technical analysis: partial data']
}

function formatIntraday(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const d = data as Record<string, unknown>
  const count = d.count ?? d.bars
  const resolution = d.resolution ?? d.interval
  if (count == null) return []
  return [`Intraday candles: ${count} bars @ ${resolution ?? '?'} resolution`]
}

function formatVolumeProfile(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const v = data as Record<string, unknown>
  if (v.pocPrice == null) return []
  const lines = [`POC: ${fmtNum(v.pocPrice)}`]
  if (v.valueAreaLow != null && v.valueAreaHigh != null) {
    lines.push(`Value area: ${fmtNum(v.valueAreaLow)} – ${fmtNum(v.valueAreaHigh)}`)
  }
  return lines
}

function formatWebResults(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const w = data as { results?: Array<{ title?: string; snippet?: string; url?: string }>; count?: number; searchProvider?: string }
  const results = w.results ?? []
  if (results.length === 0) return ['Web search: no hits']

  const provider = w.searchProvider ?? 'web'
  const lines = [`Web search (${provider}, ${results.length} hits):`]
  for (const r of results.slice(0, 5)) {
    const snippet = (r.snippet ?? '').slice(0, 180)
    lines.push(`- ${r.title ?? 'Untitled'}: ${snippet}`)
  }
  return lines
}

function formatNewsResults(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const n = data as { results?: Array<{ title?: string; source?: string }>; count?: number }
  const results = n.results ?? []
  if (results.length === 0) return []

  const lines = [`News (${results.length} headlines):`]
  for (const r of results.slice(0, 4)) {
    lines.push(`- ${r.title ?? 'Untitled'} (${r.source ?? 'news'})`)
  }
  return lines
}

function formatCalendar(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const c = data as { events?: Array<{ title?: string; date?: string; impact?: string }>; count?: number }
  const events = c.events ?? []
  if (events.length === 0 && !c.count) return []

  const lines = [`Calendar (${c.count ?? events.length} events):`]
  for (const e of events.slice(0, 4)) {
    lines.push(`- ${e.date ?? '?'} · ${e.title ?? 'Event'} (${e.impact ?? '?'})`)
  }
  return lines
}

function formatDeepMarket(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const d = data as Record<string, unknown>
  const lines: string[] = []
  const market = d.market as { marketClass?: string; label?: string } | undefined
  if (market?.label) lines.push(`Deep market (${market.label}):`)
  const vol = d.volumeAnalysis as { poc?: number; valueAreaLow?: number; valueAreaHigh?: number } | undefined
  if (vol?.poc != null) {
    lines.push(
      `  POC ${vol.poc.toFixed(2)} · VA ${vol.valueAreaLow?.toFixed(2)}–${vol.valueAreaHigh?.toFixed(2)}`
    )
  }
  const proxy = d.pendingOrdersProxy as { imbalanceLabel?: string; source?: string } | undefined
  if (proxy?.imbalanceLabel) lines.push(`  Flow: ${proxy.imbalanceLabel}`)
  const timing = d.orderTiming as { bestFillWindow?: string; priceReachEta?: { estimatedMinutes?: number } } | undefined
  if (timing?.bestFillWindow) lines.push(`  Fill window: ${timing.bestFillWindow}`)
  if (timing?.priceReachEta?.estimatedMinutes != null) {
    const method = (timing.priceReachEta as { method?: string }).method ?? 'ATR'
    lines.push(`  Price-reach ETA: ~${timing.priceReachEta.estimatedMinutes}m (${method})`)
  }
  return lines
}

function synthesizeSetupBrief(brief: SubAgentBrief): string[] {
  const { data } = brief
  return [
    `SETUP SCOUT (${brief.ok ? 'ok' : 'partial'} · ${brief.durationMs}ms)`,
    brief.summary,
    ...formatTechnical(data.technical),
    ...formatIntraday(data.intraday),
    ...formatDeepMarket(data.deepMarket),
    ...formatVolumeProfile(data.volumeProfile),
    ...(data.orderbook ? ['Order book: collected (see tool trace if needed)'] : []),
    ...(data.metalsDeep ? ['Metals deep market: collected (COT/futures basis available)'] : []),
  ]
}

function synthesizeResearchBrief(brief: SubAgentBrief): string[] {
  const { data } = brief
  const query = typeof data.query === 'string' ? data.query : ''
  return [
    `RESEARCH SCOUT (${brief.ok ? 'ok' : 'partial'} · ${brief.durationMs}ms)`,
    brief.summary,
    ...(query ? [`Query used: "${query}"`] : []),
    ...formatWebResults(data.web),
    ...formatNewsResults(data.news),
    ...(data.catalysts ? ['Catalyst bundle: collected (news + web + calendar merged)'] : []),
    ...formatTechnical(data.technical),
  ]
}

function synthesizeMacroBrief(brief: SubAgentBrief): string[] {
  const { data } = brief
  return [
    `MACRO SCOUT (${brief.ok ? 'ok' : 'partial'} · ${brief.durationMs}ms)`,
    brief.summary,
    ...formatNewsResults(data.marketNews),
    ...formatCalendar(data.calendar),
    ...(data.quotes ? ['Cross-asset quotes: SPY/DXY/XAU/BTC batch collected'] : []),
  ]
}

function synthesizeLiquidityBrief(brief: SubAgentBrief): string[] {
  const { data } = brief
  const lines = [
    `LIQUIDITY / SMART MONEY SCOUT (${brief.ok ? 'ok' : 'partial'} · ${brief.durationMs}ms)`,
    brief.summary,
  ]
  if (typeof data.timeframeNote === 'string') lines.push(`TF policy: ${data.timeframeNote}`)

  const appendTf = (label: string, block: unknown) => {
    if (!block || typeof block !== 'object') return
    const b = block as {
      resolution?: string
      bars?: number
      analysis?: {
        verdict?: string
        confidence?: number
        headline?: string
        confirmed?: Array<{ detail: string }>
        speculative?: Array<{ detail: string }>
        liquidityPools?: Array<{ detail: string }>
        blockers?: string[]
      } | null
    }
    if (b.resolution) lines.push(`\n${label} (${b.resolution}, ${b.bars ?? 0} bars):`)
    const a = b.analysis
    if (!a) {
      lines.push('  Structure: insufficient bars')
      return
    }
    lines.push(`  Bias: ${a.verdict ?? 'NEUTRAL'} · confidence ${a.confidence ?? '?'}%`)
    if (a.headline) lines.push(`  ${a.headline}`)
    if (a.confirmed?.length) {
      lines.push('  Confirmed:')
      for (const c of a.confirmed.slice(0, 3)) lines.push(`    • ${c.detail}`)
    }
    if (a.speculative?.length) {
      lines.push('  Speculative:')
      for (const s of a.speculative.slice(0, 3)) lines.push(`    • ${s.detail}`)
    }
    if (a.liquidityPools?.length) {
      lines.push('  Liquidity pools:')
      for (const p of a.liquidityPools.slice(0, 2)) lines.push(`    • ${p.detail}`)
    }
    if (a.blockers?.length) lines.push(`  Caution: ${a.blockers.join('; ')}`)
  }

  appendTf('Primary', data.primary)
  appendTf('HTF', data.htf)
  lines.push(...formatVolumeProfile(data.volumeProfile))

  const ob = data.orderbook as { imbalance?: string } | null
  if (ob?.imbalance) lines.push(`Order-book: ${ob.imbalance}`)

  const sess = data.sessions as { activeSessions?: string[]; liquidity?: string } | null
  if (sess?.activeSessions?.length) {
    lines.push(`Sessions: ${sess.activeSessions.join('+')} · ${sess.liquidity ?? ''} liquidity`)
  }

  lines.push(
    'Use confirmed sweeps/BOS/CHoCH for direction; treat FVG/OB/EQH as speculative until mitigated.'
  )
  return lines
}

const SYNTHESIZERS: Record<string, (b: SubAgentBrief) => string[]> = {
  setup: synthesizeSetupBrief,
  research: synthesizeResearchBrief,
  macro: synthesizeMacroBrief,
  liquidity: synthesizeLiquidityBrief,
}

/** Render sub-agent evidence as structured prose instead of raw JSON. */
export function renderSubAgentBriefs(briefs: SubAgentBrief[]): string {
  if (briefs.length === 0) return ''

  const blocks = briefs.map((b) => {
    const synth = SYNTHESIZERS[b.id]
    const lines = synth ? synth(b) : [b.summary, JSON.stringify(b.data).slice(0, 2000)]
    return lines.join('\n')
  })

  return [
    'SUB-AGENT EVIDENCE (pre-fetched in parallel - treat as primary facts):',
    'Use swing highs/lows, POC, liquidity sweeps, and web snippets below to anchor entry/stop/target.',
    'Cite web headlines by fact, not URL. Do NOT re-call tools already represented here unless stale.',
    '',
    ...blocks.map((block, i) => (i > 0 ? `\n---\n${block}` : block)),
  ].join('\n')
}
