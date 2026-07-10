/**
 * Lazy background jobs for multi-symbol scans and deep research (claw TaskCreate pattern).
 */

import { runPipeline } from '@/lib/agent/pipeline'
import { displaySymbolLabel } from '@/lib/symbols'

export type BackgroundTaskKind = 'pipeline_scan' | 'multi_quote' | 'research_brief'

export type BackgroundTaskStatus = 'pending' | 'running' | 'done' | 'error'

export type BackgroundTask = {
  id: string
  kind: BackgroundTaskKind
  status: BackgroundTaskStatus
  prompt: string
  symbols: string[]
  createdAt: string
  updatedAt: string
  result?: Record<string, unknown>
  error?: string
}

const tasks = new Map<string, BackgroundTask>()

function newId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function createBackgroundTask(input: {
  kind: BackgroundTaskKind
  prompt: string
  symbols: string[]
}): BackgroundTask {
  const task: BackgroundTask = {
    id: newId(),
    kind: input.kind,
    status: 'pending',
    prompt: input.prompt,
    symbols: input.symbols.slice(0, 6),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  tasks.set(task.id, task)
  return task
}

export function getBackgroundTask(id: string): BackgroundTask | undefined {
  return tasks.get(id)
}

export function listBackgroundTasks(limit = 20): BackgroundTask[] {
  return [...tasks.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

async function executeTask(task: BackgroundTask): Promise<BackgroundTask> {
  task.status = 'running'
  task.updatedAt = new Date().toISOString()

  try {
    if (task.kind === 'pipeline_scan') {
      const scans = await Promise.all(
        task.symbols.map(async (symbol) => {
          const sym = symbol.toUpperCase()
          const result = await runPipeline({
            symbol: sym,
            timeframe: '1h',
            riskBudgetPct: 1,
            fast: true,
          })
          return {
            symbol: sym,
            label: displaySymbolLabel(sym),
            bias: result.setup?.bias ?? 'WAIT',
            confluence: result.setup?.confluenceScore ?? 0,
            entry: result.setup?.entry ?? null,
            stopLoss: result.setup?.stopLoss ?? null,
            takeProfit: result.setup?.takeProfit ?? null,
            headline: result.reports.map((r) => `${r.id}:${r.verdict}`).join(', '),
          }
        })
      )
      task.result = { scans, count: scans.length }
    } else if (task.kind === 'multi_quote') {
      const { fetchQuotes } = await import('@/lib/finnhub')
      const quotes = await fetchQuotes(
        task.symbols.map((s) => ({ symbol: s, label: displaySymbolLabel(s) }))
      )
      task.result = { quotes }
    } else {
      const { searchWeb, searchNews } = await import('@/lib/ai-tools/web-search')
      const [web, news] = await Promise.all([
        searchWeb(task.prompt, 6),
        searchNews(task.prompt, 6),
      ])
      task.result = { webCount: web.length, newsCount: news.length, web, news }
    }

    task.status = 'done'
  } catch (err) {
    task.status = 'error'
    task.error = err instanceof Error ? err.message : String(err)
  }

  task.updatedAt = new Date().toISOString()
  return task
}

/** Runs pending work on first poll (serverless-safe lazy execution). */
export async function materializeBackgroundTask(id: string): Promise<BackgroundTask | null> {
  const task = tasks.get(id)
  if (!task) return null
  if (task.status === 'pending') return executeTask(task)
  return task
}

export async function materializeAllPending(limit = 3): Promise<number> {
  let ran = 0
  for (const task of tasks.values()) {
    if (task.status !== 'pending') continue
    await executeTask(task)
    ran++
    if (ran >= limit) break
  }
  return ran
}
