import {
  getPlanDisplayName,
  getRecommendedUpgradePlan,
  shouldOfferUpgrade,
} from '@/lib/plan-upgrade'
import { getPlanLimits, normalizePlanId, type PlanId } from '@/lib/plan-limits'
import type { PlanMetric } from '@/lib/plan-usage'

export type LimitWindow = 'day' | 'hour'

export type PlanLimitCopy = {
  message: string
  upgradeRequired: boolean
  targetPlan: PlanId | null
  kind: LimitWindow
  limit: number
}

function formatChatPerDay(limit: number): string {
  return limit < 0 ? 'unlimited daily chats' : `${limit} chats per day`
}

function formatChatPerHour(limit: number): string {
  return limit < 0 ? 'unlimited hourly chats' : `${limit} chats per hour`
}

/** User-facing copy when Market Agent chat quota is exhausted. */
export function formatMarketChatLimitMessage(opts: {
  kind: LimitWindow
  limit: number
  plan?: string | null
}): PlanLimitCopy {
  const planId = normalizePlanId(opts.plan)
  const planLabel = getPlanDisplayName(planId)
  const upgradeRequired = shouldOfferUpgrade(planId)
  const targetPlan = getRecommendedUpgradePlan(planId)
  const nextLimits = targetPlan ? getPlanLimits(targetPlan) : null
  const nextLabel = targetPlan ? getPlanDisplayName(targetPlan) : null

  if (opts.kind === 'hour') {
    const message =
      upgradeRequired && nextLimits && nextLabel
        ? `You've reached your hourly chat limit (${opts.limit} on ${planLabel}). Try again soon, or upgrade to ${nextLabel} for ${formatChatPerHour(nextLimits.chatPerHour)}.`
        : `You've reached your hourly chat limit (${opts.limit} per hour on ${planLabel}). Please try again shortly.`
    return {
      message,
      upgradeRequired,
      targetPlan,
      kind: 'hour',
      limit: opts.limit,
    }
  }

  const resetHint = 'Your limit resets at midnight UTC.'
  const message =
    upgradeRequired && nextLimits && nextLabel
      ? `You've used all ${opts.limit} Market Agent chats on your ${planLabel} plan today. Upgrade to ${nextLabel} for ${formatChatPerDay(nextLimits.chatPerDay)} - or ${resetHint.toLowerCase()}`
      : `You've used all ${opts.limit} Market Agent chats for today on your ${planLabel} plan. ${resetHint}`

  return {
    message,
    upgradeRequired,
    targetPlan,
    kind: 'day',
    limit: opts.limit,
  }
}

/** Server-side limit messages for plan metrics. */
export function formatPlanMetricLimitMessage(
  metric: Exclude<PlanMetric, 'tokensDay'>,
  limit: number,
  plan?: string | null
): string {
  if (metric === 'marketChatDay') {
    return formatMarketChatLimitMessage({ kind: 'day', limit, plan }).message
  }
  if (metric === 'marketChatHour') {
    return formatMarketChatLimitMessage({ kind: 'hour', limit, plan }).message
  }

  const planLabel = getPlanDisplayName(plan)
  const window = metric.includes('Day') ? 'day' : 'hour'
  const upgradeRequired = shouldOfferUpgrade(plan)
  const targetPlan = getRecommendedUpgradePlan(plan)
  const nextLabel = targetPlan ? getPlanDisplayName(targetPlan) : null

  const base = `You've reached your ${window}ly limit (${limit} per ${window}) on ${planLabel}.`
  if (upgradeRequired && nextLabel) {
    return `${base} Upgrade to ${nextLabel} for higher limits.`
  }
  return base
}
