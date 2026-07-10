import { NextResponse } from 'next/server'
import { AGENT_REGISTRY } from '@/lib/admin-agent-registry'
import {
  CANARY_TOOL_NAMES,
  probeAllAdminTools,
  resolveToolHealth,
} from '@/lib/admin-tool-probes'
import { probeScanPipelineHealth } from '@/lib/agent/pipeline-engine'
import { AGENT_TOOL_META, SUB_AGENT_LABELS } from '@/lib/agent-work-ui'
import { buildGeminiConsumerUsageReport } from '@/lib/gemini-consumer-usage'
import { listGeminiConsumersForAdmin, toolUsesGemini } from '@/lib/gemini-consumers'
import { listRegisteredToolNames } from '@/lib/ai-tools/registry'
import { isAuthSession } from '@/lib/require-auth'
import { requireAdmin } from '@/lib/require-admin'
import { getAgentUsage, getToolUsage } from '@/lib/tool-usage-tracker'
import { getRecentAdminErrors } from '@/lib/admin-error-log'
import { getRecentAgentRuns } from '@/lib/agent/run-audit'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

type HealthStatus = 'healthy' | 'degraded' | 'unknown' | 'offline'

function healthFromUsage(calls: number, errors: number, successRate: number | null): HealthStatus {
  if (calls === 0) return 'unknown'
  if (successRate != null && successRate >= 90) return 'healthy'
  if (successRate != null && successRate >= 70) return 'degraded'
  if (errors >= calls) return 'offline'
  return 'degraded'
}

function resolveAgentHealth(
  agentId: string,
  usage: { calls: number; errors: number; successRate: number | null },
  pipelineOk: boolean,
  toolProbeHealthy: boolean
): HealthStatus {
  if (usage.calls > 0) return healthFromUsage(usage.calls, usage.errors, usage.successRate)

  if (agentId.startsWith('specialist:') && agentId !== 'specialist:orchestrator') {
    return pipelineOk ? 'healthy' : 'unknown'
  }
  if (agentId === 'specialist:orchestrator' || agentId === 'manager' || agentId === 'main_agent') {
    return pipelineOk ? 'healthy' : 'degraded'
  }
  if (agentId === 'setup' || agentId === 'macro' || agentId === 'research' || agentId === 'discovery' || agentId === 'verification') {
    return toolProbeHealthy ? 'healthy' : 'unknown'
  }
  return 'unknown'
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!isAuthSession(auth)) return auth

  let probeMap: Awaited<ReturnType<typeof probeAllAdminTools>>
  let probeError: string | undefined
  const url = new URL(request.url)
  const forceProbe = url.searchParams.get('force') === '1'
  try {
    probeMap = await probeAllAdminTools({ force: forceProbe })
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err)
    probeMap = new Map()
  }

  const [pipelineProbe, recentErrors, recentAgentRuns] = await Promise.all([
    probeScanPipelineHealth(),
    getRecentAdminErrors(20),
    getRecentAgentRuns(40),
  ])

  const toolNames = listRegisteredToolNames()
  const canaryProbes = CANARY_TOOL_NAMES.map((name) => {
    const p = probeMap.get(name)
    return {
      name,
      ok: p?.ok ?? false,
      latencyMs: p?.latencyMs ?? 0,
      detail: p?.detail ?? 'No probe',
      optional: p?.optional ?? false,
    }
  })

  const coreToolsHealthy = ['get_market_sessions', 'search_web', 'get_economic_calendar'].every(
    (t) => probeMap.get(t)?.ok
  )

  const tools = await Promise.all(
    toolNames.map(async (name) => {
      const usage = await getToolUsage(name)
      const meta = AGENT_TOOL_META[name]
      const probe = probeMap.get(name) ?? null

      return {
        id: name,
        label: meta?.label ?? name.replace(/_/g, ' '),
        usesGemini: toolUsesGemini(name),
        category: name.startsWith('chart_mcp')
          ? 'chart'
          : name.startsWith('tradingview')
            ? 'tradingview'
            : name.includes('crypto')
              ? 'crypto'
              : name.includes('web') || name.includes('search') || name.includes('fetch')
                ? 'research'
                : 'market',
        usage,
        health: resolveToolHealth(probe ?? undefined, usage.today),
        probe,
      }
    })
  )

  const agents = await Promise.all(
    AGENT_REGISTRY.map(async (agent) => {
      const usage = await getAgentUsage(agent.id)
      return {
        ...agent,
        usage,
        health: resolveAgentHealth(
          agent.id,
          usage.today,
          pipelineProbe.ok,
          coreToolsHealthy
        ),
        probeDetail:
          agent.id.startsWith('specialist:') && usage.today.calls === 0
            ? pipelineProbe.detail
            : undefined,
      }
    })
  )

  const totalToolCallsToday = tools.reduce((n, t) => n + t.usage.today.calls, 0)
  const totalAgentRunsToday = agents.reduce((n, a) => n + a.usage.today.calls, 0)
  const canaryHealthy = canaryProbes.filter((p) => p.ok).length
  const toolsHealthy = tools.filter((t) => t.health === 'healthy' || t.health === 'degraded').length

  const failingTools = tools.filter(
    (t) => t.health === 'offline' || (t.usage.today.errors > 0 && t.usage.today.successRate != null && t.usage.today.successRate < 100)
  )
  const failingAgents = agents.filter(
    (a) =>
      a.health === 'offline' ||
      (a.usage.today.calls > 0 &&
        a.usage.today.errors > 0 &&
        a.usage.today.successRate === 0)
  )

  const geminiConsumers = await buildGeminiConsumerUsageReport(recentAgentRuns)

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    probeError,
    summary: {
      toolCount: tools.length,
      agentCount: agents.length,
      toolCallsToday: totalToolCallsToday,
      agentRunsToday: totalAgentRunsToday,
      canaryHealthy,
      canaryTotal: CANARY_TOOL_NAMES.length,
      toolsHealthy,
      pipelineEngine: pipelineProbe.engine,
      pipelineOk: pipelineProbe.ok,
      failingToolCount: failingTools.length,
      failingAgentCount: failingAgents.length,
      errorCount24h: recentErrors.length,
    },
    canaryProbes,
    pipelineProbe,
    recentErrors,
    recentAgentRuns,
    failingTools: failingTools.map((t) => ({
      id: t.id,
      label: t.label,
      health: t.health,
      errorsToday: t.usage.today.errors,
      callsToday: t.usage.today.calls,
      successRate: t.usage.today.successRate,
    })),
    failingAgents: failingAgents.map((a) => ({
      id: a.id,
      label: a.label,
      health: a.health,
      errorsToday: a.usage.today.errors,
      callsToday: a.usage.today.calls,
      successRate: a.usage.today.successRate,
    })),
    tools: tools.sort((a, b) => {
      const rank = (h: HealthStatus) =>
        h === 'offline' ? 0 : h === 'degraded' ? 1 : h === 'unknown' ? 2 : 3
      const hr = rank(a.health) - rank(b.health)
      if (hr !== 0) return hr
      return b.usage.today.calls - a.usage.today.calls
    }),
    agents: agents.sort((a, b) => b.usage.today.calls - a.usage.today.calls),
    subAgentLabels: SUB_AGENT_LABELS,
    geminiConsumers,
  })
}
