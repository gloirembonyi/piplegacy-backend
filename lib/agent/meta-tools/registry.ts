/**
 * Agent meta-tools - harness capabilities ported from claw-code-parity:
 * todos, clarifying questions, skill loading, tool discovery, background jobs.
 */

import type { ToolDefinition } from '@/lib/ai-tools/types'
import {
  createBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  materializeBackgroundTask,
} from '@/lib/agent/meta-tools/background-tasks'
import { loadAgentSkill, listAvailableSkills } from '@/lib/agent/meta-tools/skill-loader'
import { readAgentTodos, writeAgentTodos, type AgentTodoItem } from '@/lib/agent/meta-tools/todo-store'
import { describeAllTools, searchAgentTools } from '@/lib/agent/meta-tools/tool-search'
import { RUN_SPECIALIST_CONFLUENCE_TOOL } from '@/lib/agent/meta-tools/specialist-pipeline-tool'

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

function sessionKey(ctx: { sessionKey?: string; defaultSymbol?: string }): string {
  return ctx.sessionKey ?? ctx.defaultSymbol ?? 'default'
}

function pushTrace(
  ctx: { trace: { tool: string; args: Record<string, unknown>; ok: boolean; durationMs: number; summary?: string; error?: string }[] },
  tool: string,
  args: Record<string, unknown>,
  ok: boolean,
  start: number,
  summary: string,
  error?: string
) {
  ctx.trace.push({ tool, args, ok, durationMs: Date.now() - start, summary, error })
  void import('@/lib/tool-usage-tracker').then(({ recordToolCall }) => recordToolCall(tool, ok))
}

export const META_AGENT_TOOLS: ToolDefinition[] = [
  {
    declaration: {
      name: 'agent_todo_write',
      description:
        'Update the in-session task list for multi-step analysis. Use for complex requests: research → structure → setup → verify. Mark items completed as you finish them.',
      parameters: {
        type: 'OBJECT',
        properties: {
          todos: {
            type: 'ARRAY',
            description: 'Full todo list replacing the previous one.',
            items: { type: 'STRING' },
          },
        },
        required: ['todos'],
      },
    },
    execute: async (args, ctx) => {
      const start = Date.now()
      const raw = Array.isArray(args.todos) ? args.todos : []
      const todos: AgentTodoItem[] = raw
        .map((item, i) => {
          if (typeof item === 'string') {
            return {
              id: `todo_${i + 1}`,
              content: item,
              activeForm: item,
              status: 'pending' as const,
            }
          }
          if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>
            const status = asString(o.status, 'pending') as AgentTodoItem['status']
            return {
              id: asString(o.id, `todo_${i + 1}`),
              content: asString(o.content),
              activeForm: asString(o.activeForm, asString(o.content)),
              status:
                status === 'completed' || status === 'in_progress' ? status : 'pending',
            }
          }
          return null
        })
        .filter((t): t is AgentTodoItem => t != null && Boolean(t.content.trim()))

      try {
        const { newTodos } = await writeAgentTodos(sessionKey(ctx), todos)
        pushTrace(ctx, 'agent_todo_write', { count: newTodos.length }, true, start, `${newTodos.length} todos`)
        return { ok: true, todos: newTodos }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        pushTrace(ctx, 'agent_todo_write', args, false, start, msg, msg)
        return { error: msg }
      }
    },
  },
  {
    declaration: {
      name: 'agent_ask_user',
      description:
        'Ask the user ONE clarifying question when the request is ambiguous (missing symbol, timeframe, risk tolerance, long vs short). Include 2–4 short options when helpful.',
      parameters: {
        type: 'OBJECT',
        properties: {
          question: { type: 'STRING', description: 'Clear question for the user.' },
          options: {
            type: 'ARRAY',
            description: 'Optional multiple-choice options.',
            items: { type: 'STRING' },
          },
        },
        required: ['question'],
      },
    },
    execute: async (args, ctx) => {
      const start = Date.now()
      const question = asString(args.question)
      if (!question) return { error: 'question is required' }
      const options = Array.isArray(args.options)
        ? (args.options as unknown[]).map((o) => asString(o)).filter(Boolean).slice(0, 6)
        : []

      pushTrace(ctx, 'agent_ask_user', { question }, true, start, question.slice(0, 80))
      return {
        status: 'pending',
        question,
        options: options.length ? options : undefined,
        message: 'Include this question in your final reply and wait for the user answer.',
      }
    },
  },
  {
    declaration: {
      name: 'agent_search_tools',
      description:
        'Search the full tool catalog when you need a capability not in your current allowlist. Returns matching tool names - request them via your plan or call directly if allowed.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'What you need, e.g. "crypto fear greed", "draw chart", "economic calendar".' },
          maxResults: { type: 'NUMBER', description: 'Max hits (default 8).' },
        },
        required: ['query'],
      },
    },
    execute: async (args, ctx) => {
      const start = Date.now()
      const query = asString(args.query)
      const maxResults =
        typeof args.maxResults === 'number' && args.maxResults > 0
          ? Math.min(15, Math.trunc(args.maxResults))
          : 8
      const matches = searchAgentTools(query, maxResults)
      pushTrace(ctx, 'agent_search_tools', { query }, true, start, `${matches.length} matches`)
      return {
        query,
        matches,
        totalTools: describeAllTools().length,
      }
    },
  },
  {
    declaration: {
      name: 'agent_load_skill',
      description:
        'Load a SKILL.md instruction pack (e.g. ui-ux-pro-max, canvas) into context before specialized work.',
      parameters: {
        type: 'OBJECT',
        properties: {
          skill: { type: 'STRING', description: 'Skill folder name under .cursor/skills/' },
        },
        required: ['skill'],
      },
    },
    execute: async (args, ctx) => {
      const start = Date.now()
      const skill = asString(args.skill)
      try {
        const loaded = await loadAgentSkill(skill)
        pushTrace(ctx, 'agent_load_skill', { skill }, true, start, loaded.description.slice(0, 60))
        return loaded
      } catch (err) {
        const available = await listAvailableSkills()
        const msg = err instanceof Error ? err.message : String(err)
        pushTrace(ctx, 'agent_load_skill', { skill }, false, start, msg, msg)
        return { error: msg, available: available.map((s) => s.name) }
      }
    },
  },
  {
    declaration: {
      name: 'agent_create_background_task',
      description:
        'Start a background job for multi-symbol pipeline scans, batch quotes, or deep research. Returns task_id - poll with agent_get_background_task.',
      parameters: {
        type: 'OBJECT',
        properties: {
          kind: {
            type: 'STRING',
            enum: ['pipeline_scan', 'multi_quote', 'research_brief'],
            description: 'pipeline_scan = TA confluence per symbol; multi_quote = live prices; research_brief = web+news fan-out.',
          },
          prompt: { type: 'STRING', description: 'What this job should accomplish.' },
          symbols: {
            type: 'ARRAY',
            description: 'Symbols for scan/quote jobs (max 6).',
            items: { type: 'STRING' },
          },
        },
        required: ['kind', 'prompt'],
      },
    },
    execute: async (args, ctx) => {
      const start = Date.now()
      const kind = asString(args.kind) as 'pipeline_scan' | 'multi_quote' | 'research_brief'
      if (!['pipeline_scan', 'multi_quote', 'research_brief'].includes(kind)) {
        return { error: 'Invalid kind' }
      }
      const symbols = Array.isArray(args.symbols)
        ? (args.symbols as unknown[]).map((s) => asString(s).toUpperCase()).filter(Boolean)
        : ctx.defaultSymbol
          ? [ctx.defaultSymbol.toUpperCase()]
          : []

      if ((kind === 'pipeline_scan' || kind === 'multi_quote') && !symbols.length) {
        return { error: 'symbols required for scan/quote tasks' }
      }

      const task = createBackgroundTask({
        kind,
        prompt: asString(args.prompt, kind),
        symbols,
      })
      pushTrace(ctx, 'agent_create_background_task', { kind, taskId: task.id }, true, start, task.id)
      return { task_id: task.id, status: task.status, kind: task.kind, symbols: task.symbols }
    },
  },
  {
    declaration: {
      name: 'agent_get_background_task',
      description: 'Poll a background task by task_id. Runs pending work on first poll.',
      parameters: {
        type: 'OBJECT',
        properties: {
          task_id: { type: 'STRING' },
        },
        required: ['task_id'],
      },
    },
    execute: async (args, ctx) => {
      const start = Date.now()
      const taskId = asString(args.task_id)
      const task = await materializeBackgroundTask(taskId)
      if (!task) {
        pushTrace(ctx, 'agent_get_background_task', { task_id: taskId }, false, start, 'not found', 'not found')
        return { error: `Task not found: ${taskId}` }
      }
      pushTrace(ctx, 'agent_get_background_task', { task_id: taskId }, task.status !== 'error', start, task.status)
      return task
    },
  },
  {
    declaration: {
      name: 'agent_list_background_tasks',
      description: 'List recent background tasks for this server instance.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    execute: async (_args, ctx) => {
      const start = Date.now()
      const tasks = listBackgroundTasks(15)
      pushTrace(ctx, 'agent_list_background_tasks', {}, true, start, `${tasks.length} tasks`)
      return { tasks }
    },
  },
  {
    declaration: RUN_SPECIALIST_CONFLUENCE_TOOL.declaration,
    execute: RUN_SPECIALIST_CONFLUENCE_TOOL.execute,
  },
]

export function metaAgentToolDeclarations(): unknown[] {
  return META_AGENT_TOOLS.map((t) => t.declaration)
}

export function getMetaAgentToolByName(name: string): ToolDefinition | undefined {
  return META_AGENT_TOOLS.find((t) => t.declaration.name === name)
}
