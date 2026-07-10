/**
 * Subscription plan definitions and feature limits.
 * Plans are stored on the user record after Stripe checkout completes.
 */

export type PlanId = 'free' | 'starter' | 'pro' | 'enterprise'

export type PlanLimits = {
  label: string
  /** Max agent chat messages per calendar day. -1 = unlimited. */
  chatPerDay: number
  /** Max agent chat messages per hour. -1 = unlimited. */
  chatPerHour: number
  /** Max chart image analyses per day. -1 = unlimited. */
  analyzePerDay: number
  /** Max multi-agent bot scans per day. 0 = disabled. */
  botScansPerDay: number
  /** Max simultaneously armed pending setups. */
  pendingSetupsMax: number
  /** Max watchlist symbols. */
  watchlistMax: number
  /** Can use auto-trader / bot scan (paper or live). */
  autoTrader: boolean
  /** Can force-refresh AI suggestions. */
  aiSuggestionsRefresh: boolean
  /** Can place live broker orders (still gated by BOT_LIVE_TRADING_ENABLED). */
  liveTrading: boolean
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    label: 'Free',
    chatPerDay: 5,
    chatPerHour: 3,
    analyzePerDay: 2,
    botScansPerDay: 5,
    pendingSetupsMax: 1,
    watchlistMax: 5,
    autoTrader: true,
    aiSuggestionsRefresh: false,
    liveTrading: false,
  },
  starter: {
    label: 'Starter',
    chatPerDay: 30,
    chatPerHour: 10,
    analyzePerDay: 15,
    botScansPerDay: 5,
    pendingSetupsMax: 3,
    watchlistMax: 15,
    autoTrader: true,
    aiSuggestionsRefresh: true,
    liveTrading: false,
  },
  pro: {
    label: 'Professional',
    chatPerDay: -1,
    chatPerHour: -1,
    analyzePerDay: -1,
    botScansPerDay: 50,
    pendingSetupsMax: 20,
    watchlistMax: 50,
    autoTrader: true,
    aiSuggestionsRefresh: true,
    liveTrading: true,
  },
  enterprise: {
    label: 'Enterprise',
    chatPerDay: -1,
    chatPerHour: -1,
    analyzePerDay: -1,
    botScansPerDay: -1,
    pendingSetupsMax: -1,
    watchlistMax: -1,
    autoTrader: true,
    aiSuggestionsRefresh: true,
    liveTrading: true,
  },
}

export function normalizePlanId(plan: string | undefined | null): PlanId {
  const p = (plan ?? 'free').trim().toLowerCase()
  if (p === 'starter' || p === 'pro' || p === 'enterprise') return p
  return 'free'
}

export function getPlanLimits(plan: string | undefined | null): PlanLimits {
  return PLAN_LIMITS[normalizePlanId(plan)]
}

export function isPaidPlan(plan: string | undefined | null): boolean {
  return normalizePlanId(plan) !== 'free'
}

export function isUnlimited(limit: number): boolean {
  return limit < 0
}

export function planRank(plan: string | undefined | null): number {
  const order: Record<PlanId, number> = {
    free: 0,
    starter: 1,
    pro: 2,
    enterprise: 3,
  }
  return order[normalizePlanId(plan)]
}

export function isPlanAtLeast(current: string | undefined | null, required: PlanId): boolean {
  return planRank(current) >= planRank(required)
}

export function planUpgradeMessage(feature: string): string {
  return `${feature} is not included on your plan. Upgrade to unlock more.`
}
