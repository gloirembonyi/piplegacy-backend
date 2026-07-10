/**
 * Map Piplegacy setup / levels / zones → TradingView MCP draw_shape calls.
 */

import type {
  MarketChatLevel,
  MarketChatSetup,
  MarketChatZone,
} from '@/lib/parse-market-chat-json'
import { toTradingViewSymbol, tradingViewInterval } from '@/lib/symbols'
import {
  callTradingViewMcpTool,
  tradingViewSyncChart,
  type McpToolResult,
} from '@/lib/tradingview-mcp/client'

export type DrawOnTradingViewInput = {
  symbol: string
  resolution?: string
  setup?: MarketChatSetup | null
  levels?: MarketChatLevel[]
  zones?: MarketChatZone[]
  /** Unix seconds - anchor drawings on the chart timeline. */
  referenceTime?: number
  clearExisting?: boolean
}

export type DrawOnTradingViewResult = {
  ok: boolean
  mode: 'mcp'
  drawn: string[]
  errors: string[]
  sync?: McpToolResult
}

const COLORS = {
  entry: '#1A3D63',
  stop: '#dc2626',
  target: '#15803d',
  invalidation: '#991b1b',
  support: '#16a34a',
  resistance: '#dc2626',
  trigger: '#ca8a04',
  zone: '#3b82f6',
} as const

async function getVisibleTimeRange(): Promise<{ from: number; to: number }> {
  const range = await callTradingViewMcpTool('chart_get_visible_range', {})
  if (range.ok && range.data && typeof range.data === 'object') {
    const d = range.data as Record<string, unknown>
    const from = Number(d.from ?? d.fromTime ?? d.start)
    const to = Number(d.to ?? d.toTime ?? d.end)
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      return { from, to }
    }
  }
  const now = Math.floor(Date.now() / 1000)
  return { from: now - 86400 * 14, to: now }
}

async function drawHorizontal(
  price: number,
  label: string,
  color: string,
  time: number,
  drawn: string[],
  errors: string[]
) {
  const res = await callTradingViewMcpTool('draw_shape', {
    shape: 'horizontal_line',
    point: { time, price },
    overrides: JSON.stringify({ linecolor: color, linewidth: 2, text: label }),
    text: label,
  })
  if (res.ok) drawn.push(label)
  else errors.push(`${label}: ${res.error ?? 'draw failed'}`)
}

async function drawZoneRect(
  top: number,
  bottom: number,
  label: string,
  color: string,
  from: number,
  to: number,
  drawn: string[],
  errors: string[]
) {
  const hi = Math.max(top, bottom)
  const lo = Math.min(top, bottom)
  const res = await callTradingViewMcpTool('draw_shape', {
    shape: 'rectangle',
    point: { time: from, price: hi },
    point2: { time: to, price: lo },
    overrides: JSON.stringify({
      color,
      backgroundColor: `${color}33`,
      linewidth: 1,
      text: label,
    }),
    text: label,
  })
  if (res.ok) drawn.push(label)
  else errors.push(`${label}: ${res.error ?? 'draw failed'}`)
}

export async function drawOnTradingViewViaMcp(
  input: DrawOnTradingViewInput
): Promise<DrawOnTradingViewResult> {
  const drawn: string[] = []
  const errors: string[] = []

  const tvSymbol = toTradingViewSymbol(input.symbol)
  const timeframe = tradingViewInterval(input.resolution ?? 'D')

  const sync = await tradingViewSyncChart({
    symbol: tvSymbol,
    timeframe,
  })
  if (!sync.ok) {
    return { ok: false, mode: 'mcp', drawn, errors: [sync.error ?? 'sync failed'], sync }
  }

  if (input.clearExisting !== false) {
    const cleared = await callTradingViewMcpTool('draw_clear', {})
    if (!cleared.ok) errors.push(`clear: ${cleared.error ?? 'failed'}`)
  }

  const { from, to } = await getVisibleTimeRange()
  const anchorTime =
    input.referenceTime && input.referenceTime > 0
      ? input.referenceTime
      : Math.floor((from + to) / 2)

  const setup = input.setup
  if (setup?.triggerZone) {
    await drawZoneRect(
      setup.triggerZone.top,
      setup.triggerZone.bottom,
      setup.bias === 'WAIT' ? 'Wait zone' : 'Trigger zone',
      COLORS.trigger,
      from,
      to,
      drawn,
      errors
    )
  }

  if (setup?.entry != null && setup.entry > 0) {
    await drawHorizontal(
      setup.entry,
      setup.entryType === 'limit' ? 'Limit entry' : 'Entry',
      COLORS.entry,
      anchorTime,
      drawn,
      errors
    )
  }
  if (setup?.stopLoss != null && setup.stopLoss > 0) {
    await drawHorizontal(
      setup.stopLoss,
      'Stop',
      COLORS.stop,
      anchorTime,
      drawn,
      errors
    )
  }
  if (setup?.takeProfit != null && setup.takeProfit > 0) {
    await drawHorizontal(
      setup.takeProfit,
      'Target',
      COLORS.target,
      anchorTime,
      drawn,
      errors
    )
  }
  if (setup?.invalidation != null && setup.invalidation > 0) {
    await drawHorizontal(
      setup.invalidation,
      'Invalidation',
      COLORS.invalidation,
      anchorTime,
      drawn,
      errors
    )
  }

  for (const zone of (input.zones ?? []).slice(0, 6)) {
    await drawZoneRect(
      zone.top,
      zone.bottom,
      zone.label ?? zone.kind.toUpperCase(),
      COLORS.zone,
      from,
      to,
      drawn,
      errors
    )
  }

  for (const level of (input.levels ?? []).slice(0, 8)) {
    const kind = level.kind ?? 'neutral'
    const color =
      kind === 'support'
        ? COLORS.support
        : kind === 'resistance'
          ? COLORS.resistance
          : kind === 'target'
            ? COLORS.target
            : kind === 'entry'
              ? COLORS.entry
              : '#2563eb'
    await drawHorizontal(
      level.price,
      level.label ?? kind,
      color,
      anchorTime,
      drawn,
      errors
    )
  }

  return {
    ok: drawn.length > 0 && errors.length === 0,
    mode: 'mcp',
    drawn,
    errors,
    sync,
  }
}
