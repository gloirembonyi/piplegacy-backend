#!/usr/bin/env node
/**
 * Local HTTP bridge: browser / Next.js → TradingView MCP (stdio) → TradingView Desktop (CDP).
 *
 * Run alongside TradingView Desktop:
 *   1. Launch TV Desktop with remote debugging:
 *      "C:\Program Files\TradingView\TradingView.exe" --remote-debugging-port=9222
 *   2. npm run tv-mcp:install   (once)
 *   3. npm run tv-mcp:bridge
 *
 * Listens on http://127.0.0.1:3847 by default.
 */

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
import fs from 'node:fs'

const PORT = Number(process.env.TRADINGVIEW_MCP_BRIDGE_PORT || 3847)

function resolveServerPath() {
  const explicit = process.env.TRADINGVIEW_MCP_SERVER_PATH?.trim()
  if (explicit && fs.existsSync(explicit)) return explicit
  const candidates = [
    path.join(ROOT, '.tradingview-mcp', 'src', 'server.js'),
    path.join(ROOT, 'node_modules', 'tradingview-mcp', 'src', 'server.js'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

let mcpClient = null
let mcpLock = Promise.resolve()

async function getClient() {
  if (mcpClient) return mcpClient
  const serverPath = resolveServerPath()
  if (!serverPath) {
    throw new Error(
      'TradingView MCP server not found. Run: npm run tv-mcp:install'
    )
  }

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/stdio.js'
  )

  const command = process.env.TRADINGVIEW_MCP_COMMAND?.trim() || 'node'
  const extra = process.env.TRADINGVIEW_MCP_ARGS?.trim()
    ? process.env.TRADINGVIEW_MCP_ARGS.trim().split(/\s+/)
    : []

  const transport = new StdioClientTransport({
    command,
    args: [...extra, serverPath],
  })
  const client = new Client(
    { name: 'market-signal-bridge', version: '1.0.0' },
    { capabilities: {} }
  )
  await client.connect(transport)
  mcpClient = client
  return client
}

function withLock(fn) {
  const run = mcpLock.then(fn, fn)
  mcpLock = run.catch(() => undefined)
  return run
}

async function callTool(name, args = {}) {
  return withLock(async () => {
    const client = await getClient()
    const result = await client.callTool({ name, arguments: args })
    const texts = (result.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    try {
      return JSON.parse(texts)
    } catch {
      return { success: true, text: texts }
    }
  })
}

async function drawSetup(payload) {
  const {
    symbol,
    resolution = 'D',
    setup,
    levels = [],
    zones = [],
    referenceTime,
    clearExisting,
  } = payload

  if (
    clearExisting !== false &&
    !setup &&
    levels.length === 0 &&
    zones.length === 0
  ) {
    await callTool('draw_clear', {})
    return { ok: true, drawn: ['cleared'], errors: [] }
  }

  const syncSymbol = symbol.includes(':') ? symbol : symbol
  await callTool('chart_set_symbol', { symbol: syncSymbol })
  await callTool('chart_set_timeframe', { timeframe: resolution })

  if (clearExisting !== false) await callTool('draw_clear', {})

  const range = await callTool('chart_get_visible_range', {})
  const from = Number(range?.from ?? range?.fromTime) || Math.floor(Date.now() / 1000) - 86400 * 14
  const to = Number(range?.to ?? range?.toTime) || Math.floor(Date.now() / 1000)
  const anchorTime = referenceTime || Math.floor((from + to) / 2)

  const drawn = []
  const errors = []

  async function hline(price, label, color) {
    const r = await callTool('draw_shape', {
      shape: 'horizontal_line',
      point: { time: anchorTime, price },
      overrides: JSON.stringify({ linecolor: color, linewidth: 2, text: label }),
      text: label,
    })
    if (r?.success !== false && !r?.error) drawn.push(label)
    else errors.push(`${label}: ${r?.error || 'failed'}`)
  }

  async function rect(top, bottom, label, color) {
    const hi = Math.max(top, bottom)
    const lo = Math.min(top, bottom)
    const r = await callTool('draw_shape', {
      shape: 'rectangle',
      point: { time: from, price: hi },
      point2: { time: to, price: lo },
      overrides: JSON.stringify({ color, backgroundColor: `${color}33`, text: label }),
      text: label,
    })
    if (r?.success !== false && !r?.error) drawn.push(label)
    else errors.push(`${label}: ${r?.error || 'failed'}`)
  }

  if (setup?.triggerZone) {
    await rect(
      setup.triggerZone.top,
      setup.triggerZone.bottom,
      'Wait zone',
      '#ca8a04'
    )
  }
  if (setup?.entry) await hline(setup.entry, 'Entry', '#1A3D63')
  if (setup?.stopLoss) await hline(setup.stopLoss, 'Stop', '#dc2626')
  if (setup?.takeProfit) await hline(setup.takeProfit, 'Target', '#15803d')
  if (setup?.invalidation) await hline(setup.invalidation, 'Invalidation', '#991b1b')

  for (const z of zones.slice(0, 6)) {
    await rect(z.top, z.bottom, z.label || z.kind, '#3b82f6')
  }
  for (const l of levels.slice(0, 8)) {
    await hline(l.price, l.label || l.kind || 'Level', '#2563eb')
  }

  return { ok: drawn.length > 0 && errors.length === 0, drawn, errors }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

const server = http.createServer(async (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    try {
      const health = await callTool('tv_health_check', {})
      const ok = health?.success !== false && !health?.error
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok,
          connected: ok,
          tradingView: ok,
          health,
        })
      )
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: false,
          connected: false,
          error: err instanceof Error ? err.message : String(err),
        })
      )
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/draw-setup') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const payload = JSON.parse(body)
      const result = await drawSetup(payload)
      res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      )
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`TradingView MCP bridge → http://127.0.0.1:${PORT}`)
  console.log('Ensure TradingView Desktop is running with --remote-debugging-port=9222')
})
