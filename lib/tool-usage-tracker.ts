import { addUsageAmount, readUsageAmount } from '@/lib/rate-limit'

const DAY_SEC = 86_400

function utcDay(offset = 0): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - offset)
  return d.toISOString().slice(0, 10)
}

function toolCallsKey(tool: string, day: string): string {
  return `tool:calls:${tool}:${day}`
}

function toolErrorsKey(tool: string, day: string): string {
  return `tool:errors:${tool}:${day}`
}

function agentRunsKey(agentId: string, day: string): string {
  return `agent:runs:${agentId}:${day}`
}

function agentErrorsKey(agentId: string, day: string): string {
  return `agent:errors:${agentId}:${day}`
}

/** Record a tool invocation (success or failure). Fire-and-forget safe. */
export async function recordToolCall(tool: string, ok: boolean): Promise<void> {
  const day = utcDay(0)
  await addUsageAmount(toolCallsKey(tool, day), 1, DAY_SEC)
  if (!ok) await addUsageAmount(toolErrorsKey(tool, day), 1, DAY_SEC)
}

/** Record a sub-agent or pipeline specialist run. */
export async function recordAgentRun(agentId: string, ok: boolean): Promise<void> {
  const day = utcDay(0)
  await addUsageAmount(agentRunsKey(agentId, day), 1, DAY_SEC)
  if (!ok) await addUsageAmount(agentErrorsKey(agentId, day), 1, DAY_SEC)
}

export type UsageCounts = {
  calls: number
  errors: number
  successRate: number | null
}

export async function getToolUsage(tool: string): Promise<{ today: UsageCounts; last7d: UsageCounts }> {
  const todayCalls = await readUsageAmount(toolCallsKey(tool, utcDay(0)))
  const todayErrors = await readUsageAmount(toolErrorsKey(tool, utcDay(0)))
  const today: UsageCounts = {
    calls: todayCalls,
    errors: todayErrors,
    successRate:
      todayCalls > 0 ? Math.round(((todayCalls - todayErrors) / todayCalls) * 100) : null,
  }

  let calls7 = 0
  let errors7 = 0
  for (let i = 0; i < 7; i++) {
    const day = utcDay(i)
    calls7 += await readUsageAmount(toolCallsKey(tool, day))
    errors7 += await readUsageAmount(toolErrorsKey(tool, day))
  }
  const last7d: UsageCounts = {
    calls: calls7,
    errors: errors7,
    successRate: calls7 > 0 ? Math.round(((calls7 - errors7) / calls7) * 100) : null,
  }

  return { today, last7d }
}

export async function getAgentUsage(agentId: string): Promise<{ today: UsageCounts; last7d: UsageCounts }> {
  const todayCalls = await readUsageAmount(agentRunsKey(agentId, utcDay(0)))
  const todayErrors = await readUsageAmount(agentErrorsKey(agentId, utcDay(0)))
  const today: UsageCounts = {
    calls: todayCalls,
    errors: todayErrors,
    successRate:
      todayCalls > 0 ? Math.round(((todayCalls - todayErrors) / todayCalls) * 100) : null,
  }

  let calls7 = 0
  let errors7 = 0
  for (let i = 0; i < 7; i++) {
    const day = utcDay(i)
    calls7 += await readUsageAmount(agentRunsKey(agentId, day))
    errors7 += await readUsageAmount(agentErrorsKey(agentId, day))
  }
  const last7d: UsageCounts = {
    calls: calls7,
    errors: errors7,
    successRate: calls7 > 0 ? Math.round(((calls7 - errors7) / calls7) * 100) : null,
  }

  return { today, last7d }
}
