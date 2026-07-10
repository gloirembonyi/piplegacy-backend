import { createHash } from 'crypto'
import { addUsageAmount, peekRateLimit, rateLimit, readUsageAmount } from '@/lib/rate-limit'
import {
  getPlanLimits,
  isUnlimited,
  normalizePlanId,
  planUpgradeMessage,
  type PlanId,
} from '@/lib/plan-limits'
import { formatPlanMetricLimitMessage } from '@/lib/plan-limit-messages'
import { shouldOfferUpgrade } from '@/lib/plan-upgrade'

export type PlanMetric =
  | 'marketChatDay'
  | 'marketChatHour'
  | 'analyzeDay'
  | 'botScanDay'
  | 'tokensDay'

type MetricConfig = {
  limitKey: keyof ReturnType<typeof getPlanLimits>
  windowSec: number
  dayScoped: boolean
}

const METRIC_CONFIG: Record<Exclude<PlanMetric, 'tokensDay'>, MetricConfig> = {
  marketChatDay: { limitKey: 'chatPerDay', windowSec: 86_400, dayScoped: true },
  marketChatHour: { limitKey: 'chatPerHour', windowSec: 3_600, dayScoped: false },
  analyzeDay: { limitKey: 'analyzePerDay', windowSec: 86_400, dayScoped: true },
  botScanDay: { limitKey: 'botScansPerDay', windowSec: 86_400, dayScoped: true },
}

const TOKENS_DAY_WINDOW_SEC = 86_400

function usageKey(email: string, metric: PlanMetric): string {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const hour = now.toISOString().slice(0, 13)
  if (metric === 'tokensDay') {
    return `plan:${hash}:${metric}:${day}`
  }
  const cfg = METRIC_CONFIG[metric]
  const scope = cfg.dayScoped ? day : hour
  return `plan:${hash}:${metric}:${scope}`
}

export type PlanUsageResult = {
  ok: boolean
  remaining: number
  limit: number
  plan: PlanId
  upgradeRequired?: boolean
  message?: string
}

export async function getPlanUsage(
  email: string,
  plan: string | undefined | null,
  metric: Exclude<PlanMetric, 'tokensDay'>
): Promise<PlanUsageResult> {
  const planId = normalizePlanId(plan)
  const limits = getPlanLimits(planId)
  const cfg = METRIC_CONFIG[metric]
  const limit = limits[cfg.limitKey] as number

  if (isUnlimited(limit)) {
    return { ok: true, remaining: -1, limit: -1, plan: planId }
  }

  if (limit === 0) {
    return {
      ok: false,
      remaining: 0,
      limit: 0,
      plan: planId,
      upgradeRequired: shouldOfferUpgrade(planId),
      message: planUpgradeMessage('This feature'),
    }
  }

  const key = usageKey(email, metric)
  const bucket = await peekRateLimit(key, limit, cfg.windowSec)
  return {
    ok: bucket.remaining > 0,
    remaining: bucket.remaining,
    limit,
    plan: planId,
    upgradeRequired: bucket.remaining <= 0 && shouldOfferUpgrade(planId),
    message:
      bucket.remaining <= 0
        ? formatPlanMetricLimitMessage(metric, limit, planId)
        : undefined,
  }
}

/** Increment usage counter; returns false when limit exceeded. */
export async function consumePlanUsage(
  email: string,
  plan: string | undefined | null,
  metric: Exclude<PlanMetric, 'tokensDay'>
): Promise<PlanUsageResult> {
  const planId = normalizePlanId(plan)
  const limits = getPlanLimits(planId)
  const cfg = METRIC_CONFIG[metric]
  const limit = limits[cfg.limitKey] as number

  if (isUnlimited(limit)) {
    return { ok: true, remaining: -1, limit: -1, plan: planId }
  }

  if (limit === 0) {
    return {
      ok: false,
      remaining: 0,
      limit: 0,
      plan: planId,
      upgradeRequired: shouldOfferUpgrade(planId),
      message: planUpgradeMessage('This feature'),
    }
  }

  const key = usageKey(email, metric)
  const bucket = await rateLimit(key, limit, cfg.windowSec)
  return {
    ok: bucket.ok,
    remaining: bucket.remaining,
    limit,
    plan: planId,
    upgradeRequired: !bucket.ok && shouldOfferUpgrade(planId),
    message: !bucket.ok
      ? formatPlanMetricLimitMessage(metric, limit, planId)
      : undefined,
  }
}

/** Record AI token usage for the current UTC day (informational, not rate-limited). */
export async function recordPlanTokens(
  email: string,
  tokens: number
): Promise<number> {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return getPlanTokensToday(email)
  }
  const key = usageKey(email, 'tokensDay')
  return addUsageAmount(key, tokens, TOKENS_DAY_WINDOW_SEC)
}

export async function getPlanTokensToday(email: string): Promise<number> {
  const key = usageKey(email, 'tokensDay')
  return readUsageAmount(key)
}

export type PlanUsageSlice = { used: number; limit: number; remaining: number }

export type PlanUsageSummary = Record<
  Exclude<PlanMetric, 'tokensDay'>,
  PlanUsageSlice
> & {
  tokensDay: { used: number }
}

export async function getPlanUsageSummary(
  email: string,
  plan: string | undefined | null
): Promise<PlanUsageSummary> {
  const planId = normalizePlanId(plan)
  const limits = getPlanLimits(planId)
  const metrics: Exclude<PlanMetric, 'tokensDay'>[] = [
    'marketChatDay',
    'marketChatHour',
    'analyzeDay',
    'botScanDay',
  ]

  const out = {} as PlanUsageSummary

  for (const metric of metrics) {
    const cfg = METRIC_CONFIG[metric]
    const limit = limits[cfg.limitKey] as number
    if (isUnlimited(limit)) {
      out[metric] = { used: 0, limit: -1, remaining: -1 }
      continue
    }
    const usage = await getPlanUsage(email, planId, metric)
    out[metric] = {
      used: Math.max(0, limit - usage.remaining),
      limit,
      remaining: usage.remaining,
    }
  }

  out.tokensDay = { used: await getPlanTokensToday(email) }

  return out
}
