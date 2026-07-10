/**
 * Rich UI payloads produced by agent tools - rendered in chat alongside text.
 */

import type { MarketChatLevel, MarketChatSetup, MarketChatZone } from '@/lib/parse-market-chat-json'

export type AgentArtifact =
  | {
      type: 'clarify'
      question: string
      options?: string[]
    }
  | {
      type: 'scan_results'
      title: string
      rows: Array<{
        symbol: string
        label?: string
        bias?: string
        confluence?: number
        entry?: number | null
        headline?: string
      }>
    }
  | {
      type: 'chart_drawings'
      count: number
      mode: 'embedded' | 'tradingview'
      symbol?: string
      message: string
    }
  | {
      type: 'setup_visual'
      /** SVG or PNG data URL for inline preview in chat. */
      dataUrl: string
      caption: string
    }
  | {
      type: 'todo'
      items: Array<{ content: string; status: string }>
    }
  | {
      type: 'quote_snapshot'
      quotes: Array<{ symbol: string; price?: number; changePercent?: number }>
    }
  | {
      type: 'image'
      dataUrl: string
      caption?: string
    }

export function artifactFromToolResult(
  tool: string,
  result: Record<string, unknown>
): AgentArtifact[] {
  if (!result || 'error' in result) return []

  if (tool === 'agent_ask_user' && typeof result.question === 'string') {
    const options = Array.isArray(result.options)
      ? (result.options as unknown[]).map(String).filter(Boolean)
      : undefined
    return [{ type: 'clarify', question: result.question, options }]
  }

  if (tool === 'agent_get_background_task' && result.status === 'done' && result.result) {
    const r = result.result as Record<string, unknown>
    if (Array.isArray(r.scans)) {
      return [
        {
          type: 'scan_results',
          title: 'Multi-symbol scan',
          rows: (r.scans as Array<Record<string, unknown>>).map((s) => ({
            symbol: String(s.symbol ?? ''),
            label: s.label ? String(s.label) : undefined,
            bias: s.bias ? String(s.bias) : undefined,
            confluence: typeof s.confluence === 'number' ? s.confluence : undefined,
            entry: typeof s.entry === 'number' ? s.entry : null,
            headline: s.headline ? String(s.headline) : undefined,
          })),
        },
      ]
    }
    if (Array.isArray(r.quotes)) {
      return [
        {
          type: 'quote_snapshot',
          quotes: (r.quotes as Array<Record<string, unknown>>).map((q) => ({
            symbol: String(q.symbol ?? ''),
            price: typeof q.price === 'number' ? q.price : undefined,
            changePercent: typeof q.changePercent === 'number' ? q.changePercent : undefined,
          })),
        },
      ]
    }
  }

  if (tool === 'chart_mcp_draw_setup' || tool === 'tradingview_draw_setup') {
    const count =
      typeof result.drawingCount === 'number'
        ? result.drawingCount
        : Array.isArray((result as { drawn?: unknown[] }).drawn)
          ? (result as { drawn: unknown[] }).drawn.length
          : 0
    if (count > 0) {
      return [
        {
          type: 'chart_drawings',
          count,
          mode: tool.startsWith('tradingview') ? 'tradingview' : 'embedded',
          symbol: typeof result.symbol === 'string' ? result.symbol : undefined,
          message:
            tool.startsWith('tradingview')
              ? `${count} levels drawn on TradingView Desktop`
              : `${count} levels queued on the in-app chart`,
        },
      ]
    }
  }

  if (tool === 'agent_todo_write' && Array.isArray(result.todos)) {
    return [
      {
        type: 'todo',
        items: (result.todos as Array<Record<string, unknown>>).map((t) => ({
          content: String(t.content ?? ''),
          status: String(t.status ?? 'pending'),
        })),
      },
    ]
  }

  if (tool === 'get_quotes_batch' && Array.isArray(result.quotes)) {
    return [
      {
        type: 'quote_snapshot',
        quotes: (result.quotes as Array<Record<string, unknown>>).map((q) => ({
          symbol: String(q.symbol ?? ''),
          price: typeof q.price === 'number' ? q.price : undefined,
          changePercent: typeof q.changePercent === 'number' ? q.changePercent : undefined,
        })),
      },
    ]
  }

  return []
}

/** Mini price-ladder SVG for setup preview in chat (insights mode / no chart canvas). */
export function buildSetupVisualArtifact(
  setup: MarketChatSetup | null,
  levels: MarketChatLevel[],
  symbolLabel?: string
): AgentArtifact | null {
  const prices: number[] = []
  if (setup?.entry != null) prices.push(setup.entry)
  if (setup?.stopLoss != null) prices.push(setup.stopLoss)
  if (setup?.takeProfit != null) prices.push(setup.takeProfit)
  for (const l of levels) {
    if (l.price > 0) prices.push(l.price)
  }
  if (prices.length < 2) return null

  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const pad = (max - min) * 0.12 || max * 0.002
  const lo = min - pad
  const hi = max + pad
  const w = 300
  const h = 160

  const yFor = (p: number) => 20 + ((hi - p) / (hi - lo)) * (h - 40)

  const lines: string[] = []
  const addLine = (p: number, color: string, label: string) => {
    const y = yFor(p).toFixed(1)
    lines.push(`<line x1="40" y1="${y}" x2="${w - 10}" y2="${y}" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 3"/>`)
    lines.push(`<text x="4" y="${y}" font-size="9" fill="#4A7FA7">${label} ${p.toFixed(p < 10 ? 4 : 2)}</text>`)
  }

  if (setup?.stopLoss != null) addLine(setup.stopLoss, '#dc2626', 'SL')
  if (setup?.entry != null) addLine(setup.entry, '#1A3D63', 'Entry')
  if (setup?.takeProfit != null) addLine(setup.takeProfit, '#059669', 'TP')
  for (const l of levels.slice(0, 4)) {
    addLine(l.price, '#94a3b8', l.label?.slice(0, 8) ?? 'Lvl')
  }

  const bias = setup?.bias ?? 'WAIT'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="100%" height="100%" fill="#F6FAFD" rx="8"/>
    <text x="12" y="14" font-size="10" font-weight="600" fill="#0A1931">${symbolLabel ?? 'Setup'} · ${bias}</text>
    ${lines.join('\n')}
  </svg>`

  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  return {
    type: 'setup_visual',
    dataUrl,
    caption: 'Setup level map (switch to chart view for live drawings)',
  }
}

export function mergeArtifacts(
  base: AgentArtifact[] | undefined,
  extra: AgentArtifact[]
): AgentArtifact[] {
  const out = [...(base ?? [])]
  for (const a of extra) {
    const dup =
      a.type === 'clarify'
        ? out.some((x) => x.type === 'clarify' && x.question === a.question)
        : false
    if (!dup) out.push(a)
  }
  return out.slice(0, 8)
}

export function attachCapabilitiesToResponse<
  T extends {
    setup: MarketChatSetup | null
    levels: MarketChatLevel[]
    zones: MarketChatZone[]
    artifacts?: AgentArtifact[]
    clarifyingQuestion?: string | null
    clarifyingOptions?: string[]
  },
>(response: T, toolArtifacts: AgentArtifact[], symbolLabel?: string): T {
  let artifacts = mergeArtifacts(response.artifacts, toolArtifacts)

  const clarify = artifacts.find((a) => a.type === 'clarify')

  return {
    ...response,
    artifacts,
    clarifyingQuestion: clarify?.type === 'clarify' ? clarify.question : response.clarifyingQuestion,
    clarifyingOptions:
      clarify?.type === 'clarify' ? clarify.options : response.clarifyingOptions,
  }
}
