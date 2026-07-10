import { createCheckoutSession } from '@/lib/stripe'
import { getPlanLimits, normalizePlanId, planRank, type PlanId } from '@/lib/plan-limits'
import { PRICING_PLANS } from '@/lib/pricing-plans'

export function getPlanDisplayName(plan: string | undefined | null): string {
  return getPlanLimits(plan).label
}

/** Next paid tier the user can checkout for. */
export function getRecommendedUpgradePlan(plan: string | undefined | null): PlanId | null {
  const current = normalizePlanId(plan)
  if (current === 'free') return 'starter'
  if (current === 'starter') return 'pro'
  if (current === 'pro') return 'enterprise'
  return null
}

/** True when the user can move to a higher paid tier. */
export function shouldOfferUpgrade(plan: string | undefined | null): boolean {
  return getRecommendedUpgradePlan(plan) !== null
}

export function canUpgrade(plan: string | undefined | null): boolean {
  return shouldOfferUpgrade(plan)
}

export function getUpgradePrice(planId: PlanId, yearly = false): number | null {
  const row = PRICING_PLANS.find((p) => p.id === planId)
  if (!row) return null
  return yearly ? row.yearlyPrice : row.price
}

export function cleanUpgradeMessage(message: string): string {
  return message
    .replace(/\s*Upgrade at \/pricing\.?/gi, '')
    .replace(/\s*Upgrade at \/pricing for more\.?/gi, '')
    .trim()
}

export function getPlanButtonLabel(
  currentPlan: string | undefined | null,
  targetPlan: PlanId
): string {
  const current = normalizePlanId(currentPlan)
  if (current === targetPlan) return 'Current plan'
  if (planRank(targetPlan) < planRank(current)) return 'Included in your plan'
  if (targetPlan === 'enterprise') return 'Contact sales'
  if (current === 'free') return 'Subscribe now'
  return `Upgrade to ${getPlanDisplayName(targetPlan)}`
}

export function isCheckoutDisabled(
  currentPlan: string | undefined | null,
  targetPlan: PlanId
): boolean {
  const current = normalizePlanId(currentPlan)
  if (targetPlan === 'enterprise') return false
  return current === targetPlan || planRank(targetPlan) < planRank(current)
}

export async function startPlanCheckout(
  planId: PlanId,
  isAnnual = false
): Promise<void> {
  if (planId === 'enterprise') {
    window.location.href =
      'mailto:sales@marketsignal.com?subject=Enterprise%20Plan%20Inquiry'
    return
  }

  const sessionRes = await fetch('/api/user/me', { credentials: 'same-origin' })
  if (!sessionRes.ok) {
    window.location.href = `/login?redirect=${encodeURIComponent('/pricing')}`
    return
  }

  await createCheckoutSession(planId, isAnnual)
}
