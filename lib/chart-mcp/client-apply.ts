/**
 * Client-side helpers - apply Chart MCP tool payloads to the drawing layer.
 */

import type { ChartDrawing } from '@/lib/chart-drawings'
import type {
  MarketChatLevel,
  MarketChatSetup,
  MarketChatZone,
} from '@/lib/parse-market-chat-json'

export type ChartMcpToolPayload = {
  drawings?: unknown
  setup?: unknown
  levels?: unknown
  zones?: unknown
  cleared?: boolean
  tradingView?: boolean
}

export function parseMcpDrawings(raw: unknown): ChartDrawing[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (d): d is ChartDrawing =>
      !!d &&
      typeof d === 'object' &&
      'type' in d &&
      typeof (d as ChartDrawing).type === 'string'
  )
}

/** Apply a streamed chart_mcp_* / tradingview_draw_setup tool_result payload. */
export function applyChartMcpPayload(
  payload: ChartMcpToolPayload | undefined,
  handlers: {
    appendDrawings: (drawings: ChartDrawing[]) => void
    applyFromSetup: (
      setup: MarketChatSetup | null,
      levels?: MarketChatLevel[],
      referencePrice?: number | null,
      zones?: MarketChatZone[]
    ) => void
    clearDrawings: () => void
  },
  tool: string
): boolean {
  if (!payload) return false

  if (tool === 'chart_mcp_clear' && payload.cleared === true) {
    handlers.clearDrawings()
    return true
  }

  const drawings = parseMcpDrawings(payload.drawings)
  if (drawings.length > 0) {
    handlers.appendDrawings(drawings)
    return true
  }

  const setup =
    payload.setup && typeof payload.setup === 'object'
      ? (payload.setup as MarketChatSetup)
      : null
  const levels = Array.isArray(payload.levels)
    ? (payload.levels as MarketChatLevel[])
    : []
  const zones = Array.isArray(payload.zones)
    ? (payload.zones as MarketChatZone[])
    : []

  if (setup || levels.length > 0 || zones.length > 0) {
    const ref =
      typeof setup?.entry === 'number'
        ? setup.entry
        : typeof levels[0]?.price === 'number'
          ? levels[0].price
          : null
    handlers.applyFromSetup(setup, levels, ref, zones)
    return true
  }

  return false
}
