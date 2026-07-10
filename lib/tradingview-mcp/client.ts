/**
 * TradingView MCP client - talks to the open-source TradingView Desktop bridge
 * (tradesdontlie/tradingview-mcp) over stdio.
 *
 * Requires TradingView Desktop running with CDP: --remote-debugging-port=9222
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getMcpSpawnCommand,
  isTradingViewMcpServerEnabled,
  resolveTradingViewMcpServerPath,
} from '@/lib/tradingview-mcp/config'

export type McpToolResult = {
  ok: boolean
  data?: unknown
  error?: string
  rawText?: string
}

function parseToolContent(content: unknown): McpToolResult {
  if (!Array.isArray(content)) {
    return { ok: false, error: 'Empty MCP response' }
  }

  const texts = content
    .filter(
      (c): c is { type: string; text?: string } =>
        !!c && typeof c === 'object' && (c as { type?: string }).type === 'text'
    )
    .map((c) => c.text ?? '')
    .filter(Boolean)

  const rawText = texts.join('\n').trim()
  if (!rawText) return { ok: false, error: 'Empty MCP text response' }

  try {
    const data = JSON.parse(rawText) as Record<string, unknown>
    const success = data.success !== false && !data.error
    return {
      ok: success,
      data,
      error: typeof data.error === 'string' ? data.error : undefined,
      rawText,
    }
  } catch {
    return { ok: true, data: { text: rawText }, rawText }
  }
}

async function withMcpClient<T>(
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/stdio.js'
  )

  const { command, args } = getMcpSpawnCommand()
  const transport = new StdioClientTransport({ command, args })
  const client = new Client(
    { name: 'market-signal', version: '1.0.0' },
    { capabilities: {} }
  )

  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => undefined)
  }
}

export function tradingViewMcpStatus(): {
  enabled: boolean
  serverPath: string | null
  ready: boolean
} {
  const enabled = isTradingViewMcpServerEnabled()
  const serverPath = resolveTradingViewMcpServerPath()
  return { enabled, serverPath, ready: enabled && !!serverPath }
}

export async function callTradingViewMcpTool(
  name: string,
  args: Record<string, unknown> = {}
): Promise<McpToolResult> {
  if (!isTradingViewMcpServerEnabled()) {
    return { ok: false, error: 'TRADINGVIEW_MCP_ENABLED is not true' }
  }
  if (!resolveTradingViewMcpServerPath()) {
    return {
      ok: false,
      error:
        'TradingView MCP server path not found. Run npm run tv-mcp:install.',
    }
  }

  try {
    return await withMcpClient(async (client) => {
      const result = await client.callTool({ name, arguments: args })
      return parseToolContent(result.content)
    })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function tradingViewHealthCheck(): Promise<McpToolResult> {
  return callTradingViewMcpTool('tv_health_check', {})
}

export async function tradingViewSyncChart(input: {
  symbol?: string
  timeframe?: string
}): Promise<McpToolResult> {
  const steps: McpToolResult[] = []

  if (input.symbol) {
    steps.push(
      await callTradingViewMcpTool('chart_set_symbol', { symbol: input.symbol })
    )
  }
  if (input.timeframe) {
    steps.push(
      await callTradingViewMcpTool('chart_set_timeframe', {
        timeframe: input.timeframe,
      })
    )
  }

  const failed = steps.find((s) => !s.ok)
  if (failed) return failed
  return steps[steps.length - 1] ?? { ok: true, data: { synced: true } }
}
