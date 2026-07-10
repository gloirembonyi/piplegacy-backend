/**
 * In-app Chart MCP - agent tools that drive drawings on the embedded
 * Lightweight Charts canvas (no TradingView Desktop required).
 *
 * Tools validate prices and return structured drawing payloads; the client
 * applies them via ChartDrawingsProvider after the agent turn completes.
 */

import type { ToolDefinition } from '@/lib/ai-tools/types'
import { buildDrawingsFromChat } from '@/lib/chart-drawings'
import { buildChartStatePromptBlock } from '@/lib/chart-state'
import type { MarketChatLevel, MarketChatZone } from '@/lib/parse-market-chat-json'
import type { MarketChatSetup } from '@/lib/parse-market-chat-json'
import { roundMarketPrice } from '@/lib/format-market-price'
import { toTradingViewSymbol, tradingViewInterval } from '@/lib/symbols'

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

function asPrice(v: unknown, symbol: string): number | null {
  const n = asNum(v)
  return n != null ? roundMarketPrice(n, symbol) : null
}

function parseJsonArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const CHART_MCP_TOOLS: ToolDefinition[] = [
  {
    declaration: {
      name: 'chart_mcp_get_state',
      description:
        'Read the live chart canvas: current drawings, active trade setup (entry/SL/TP), and whether levels were drawn by the user or agent. Call FIRST when the user asks about hold, break-even, exit, or anything on their chart.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    execute: async (_args, ctx) => {
      const start = Date.now()
      const state = ctx.chartState
      const summary = state?.hasTradeSetup
        ? `${state.activeSetup?.side} setup @ ${state.activeSetup?.entry}`
        : state?.drawingCount
          ? `${state.drawingCount} drawings`
          : 'empty chart'
      ctx.trace.push({
        tool: 'chart_mcp_get_state',
        args: {},
        ok: true,
        durationMs: Date.now() - start,
        summary,
      })
      recordMcpToolCall('chart_mcp_get_state', true)
      return {
        ok: true,
        mode: 'embedded',
        symbol: state?.symbol ?? ctx.defaultSymbol ?? null,
        resolution: state?.resolution ?? ctx.defaultResolution ?? 'D',
        drawingCount: state?.drawingCount ?? 0,
        userDrawingCount: state?.userDrawingCount ?? 0,
        aiDrawingCount: state?.aiDrawingCount ?? 0,
        hasTradeSetup: state?.hasTradeSetup ?? false,
        activeSetup: state?.activeSetup ?? null,
        drawings: state?.drawings?.slice(0, 40) ?? [],
        promptBlock: buildChartStatePromptBlock(state),
      }
    },
  },
  {
    declaration: {
      name: 'chart_mcp_status',
      description:
        'Check embedded chart MCP - always available in-app. Call before chart_mcp_draw_setup when the user asks for entry/stop/target on the chart.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    execute: async (_args, ctx) => {
      const start = Date.now()
      ctx.trace.push({
        tool: 'chart_mcp_status',
        args: {},
        ok: true,
        durationMs: Date.now() - start,
        summary: 'embedded chart MCP ready',
      })
      recordMcpToolCall('chart_mcp_status', true)
      return {
        connected: true,
        mode: 'embedded',
        symbol: ctx.defaultSymbol ?? null,
        resolution: ctx.defaultResolution ?? 'D',
        message: 'Draws render on the in-app chart (Lightweight Charts).',
      }
    },
  },
  {
    declaration: {
      name: 'chart_mcp_draw_setup',
      description:
        'Queue entry, stop, target, trigger zone, S/R levels, and optional trendlines on the embedded chart. Call when the user wants a visual setup. Also set drawIntent:true in final JSON with the same prices.',
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING' },
          resolution: { type: 'STRING', description: '1, 5, 15, 60, or D' },
          bias: { type: 'STRING', enum: ['BUY', 'SELL', 'WAIT', 'HOLD'] },
          entry: { type: 'NUMBER' },
          stopLoss: { type: 'NUMBER' },
          takeProfit: { type: 'NUMBER' },
          invalidation: { type: 'NUMBER' },
          triggerZoneTop: { type: 'NUMBER' },
          triggerZoneBottom: { type: 'NUMBER' },
          levels: {
            type: 'ARRAY',
            items: { type: 'NUMBER' },
            description: 'Optional extra S/R levels as numbers',
          },
          levelsJson: {
            type: 'STRING',
            description:
              'Optional JSON array of labeled levels: [{price,label?,kind?}] where kind is support/resistance/pivot/entry/target/liquidity.',
          },
          zonesJson: {
            type: 'STRING',
            description:
              'Optional JSON array of price zones: [{top,bottom,kind,label?}] where kind is fvg/orderBlock/supply/demand/range/liquidity.',
          },
          trendLinesJson: {
            type: 'STRING',
            description:
              'Optional JSON array of trend lines: [{fromPrice,toPrice,label?,role?,ray?}]',
          },
        },
        required: ['symbol'],
      },
    },
    execute: async (args, ctx) => {
      const symbol = asString(args.symbol, ctx.defaultSymbol ?? '')
      const resolution = asString(args.resolution, ctx.defaultResolution ?? 'D')
      const start = Date.now()

      const biasRaw = asString(args.bias, 'WAIT')
      const bias =
        biasRaw === 'BUY' || biasRaw === 'SELL' || biasRaw === 'HOLD'
          ? biasRaw
          : 'WAIT'

      const triggerTop = asPrice(args.triggerZoneTop, symbol)
      const triggerBottom = asPrice(args.triggerZoneBottom, symbol)

      const setup: MarketChatSetup = {
        bias,
        entryType: 'limit',
        entry: asPrice(args.entry, symbol),
        triggerZone:
          triggerTop != null && triggerBottom != null
            ? { top: triggerTop, bottom: triggerBottom }
            : null,
        triggerCondition: '',
        validUntil: '',
        invalidation: asPrice(args.invalidation, symbol),
        stopLoss: asPrice(args.stopLoss, symbol),
        takeProfit: asPrice(args.takeProfit, symbol),
        confidence: 0,
        timeframe: resolution,
        confirmation: '',
        risks: [],
      }

      const rawLevels = Array.isArray(args.levels) ? args.levels : []
      const numericLevels = rawLevels
        .map((p) => asPrice(p, symbol))
        .filter((p): p is number => p != null)
        .map((price) => ({ price }))

      const labeledLevels: MarketChatLevel[] = parseJsonArray(args.levelsJson)
        .map((item): MarketChatLevel | null => {
          if (!item || typeof item !== 'object') return null
          const obj = item as Record<string, unknown>
          const price = asPrice(obj.price, symbol)
          if (price == null) return null
          const kindRaw = asString(obj.kind)
          const kind =
            kindRaw === 'support' ||
            kindRaw === 'resistance' ||
            kindRaw === 'pivot' ||
            kindRaw === 'entry' ||
            kindRaw === 'target' ||
            kindRaw === 'liquidity'
              ? kindRaw
              : undefined
          return { price, label: asString(obj.label) || undefined, kind }
        })
        .filter((l): l is MarketChatLevel => l != null)

      const levels = [...labeledLevels, ...numericLevels]

      const zones: MarketChatZone[] = parseJsonArray(args.zonesJson)
        .map((item): MarketChatZone | null => {
          if (!item || typeof item !== 'object') return null
          const obj = item as Record<string, unknown>
          const top = asPrice(obj.top, symbol)
          const bottom = asPrice(obj.bottom, symbol)
          if (top == null || bottom == null || top === bottom) return null
          const kindRaw = asString(obj.kind)
          const kind =
            kindRaw === 'fvg' ||
            kindRaw === 'orderBlock' ||
            kindRaw === 'supply' ||
            kindRaw === 'demand' ||
            kindRaw === 'range' ||
            kindRaw === 'liquidity'
              ? kindRaw
              : 'range'
          return {
            top: Math.max(top, bottom),
            bottom: Math.min(top, bottom),
            kind,
            label: asString(obj.label) || undefined,
          }
        })
        .filter((z): z is MarketChatZone => z != null)

      const drawings = buildDrawingsFromChat(setup, levels, setup.entry, zones, symbol)
      const trendLines = parseJsonArray(args.trendLinesJson)
      for (const t of trendLines.slice(0, 4)) {
        if (!t || typeof t !== 'object') continue
        const obj = t as Record<string, unknown>
        const fromPrice = asPrice(obj.fromPrice, symbol)
        const toPrice = asPrice(obj.toPrice, symbol)
        if (fromPrice == null || toPrice == null) continue
        const roleRaw = asString(obj.role, 'trend')
        const role =
          roleRaw === 'support' || roleRaw === 'resistance' ? roleRaw : 'trend'
        drawings.push({
          type: 'trendline',
          fromX: 0.14,
          toX: 0.9,
          fromPrice,
          toPrice,
          role,
          ray: obj.ray === true,
          label: asString(obj.label, role === 'trend' ? 'Trend line' : `${role} trend`),
        })
      }

      ctx.trace.push({
        tool: 'chart_mcp_draw_setup',
        args: { symbol, resolution, bias },
        ok: drawings.length > 0,
        durationMs: Date.now() - start,
        summary:
          drawings.length > 0
            ? `${drawings.length} levels queued on chart`
            : 'no drawable levels',
      })
      recordMcpToolCall('chart_mcp_draw_setup', drawings.length > 0)

      return {
        ok: drawings.length > 0,
        mode: 'embedded',
        symbol: toTradingViewSymbol(symbol),
        timeframe: tradingViewInterval(resolution),
        setup,
        levels,
        drawingCount: drawings.length,
        drawings,
      }
    },
  },
  {
    declaration: {
      name: 'chart_mcp_clear',
      description: 'Clear all AI drawings from the embedded chart.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    execute: async (_args, ctx) => {
      const start = Date.now()
      ctx.trace.push({
        tool: 'chart_mcp_clear',
        args: {},
        ok: true,
        durationMs: Date.now() - start,
        summary: 'clear queued',
      })
      recordMcpToolCall('chart_mcp_clear', true)
      return { ok: true, mode: 'embedded', cleared: true }
    },
  },
]

export function chartMcpToolDeclarations() {
  return CHART_MCP_TOOLS.map((t) => t.declaration)
}

export function getChartMcpToolByName(name: string): ToolDefinition | undefined {
  return CHART_MCP_TOOLS.find((t) => t.declaration.name === name)
}
