import fs from 'fs'
import path from 'path'

/** True when server-side MCP drawing is enabled (local / self-hosted). */
export function isTradingViewMcpServerEnabled(): boolean {
  return process.env.TRADINGVIEW_MCP_ENABLED === 'true'
}

/** URL of the local HTTP bridge (TradingView Desktop + MCP on the user's machine). */
export function getTradingViewBridgeUrl(): string {
  return (
    process.env.TRADINGVIEW_MCP_BRIDGE_URL?.trim() ||
    process.env.NEXT_PUBLIC_TRADINGVIEW_MCP_BRIDGE_URL?.trim() ||
    'http://127.0.0.1:3847'
  )
}

export function getTradingViewBridgePort(): number {
  const raw =
    process.env.TRADINGVIEW_MCP_BRIDGE_PORT ||
    process.env.NEXT_PUBLIC_TRADINGVIEW_MCP_BRIDGE_PORT ||
    '3847'
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 3847
}

export function resolveTradingViewMcpServerPath(): string | null {
  const explicit = process.env.TRADINGVIEW_MCP_SERVER_PATH?.trim()
  if (explicit && fs.existsSync(explicit)) return explicit

  const candidates = [
    path.join(process.cwd(), '.tradingview-mcp', 'src', 'server.js'),
    path.join(process.cwd(), 'node_modules', 'tradingview-mcp', 'src', 'server.js'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export function getMcpSpawnCommand(): { command: string; args: string[] } {
  const serverPath = resolveTradingViewMcpServerPath()
  if (!serverPath) {
    throw new Error(
      'TradingView MCP server not found. Run `npm run tv-mcp:install` or set TRADINGVIEW_MCP_SERVER_PATH.'
    )
  }

  const command = process.env.TRADINGVIEW_MCP_COMMAND?.trim() || 'node'
  const extraArgs = process.env.TRADINGVIEW_MCP_ARGS?.trim()
    ? process.env.TRADINGVIEW_MCP_ARGS.trim().split(/\s+/)
    : []

  return { command, args: [...extraArgs, serverPath] }
}
