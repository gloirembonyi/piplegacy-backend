import { getGeminiApiKeys } from '@/lib/gemini'
import { getDeepseekApiKeys } from '@/lib/deepseek'
import { poolStatus, type AiProvider } from '@/lib/gemini-keypool'
import {
  getKeyUsageRow,
  getPlatformUsageToday,
  getRecentAiCalls,
  type AiLastUsed,
  type KeyUsageRow,
  type RecentAiCall,
} from '@/lib/ai-usage-tracker'
import {
  fetchAllDeepseekBalances,
  getGeminiDailyTokenBudget,
  type DeepseekBalanceResult,
} from '@/lib/deepseek-balance'
import { getPlanTokensToday } from '@/lib/plan-usage'
import { listAdminUsers } from '@/lib/admin-users'
import { getRecentAdminErrors, type AdminErrorEntry } from '@/lib/admin-error-log'
import { getRedisSetupHint, isRedisConfigured } from '@/lib/redis'

export type AdminKeyMetrics = KeyUsageRow & {
  poolReady: boolean
  poolReadyInMs: number
  poolLastStatus?: number
  poolFailures: number
  /** DeepSeek only - live API balance */
  balance?: DeepseekBalanceResult | null
  /** Gemini only - estimated from configured daily budget minus measured usage */
  geminiBudget?: number
  geminiRemainingEstimate?: number | null
  lastUsed?: AiLastUsed | null
}

export type AdminUsageReport = {
  timestamp: string
  platform: Awaited<ReturnType<typeof getPlatformUsageToday>>
  keys: AdminKeyMetrics[]
  deepseekBalances: DeepseekBalanceResult[]
  geminiDailyBudgetPerKey: number
  topUsersToday: Array<{ email: string; tokens: number; plan: string }>
  recentCalls: RecentAiCall[]
  recentErrors: AdminErrorEntry[]
  storage: {
    redisConfigured: boolean
    onVercel: boolean
    persistent: boolean
    hint: string | null
  }
  envKeys: {
    gemini: Array<{ suffix: string; index: number }>
    deepseek: Array<{ suffix: string; index: number }>
  }
  notes: string[]
}

export async function buildAdminUsageReport(): Promise<AdminUsageReport> {
  const geminiKeys = getGeminiApiKeys()
  const deepseekKeys = getDeepseekApiKeys()
  const geminiPool = poolStatus('gemini')
  const deepseekPool = poolStatus('deepseek')
  const geminiDailyBudgetPerKey = getGeminiDailyTokenBudget()

  const [platform, deepseekBalances, users, recentCalls, recentErrors] = await Promise.all([
    getPlatformUsageToday(),
    fetchAllDeepseekBalances(deepseekKeys),
    listAdminUsers(),
    getRecentAiCalls(25),
    getRecentAdminErrors(25),
  ])

  const balanceBySuffix = new Map(deepseekBalances.map((b) => [b.keySuffix, b]))

  const keys: AdminKeyMetrics[] = []

  for (const key of geminiKeys) {
    const suffix = key.slice(-4)
    const usage = await getKeyUsageRow('gemini', suffix)
    const pool = geminiPool.details.find((d) => d.keySuffix === suffix)
    const remaining =
      geminiDailyBudgetPerKey > 0
        ? Math.max(0, geminiDailyBudgetPerKey - usage.today.tokens)
        : null

    keys.push({
      ...usage,
      poolReady: (pool?.readyIn ?? 0) === 0,
      poolReadyInMs: pool?.readyIn ?? 0,
      poolLastStatus: pool?.lastStatus,
      poolFailures: pool?.consecutiveFailures ?? 0,
      balance: null,
      geminiBudget: geminiDailyBudgetPerKey,
      geminiRemainingEstimate: remaining,
      lastUsed: usage.lastUsed ?? null,
    })
  }

  for (const key of deepseekKeys) {
    const suffix = key.slice(-4)
    const usage = await getKeyUsageRow('deepseek', suffix)
    const pool = deepseekPool.details.find((d) => d.keySuffix === suffix)

    keys.push({
      ...usage,
      poolReady: (pool?.readyIn ?? 0) === 0,
      poolReadyInMs: pool?.readyIn ?? 0,
      poolLastStatus: pool?.lastStatus,
      poolFailures: pool?.consecutiveFailures ?? 0,
      balance: balanceBySuffix.get(suffix) ?? null,
      lastUsed: usage.lastUsed ?? null,
    })
  }

  const topUsersToday = (
    await Promise.all(
      users.slice(0, 100).map(async (u) => ({
        email: u.email,
        plan: u.plan,
        tokens: await getPlanTokensToday(u.email),
      }))
    )
  )
    .filter((u) => u.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 12)

  const redisConfigured = isRedisConfigured()
  const onVercel = Boolean(process.env.VERCEL)
  const persistent = redisConfigured || !onVercel

  const notes = [
    'Token counts are recorded on every AI call (success and failure).',
    'When a provider omits usage metadata, tokens are estimated from request/response size.',
    'DeepSeek remaining balance is fetched live from the provider balance API.',
    'Gemini remaining is estimated from GEMINI_DAILY_TOKEN_BUDGET minus today’s measured tokens per key.',
    'Key suffixes (…abcd) match the last 4 characters of each env API key.',
  ]
  if (onVercel && !redisConfigured) {
    notes.unshift(
      '⚠ Vercel without Redis/KV: usage counters reset per serverless instance - connect Upstash Redis for accurate totals.'
    )
  }

  return {
    timestamp: new Date().toISOString(),
    platform,
    keys,
    deepseekBalances,
    geminiDailyBudgetPerKey,
    topUsersToday,
    recentCalls,
    recentErrors,
    storage: {
      redisConfigured,
      onVercel,
      persistent,
      hint: redisConfigured ? null : getRedisSetupHint(),
    },
    envKeys: {
      gemini: geminiKeys.map((k, i) => ({ suffix: k.slice(-4), index: i + 1 })),
      deepseek: deepseekKeys.map((k, i) => ({ suffix: k.slice(-4), index: i + 1 })),
    },
    notes,
  }
}

export function providerLabel(p: AiProvider): string {
  return p === 'gemini' ? 'Primary AI (Gemini)' : 'Fallback AI (DeepSeek)'
}
