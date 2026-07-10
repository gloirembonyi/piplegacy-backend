import { NextRequest } from 'next/server'
import { requireAuth, isAuthSession } from '@/lib/require-auth'
import {
  tradingViewHealthCheck,
  tradingViewMcpStatus,
} from '@/lib/tradingview-mcp/client'
import { drawOnTradingViewViaMcp } from '@/lib/tradingview-mcp/draw-setup'
import type {
  MarketChatLevel,
  MarketChatSetup,
  MarketChatZone,
} from '@/lib/parse-market-chat-json'
import { isTradingViewMcpServerEnabled } from '@/lib/tradingview-mcp/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/tradingview-mcp - MCP bridge status + health check */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const status = tradingViewMcpStatus()
  if (!status.enabled) {
    return Response.json({
      enabled: false,
      ready: false,
      hint:
        'Set TRADINGVIEW_MCP_ENABLED=true and run TradingView Desktop with --remote-debugging-port=9222. For browser drawing, run npm run tv-mcp:bridge.',
    })
  }

  const health = status.ready ? await tradingViewHealthCheck() : null

  return Response.json({
    enabled: true,
    ready: status.ready,
    serverPath: status.serverPath,
    health: health?.data ?? null,
    healthOk: health?.ok ?? false,
    error: health?.error,
  })
}

type DrawBody = {
  symbol?: string
  resolution?: string
  setup?: MarketChatSetup | null
  levels?: MarketChatLevel[]
  zones?: MarketChatZone[]
  referenceTime?: number
  clearExisting?: boolean
}

/** POST /api/tradingview-mcp - draw entry/stop/target via MCP on TradingView Desktop */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  if (!isTradingViewMcpServerEnabled()) {
    return Response.json(
      {
        ok: false,
        error:
          'Server MCP disabled. Enable TRADINGVIEW_MCP_ENABLED or use the local bridge (npm run tv-mcp:bridge).',
      },
      { status: 503 }
    )
  }

  let body: DrawBody
  try {
    body = (await req.json()) as DrawBody
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : ''
  if (!symbol) {
    return Response.json({ ok: false, error: 'symbol is required' }, { status: 400 })
  }

  const result = await drawOnTradingViewViaMcp({
    symbol,
    resolution: body.resolution,
    setup: body.setup ?? null,
    levels: body.levels ?? [],
    zones: body.zones ?? [],
    referenceTime: body.referenceTime,
    clearExisting: body.clearExisting,
  })

  return Response.json(result, { status: result.ok ? 200 : 502 })
}
