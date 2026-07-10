/**
 * Agent tools that delegate chart drawing to TradingView Desktop via MCP.
 * Only effective when TradingView Desktop + MCP bridge are running locally.
 */

import type { ToolDefinition } from '@/lib/ai-tools/types'
import { toTradingViewSymbol, tradingViewInterval } from '@/lib/symbols'
import {
  callTradingViewMcpTool,
  tradingViewHealthCheck,
  tradingViewSyncChart,
} from '@/lib/tradingview-mcp/client'
import { drawOnTradingViewViaMcp } from '@/lib/tradingview-mcp/draw-setup'
import { isTradingViewMcpServerEnabled } from '@/lib/tradingview-mcp/config'

function recordMcpToolCall(tool: string, ok: boolean) {
  void import('@/lib/tool-usage-tracker').then(({ recordToolCall }) => recordToolCall(tool, ok))
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

function asNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function mcpUnavailable() {
  return {
    ok: false,
    error:
      'TradingView MCP not available on server. User can run `npm run tv-mcp:bridge` with TradingView Desktop (--remote-debugging-port=9222). Chart overlay fallback will still apply from setup JSON.',
    fallback: 'overlay',
  }
}

export const TRADINGVIEW_MCP_TOOLS: ToolDefinition[] = [
  {
    declaration: {
      name: 'tradingview_health_check',
      description:
        'Check whether TradingView Desktop is connected via MCP (Chrome DevTools on port 9222). Call this BEFORE tradingview_draw_setup when the user asks to draw on the chart. If unavailable, still return setup JSON - the web overlay will render levels.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    execute: async (_args, ctx) => {
      const start = Date.now()
      if (!isTradingViewMcpServerEnabled()) {
        ctx.trace.push({
          tool: 'tradingview_health_check',
          args: {},
          ok: false,
          durationMs: Date.now() - start,
          error: 'MCP disabled',
          summary: 'MCP disabled - use overlay',
        })
        recordMcpToolCall('tradingview_health_check', false)
        return mcpUnavailable()
      }
      const health = await tradingViewHealthCheck()
      ctx.trace.push({
        tool: 'tradingview_health_check',
        args: {},
        ok: health.ok,
        durationMs: Date.now() - start,
        summary: health.ok ? 'TV Desktop connected' : 'TV Desktop offline',
        error: health.error,
      })
      recordMcpToolCall('tradingview_health_check', health.ok)
      return { connected: health.ok, ...((health.data as object) ?? {}), error: health.error }
    },
  },
  {
    declaration: {
      name: 'tradingview_sync_chart',
      description:
        'Sync TradingView Desktop to the same symbol and timeframe as the in-app chart via MCP. Use before drawing so lines land on the correct instrument.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description: 'Symbol (defaults to chart symbol).',
          },
          resolution: {
            type: 'STRING',
            description: 'Timeframe: 1, 5, 15, 60, D. Defaults to chart resolution.',
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, ctx.defaultSymbol ?? '')
      const resolution = asString(args.resolution, ctx.defaultResolution ?? 'D')
      const start = Date.now()
      if (!isTradingViewMcpServerEnabled()) {
        ctx.trace.push({
          tool: 'tradingview_sync_chart',
          args: { symbol, resolution },
          ok: false,
          durationMs: Date.now() - start,
          error: 'MCP disabled',
        })
        recordMcpToolCall('tradingview_sync_chart', false)
        return mcpUnavailable()
      }
      const sync = await tradingViewSyncChart({
        symbol: toTradingViewSymbol(symbol),
        timeframe: tradingViewInterval(resolution),
      })
      ctx.trace.push({
        tool: 'tradingview_sync_chart',
        args: { symbol, resolution },
        ok: sync.ok,
        durationMs: Date.now() - start,
        summary: sync.ok ? `synced ${symbol} ${resolution}` : 'sync failed',
        error: sync.error,
      })
      recordMcpToolCall('tradingview_sync_chart', sync.ok)
      return sync.data ?? { ok: sync.ok, error: sync.error }
    },
  },
  {
    declaration: {
      name: 'tradingview_draw_setup',
      description:
        'Draw entry, stop, target, trigger zones, and S/R levels on TradingView Desktop using native chart tools (MCP draw_shape). ALWAYS call when user asks for a setup with chart drawings and MCP is available. Pass exact prices from get_quote / get_technical_analysis. Also set drawIntent:true in final JSON.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING', description: 'Chart symbol.' },
          resolution: { type: 'STRING', description: 'Timeframe (1,5,15,60,D).' },
          bias: {
            type: 'STRING',
            enum: ['BUY', 'SELL', 'WAIT', 'HOLD'],
          },
          entry: { type: 'NUMBER' },
          stopLoss: { type: 'NUMBER' },
          takeProfit: { type: 'NUMBER' },
          invalidation: { type: 'NUMBER' },
          triggerZoneTop: { type: 'NUMBER' },
          triggerZoneBottom: { type: 'NUMBER' },
          levels: {
            type: 'ARRAY',
            description: 'Optional S/R levels as numbers.',
            items: { type: 'NUMBER' },
          },
          clearExisting: {
            type: 'BOOLEAN',
            description: 'Clear prior AI drawings first (default true).',
          },
        },
        required: ['symbol'],
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, ctx.defaultSymbol ?? '')
      const resolution = asString(args.resolution, ctx.defaultResolution ?? 'D')
      const start = Date.now()

      if (!isTradingViewMcpServerEnabled()) {
        ctx.trace.push({
          tool: 'tradingview_draw_setup',
          args: { symbol },
          ok: false,
          durationMs: Date.now() - start,
          error: 'MCP disabled',
          summary: 'overlay fallback',
        })
        recordMcpToolCall('tradingview_draw_setup', false)
        return mcpUnavailable()
      }

      const biasRaw = asString(args.bias, 'WAIT')
      const bias =
        biasRaw === 'BUY' || biasRaw === 'SELL' || biasRaw === 'HOLD'
          ? biasRaw
          : 'WAIT'

      const triggerTop = asNum(args.triggerZoneTop)
      const triggerBottom = asNum(args.triggerZoneBottom)

      const setup = {
        bias,
        entryType: 'limit' as const,
        entry: asNum(args.entry),
        triggerZone:
          triggerTop != null && triggerBottom != null
            ? { top: triggerTop, bottom: triggerBottom }
            : null,
        triggerCondition: '',
        validUntil: '',
        invalidation: asNum(args.invalidation),
        stopLoss: asNum(args.stopLoss),
        takeProfit: asNum(args.takeProfit),
        confidence: 0,
        timeframe: resolution,
        confirmation: '',
        risks: [],
      }

      const rawLevels = Array.isArray(args.levels) ? args.levels : []
      const levels = rawLevels
        .map((p) => asNum(p))
        .filter((p): p is number => p != null)
        .map((price) => ({ price }))

      const result = await drawOnTradingViewViaMcp({
        symbol,
        resolution,
        setup,
        levels,
        zones: [],
        clearExisting: args.clearExisting !== false,
      })

      ctx.trace.push({
        tool: 'tradingview_draw_setup',
        args: { symbol, resolution, bias },
        ok: result.ok,
        durationMs: Date.now() - start,
        summary: result.ok
          ? `drew ${result.drawn.length} on TV`
          : result.errors[0] ?? 'draw failed',
        error: result.ok ? undefined : result.errors.join('; '),
      })
      recordMcpToolCall('tradingview_draw_setup', result.ok)

      return result
    },
  },
  {
    declaration: {
      name: 'tradingview_clear_drawings',
      description:
        'Remove all drawings from the active TradingView Desktop chart via MCP. Use when user asks to clear chart annotations.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    execute: async (_args, ctx) => {
      const start = Date.now()
      if (!isTradingViewMcpServerEnabled()) {
        ctx.trace.push({
          tool: 'tradingview_clear_drawings',
          args: {},
          ok: false,
          durationMs: Date.now() - start,
          error: 'MCP disabled',
        })
        recordMcpToolCall('tradingview_clear_drawings', false)
        return mcpUnavailable()
      }
      const res = await callTradingViewMcpTool('draw_clear', {})
      ctx.trace.push({
        tool: 'tradingview_clear_drawings',
        args: {},
        ok: res.ok,
        durationMs: Date.now() - start,
        summary: res.ok ? 'cleared TV drawings' : 'clear failed',
        error: res.error,
      })
      recordMcpToolCall('tradingview_clear_drawings', res.ok)
      return res.data ?? { ok: res.ok, error: res.error }
    },
  },
]

export function tradingViewMcpToolDeclarations(): unknown[] {
  return TRADINGVIEW_MCP_TOOLS.map((t) => t.declaration)
}

export function getTradingViewMcpToolByName(name: string): ToolDefinition | undefined {
  return TRADINGVIEW_MCP_TOOLS.find((t) => t.declaration.name === name)
}
