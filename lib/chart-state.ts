/**
 * Live chart canvas snapshot sent to the Market Agent each turn.
 * Keeps the agent aware of on-chart drawings (AI + user) and active setups.
 */

import type { ChartDrawing } from '@/lib/chart-drawings'

export type ChartStateSnapshot = {
  symbol: string
  resolution: string
  scope?: string
  drawings: ChartDrawing[]
  /** Derived from position drawings when present. */
  activeSetup?: {
    side: 'long' | 'short'
    entry: number
    stopLoss: number
    takeProfit: number
    pending?: boolean
    source: 'ai' | 'user' | 'mixed'
  } | null
  drawingCount: number
  userDrawingCount: number
  aiDrawingCount: number
  hasTradeSetup: boolean
}

const SCOPE_DRAWINGS_KEY = 'ms:scope-drawings'
const KEEP_DRAWINGS_KEY = 'ms:keep-chart-drawings'
const MAX_DRAWINGS = 80

type StoredScopeEntry = {
  symbol: string
  tf: string
  drawings: ChartDrawing[]
  updatedAt: string
}

type StoredScopeMap = Record<string, StoredScopeEntry>

function sanitizeDrawing(raw: unknown): ChartDrawing | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const type = d.type
  if (typeof type !== 'string') return null
  const source = d.source === 'user' ? 'user' : d.source === 'ai' ? 'ai' : undefined
  const base = {
    id: typeof d.id === 'string' ? d.id : undefined,
    source,
    locked: d.locked === true,
  }

  switch (type) {
    case 'position': {
      const entry = Number(d.entry)
      const stopLoss = Number(d.stopLoss)
      const takeProfit = Number(d.takeProfit)
      if (![entry, stopLoss, takeProfit].every(Number.isFinite)) return null
      return {
        ...base,
        type: 'position',
        side: d.side === 'short' ? 'short' : 'long',
        entry,
        stopLoss,
        takeProfit,
        pending: d.pending === true,
      }
    }
    case 'hline': {
      const price = Number(d.price)
      if (!Number.isFinite(price)) return null
      return {
        ...base,
        type: 'hline',
        price,
        label: typeof d.label === 'string' ? d.label : undefined,
        role: typeof d.role === 'string' ? (d.role as ChartDrawing & { type: 'hline' })['role'] : undefined,
      }
    }
    case 'zone': {
      const top = Number(d.top)
      const bottom = Number(d.bottom)
      if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null
      return {
        ...base,
        type: 'zone',
        top: Math.max(top, bottom),
        bottom: Math.min(top, bottom),
        kind:
          typeof d.kind === 'string'
            ? (d.kind as ChartDrawing & { type: 'zone' })['kind']
            : 'range',
        label: typeof d.label === 'string' ? d.label : undefined,
      }
    }
    case 'trendline': {
      const fromPrice = Number(d.fromPrice)
      const toPrice = Number(d.toPrice)
      if (!Number.isFinite(fromPrice) || !Number.isFinite(toPrice)) return null
      return {
        ...base,
        type: 'trendline',
        fromX: Number(d.fromX) || 0.14,
        toX: Number(d.toX) || 0.9,
        fromPrice,
        toPrice,
        role:
          d.role === 'support' || d.role === 'resistance' ? d.role : 'trend',
        label: typeof d.label === 'string' ? d.label : undefined,
        ray: d.ray === true,
      }
    }
    case 'label': {
      const price = Number(d.price)
      if (!Number.isFinite(price)) return null
      return {
        ...base,
        type: 'label',
        price,
        text: typeof d.text === 'string' ? d.text.slice(0, 120) : '',
      }
    }
    case 'fib':
    case 'arrow':
    case 'vline':
      return { ...base, ...(d as object), type } as ChartDrawing
    default:
      return null
  }
}

/** Parse client-sent chart state (size-capped). */
export function parseChartState(
  raw: unknown,
  fallbackSymbol: string,
  fallbackResolution: string
): ChartStateSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const symbol =
    typeof obj.symbol === 'string' && obj.symbol.trim()
      ? obj.symbol.trim().toUpperCase()
      : fallbackSymbol
  const resolution =
    typeof obj.resolution === 'string' && obj.resolution.trim()
      ? obj.resolution.trim()
      : fallbackResolution
  const scope =
    typeof obj.scope === 'string' && obj.scope.length <= 120
      ? obj.scope
      : undefined

  const rawDrawings = Array.isArray(obj.drawings) ? obj.drawings : []
  const drawings = rawDrawings
    .slice(0, MAX_DRAWINGS)
    .map(sanitizeDrawing)
    .filter((d): d is ChartDrawing => d != null)

  return buildChartStateSnapshot(symbol, resolution, drawings, scope)
}

export function buildChartStateSnapshot(
  symbol: string,
  resolution: string,
  drawings: ChartDrawing[],
  scope?: string
): ChartStateSnapshot {
  const userDrawingCount = drawings.filter((d) => d.source === 'user').length
  const aiDrawingCount = drawings.filter(
    (d) => d.source !== 'user'
  ).length
  const positions = drawings.filter(
    (d): d is Extract<ChartDrawing, { type: 'position' }> => d.type === 'position'
  )

  let activeSetup: ChartStateSnapshot['activeSetup'] = null
  if (positions.length > 0) {
    const p = positions[positions.length - 1]
    const sources = new Set(positions.map((x) => x.source ?? 'ai'))
    activeSetup = {
      side: p.side,
      entry: p.entry,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      pending: p.pending,
      source:
        sources.size > 1 ? 'mixed' : sources.has('user') ? 'user' : 'ai',
    }
  }

  return {
    symbol,
    resolution,
    scope,
    drawings,
    activeSetup,
    drawingCount: drawings.length,
    userDrawingCount,
    aiDrawingCount,
    hasTradeSetup: positions.length > 0,
  }
}

function formatDrawingLine(d: ChartDrawing): string {
  const src = d.source === 'user' ? 'USER' : 'AGENT'
  switch (d.type) {
    case 'position':
      return `[${src}] ${d.side.toUpperCase()} setup: entry ${d.entry}, SL ${d.stopLoss}, TP ${d.takeProfit}${d.pending ? ' (PENDING)' : ''}`
    case 'hline':
      return `[${src}] H-line ${d.price}${d.label ? ` (${d.label})` : ''}${d.role ? ` role=${d.role}` : ''}`
    case 'zone':
      return `[${src}] Zone ${d.bottom}-${d.top}${d.label ? ` (${d.label})` : ''} kind=${d.kind}`
    case 'trendline':
      return `[${src}] Trend ${d.fromPrice}→${d.toPrice}${d.label ? ` (${d.label})` : ''}${d.ray ? ' ray' : ''}`
    case 'label':
      return `[${src}] Label @ ${d.price}: ${d.text}`
    case 'fib':
      return `[${src}] Fib ${(d as Extract<ChartDrawing, { type: 'fib' }>).fromPrice}→${(d as Extract<ChartDrawing, { type: 'fib' }>).toPrice}`
    case 'arrow':
      return `[${src}] Arrow ${(d as Extract<ChartDrawing, { type: 'arrow' }>).fromPrice}→${(d as Extract<ChartDrawing, { type: 'arrow' }>).toPrice}`
    case 'vline':
      return `[${src}] V-line`
    default:
      return `[${src}] drawing`
  }
}

/** Compact block injected into the agent prompt each turn. */
export function buildChartStatePromptBlock(state: ChartStateSnapshot | null | undefined): string {
  if (!state || state.drawingCount === 0) {
    return [
      'LIVE CHART CANVAS STATE:',
      '- No drawings or trade setup visible on the chart right now.',
      '- If the user asks about hold/exit/break-even, fetch live quote + technicals and ask which setup they mean if unclear.',
    ].join('\n')
  }

  const lines = [
    'LIVE CHART CANVAS STATE (authoritative - what the user sees RIGHT NOW on their chart):',
    `- Symbol: ${state.symbol} · Timeframe: ${state.resolution}`,
    `- Drawings: ${state.drawingCount} total (${state.aiDrawingCount} agent, ${state.userDrawingCount} user hand-drawn)`,
  ]

  if (state.activeSetup) {
    const s = state.activeSetup
    lines.push(
      `- ACTIVE TRADE SETUP (${s.source}): ${s.side.toUpperCase()} entry ${s.entry}, SL ${s.stopLoss}, TP ${s.takeProfit}${s.pending ? ' [PENDING - not filled yet]' : ''}`,
      '- Questions like hold / break-even / exit / stop out MUST reference THIS setup and live price vs these levels - NOT generic finance definitions.',
      `- Break-even = move stop to entry (${s.entry}) to lock zero loss. Compare current price to entry/SL/TP before advising.`,
      '- If the user asks a FRESH "where are entry/stop/target" question (not recalling what\'s already drawn), use the specialist confluence evidence below to CONFIRM, ADJUST, or INVALIDATE these numbers - never just repeat them without checking against current analysis.'
    )
  }

  lines.push('', 'On-chart objects:')
  for (const d of state.drawings.slice(0, 40)) {
    lines.push(`  • ${formatDrawingLine(d)}`)
  }
  if (state.drawingCount > 40) {
    lines.push(`  • … +${state.drawingCount - 40} more`)
  }

  lines.push(
    '',
    'RULES:',
    '- USER drawings = trader marked manually; AGENT drawings = from prior AI setup/MCP.',
    '- Call chart_mcp_get_state if you need to re-read this snapshot mid-turn.',
    '- Do NOT invent levels that contradict the canvas state above.',
    '- For attached screenshots: cross-check visible patterns with these numeric levels.'
  )

  return lines.join('\n')
}

// ─── Per-conversation drawing persistence (localStorage) ─────────────────

function readScopeMap(): StoredScopeMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(SCOPE_DRAWINGS_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as StoredScopeMap
  } catch {
    return {}
  }
}

function writeScopeMap(map: StoredScopeMap): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SCOPE_DRAWINGS_KEY, JSON.stringify(map))
  } catch {
    /* quota / private mode */
  }
}

export function readScopeDrawings(scope: string): ChartDrawing[] | null {
  const entry = readScopeMap()[scope]
  if (!entry?.drawings?.length) return null
  return entry.drawings
    .map(sanitizeDrawing)
    .filter((d): d is ChartDrawing => d != null)
}

export function writeScopeDrawings(
  scope: string,
  symbol: string,
  tf: string,
  drawings: ChartDrawing[]
): void {
  if (!scope || typeof window === 'undefined') return
  const map = readScopeMap()
  if (drawings.length === 0) {
    delete map[scope]
  } else {
    map[scope] = {
      symbol,
      tf,
      drawings: drawings.slice(-MAX_DRAWINGS),
      updatedAt: new Date().toISOString(),
    }
  }
  writeScopeMap(map)
}

export function readKeepDrawingsPref(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(KEEP_DRAWINGS_KEY) === '1'
  } catch {
    return false
  }
}

export function writeKeepDrawingsPref(keep: boolean): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(KEEP_DRAWINGS_KEY, keep ? '1' : '0')
  } catch {
    /* ignore */
  }
}
