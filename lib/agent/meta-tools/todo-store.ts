/**
 * In-session todo list for multi-step agent workflows (claw-code-parity TodoWrite).
 */

import { getDataDir } from '@/lib/data-dir'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export type AgentTodoStatus = 'pending' | 'in_progress' | 'completed'

export type AgentTodoItem = {
  id: string
  content: string
  activeForm: string
  status: AgentTodoStatus
}

type TodoStore = {
  sessionKey: string
  todos: AgentTodoItem[]
  updatedAt: string
}

const memory = new Map<string, AgentTodoItem[]>()

function storePath(sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return path.join(getDataDir('agent-todos'), `${safe}.json`)
}

export async function readAgentTodos(sessionKey: string): Promise<AgentTodoItem[]> {
  const mem = memory.get(sessionKey)
  if (mem) return mem

  try {
    const raw = await fs.readFile(storePath(sessionKey), 'utf-8')
    const parsed = JSON.parse(raw) as TodoStore
    memory.set(sessionKey, parsed.todos ?? [])
    return parsed.todos ?? []
  } catch {
    return []
  }
}

export async function writeAgentTodos(
  sessionKey: string,
  todos: AgentTodoItem[]
): Promise<{ oldTodos: AgentTodoItem[]; newTodos: AgentTodoItem[] }> {
  const oldTodos = await readAgentTodos(sessionKey)

  if (todos.some((t) => !t.content.trim() || !t.activeForm.trim())) {
    throw new Error('Each todo needs content and activeForm.')
  }

  const allDone = todos.length > 0 && todos.every((t) => t.status === 'completed')
  const persisted = allDone ? [] : todos

  memory.set(sessionKey, persisted)

  const file = storePath(sessionKey)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify({ sessionKey, todos: persisted, updatedAt: new Date().toISOString() }, null, 2),
    'utf-8'
  )

  return { oldTodos, newTodos: todos }
}

export function formatTodosForPrompt(todos: AgentTodoItem[]): string {
  if (!todos.length) return 'No active todos.'
  return todos
    .map((t) => `- [${t.status}] ${t.content} (${t.activeForm})`)
    .join('\n')
}
