#!/usr/bin/env node
/** Remove .next cache and restart with a clean Turbopack graph (fixes missing API routes after OOM restart). */
import { rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nextDir = path.join(ROOT, '.next')

try {
  rmSync(nextDir, { recursive: true, force: true })
  console.log('[dev:clean] Removed .next cache')
} catch (err) {
  console.warn('[dev:clean] Could not remove .next:', err)
}

console.log('[dev:clean] Starting next dev…')
const child = spawn('npm', ['run', 'dev'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
})

child.on('exit', (code) => process.exit(code ?? 0))
