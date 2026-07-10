#!/usr/bin/env node
/**
 * Install Python dependencies for the agent engine into python/agent_engine/.venv
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const ENGINE = path.join(ROOT, 'python', 'agent_engine')
const venvDir = path.join(ENGINE, '.venv')

function resolvePython() {
  if (process.env.PYTHON_AGENT_PYTHON?.trim()) {
    return process.env.PYTHON_AGENT_PYTHON.trim()
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

const py = resolvePython()

console.log('[python-agent] Creating venv...')
const venv = spawnSync(py, ['-m', 'venv', venvDir], { stdio: 'inherit', cwd: ENGINE })
if (venv.status !== 0) {
  console.error('[python-agent] Failed to create venv. Is Python 3.10+ installed?')
  process.exit(1)
}

const pip =
  process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'pip.exe')
    : path.join(venvDir, 'bin', 'pip')

console.log('[python-agent] Installing requirements...')
const install = spawnSync(
  pip,
  ['install', '-r', 'requirements.txt'],
  { stdio: 'inherit', cwd: ENGINE }
)

if (install.status !== 0) {
  process.exit(1)
}

console.log('[python-agent] Done. Run: npm run python-agent:start')
