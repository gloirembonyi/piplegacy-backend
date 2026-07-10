#!/usr/bin/env node
/**
 * Clone tradesdontlie/tradingview-mcp into .tradingview-mcp/ and install deps.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const TARGET = path.join(ROOT, '.tradingview-mcp')

if (!fs.existsSync(TARGET)) {
  console.log('Cloning tradingview-mcp → .tradingview-mcp …')
  execSync(
    'git clone --depth 1 https://github.com/tradesdontlie/tradingview-mcp.git .tradingview-mcp',
    { cwd: ROOT, stdio: 'inherit' }
  )
} else {
  console.log('.tradingview-mcp already exists - pulling latest …')
  execSync('git pull --ff-only', { cwd: TARGET, stdio: 'inherit' })
}

console.log('Installing tradingview-mcp dependencies …')
execSync('npm install --legacy-peer-deps', { cwd: TARGET, stdio: 'inherit' })

const serverJs = path.join(TARGET, 'src', 'server.js')
if (!fs.existsSync(serverJs)) {
  console.error('Install failed: server.js not found at', serverJs)
  process.exit(1)
}

console.log('\n✓ TradingView MCP ready at', serverJs)
console.log('\nNext steps:')
console.log('  1. Launch TradingView Desktop with remote debugging:')
console.log('     TradingView.exe --remote-debugging-port=9222')
console.log('  2. Start the local bridge:  npm run tv-mcp:bridge')
console.log('  3. Optional server MCP: set TRADINGVIEW_MCP_ENABLED=true in .env.local')
