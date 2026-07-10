#!/usr/bin/env node
/**
 * Start the Python multi-agent engine (FastAPI on port 8765).
 *
 * If the port is already in use and /health responds, exits successfully
 * (no need to start a second instance).
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const ENGINE = path.join(ROOT, 'python', 'agent_engine')
const PYTHON_ROOT = path.join(ROOT, 'python')
const HOST = process.env.PYTHON_AGENT_HOST || '127.0.0.1'
const PORT = process.env.PYTHON_AGENT_PORT || '8765'
const BASE = `http://${HOST}:${PORT}`

function resolvePython() {
  if (process.env.PYTHON_AGENT_PYTHON?.trim()) {
    return process.env.PYTHON_AGENT_PYTHON.trim()
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

async function probeHealth() {
  try {
    const res = await fetch(`${BASE}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return false
    const data = await res.json()
    return data?.ok === true && data?.engine === 'python'
  } catch {
    return false
  }
}

const healthy = await probeHealth()
if (healthy) {
  console.log(`[python-agent] Already running at ${BASE} (health OK)`)
  process.exit(0)
}

const py = resolvePython()
const venvDir = path.join(ENGINE, '.venv')
const venvPy =
  process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python')

if (!fs.existsSync(venvPy)) {
  console.error('[python-agent] Virtualenv not found. Run: npm run python-agent:install')
  process.exit(1)
}

console.log(`[python-agent] Starting on ${BASE}`)
console.log(`[python-agent] Using ${venvPy}`)

const child = spawn(venvPy, ['-m', 'agent_engine.server'], {
  cwd: PYTHON_ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    PYTHON_AGENT_PORT: PORT,
    PYTHON_AGENT_HOST: HOST,
    PYTHONUNBUFFERED: '1',
  },
})

child.on('exit', (code) => {
  if (code !== 0) {
    console.error(
      `[python-agent] Failed to bind ${BASE}. Port may be in use by another process.`,
      process.platform === 'win32'
        ? `Try: netstat -ano | findstr :${PORT}`
        : `Try: lsof -i :${PORT}`
    )
  }
  process.exit(code ?? 0)
})

process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
