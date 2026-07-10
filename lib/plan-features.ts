/**
 * Human-readable plan features for UI (success page, settings, pricing).
 */

import { getPlanLimits, isUnlimited, type PlanId } from '@/lib/plan-limits'
import { PRICING_PLANS } from '@/lib/pricing-plans'

export type PlanFeature = {
  id: string
  label: string
  value: string
  unlocked: boolean
  highlight?: boolean
}

export type PlanQuickStart = {
  icon: 'chart' | 'bot' | 'markets' | 'settings' | 'brokers' | 'explorer'
  title: string
  detail: string
  href: string
}

export function formatLimitValue(limit: number, unit = 'per day'): string {
  if (isUnlimited(limit)) return 'Unlimited'
  if (limit === 0) return 'Not included'
  return `${limit}${unit === 'per day' ? '/day' : ` ${unit}`}`
}

export function getPlanFeatures(planId: PlanId): PlanFeature[] {
  const l = getPlanLimits(planId)

  return [
    {
      id: 'chat',
      label: 'AI agent chats',
      value: formatLimitValue(l.chatPerDay),
      unlocked: l.chatPerDay !== 0,
      highlight: isUnlimited(l.chatPerDay),
    },
    {
      id: 'analyze',
      label: 'Chart image analyses',
      value: formatLimitValue(l.analyzePerDay),
      unlocked: l.analyzePerDay !== 0,
      highlight: isUnlimited(l.analyzePerDay),
    },
    {
      id: 'scan',
      label: 'Multi-agent bot scans',
      value: formatLimitValue(l.botScansPerDay),
      unlocked: l.botScansPerDay > 0,
      highlight: isUnlimited(l.botScansPerDay) || l.botScansPerDay >= 50,
    },
    {
      id: 'pending',
      label: 'Armed pending setups',
      value: isUnlimited(l.pendingSetupsMax)
        ? 'Unlimited'
        : l.pendingSetupsMax === 0
          ? 'Not included'
          : `Up to ${l.pendingSetupsMax}`,
      unlocked: l.pendingSetupsMax !== 0,
      highlight: isUnlimited(l.pendingSetupsMax),
    },
    {
      id: 'watchlist',
      label: 'Watchlist symbols',
      value: isUnlimited(l.watchlistMax) ? 'Unlimited' : `Up to ${l.watchlistMax}`,
      unlocked: true,
      highlight: isUnlimited(l.watchlistMax) || l.watchlistMax >= 50,
    },
    {
      id: 'autotrader',
      label: 'Auto-trader pipeline',
      value: l.autoTrader ? 'Included' : 'Not included',
      unlocked: l.autoTrader,
    },
    {
      id: 'suggestions',
      label: 'AI suggestion refresh',
      value: l.aiSuggestionsRefresh ? 'Included' : 'Not included',
      unlocked: l.aiSuggestionsRefresh,
    },
    {
      id: 'live',
      label: 'Live broker trading',
      value: l.liveTrading ? 'Eligible' : 'Paper only',
      unlocked: l.liveTrading,
      highlight: l.liveTrading,
    },
  ]
}

export function getPlanMarketingBullets(planId: PlanId): string[] {
  const row = PRICING_PLANS.find((p) => p.id === planId)
  if (!row) return getPlanFeatures(planId).filter((f) => f.unlocked).map((f) => `${f.label}: ${f.value}`)
  return row.includes.slice(1)
}

export function getPlanQuickStarts(planId: PlanId): PlanQuickStart[] {
  const common: PlanQuickStart[] = [
    {
      icon: 'explorer',
      title: 'Build your watchlist',
      detail: 'Add the tickers, pairs, and crypto you trade most.',
      href: '/app?view=explorer',
    },
    {
      icon: 'chart',
      title: 'Run a chart scan',
      detail: 'Open Chart Analysis and let the multi-agent pipeline find setups.',
      href: '/app?view=trading',
    },
    {
      icon: 'markets',
      title: 'Check Market Insights',
      detail: 'Sessions, economic calendar, news, and AI brief in one place.',
      href: '/app?view=markets',
    },
    {
      icon: 'settings',
      title: 'Review plan & usage',
      detail: 'See daily limits, preferences, and subscription status.',
      href: '/plan',
    },
  ]

  if (planId === 'pro' || planId === 'enterprise') {
    return [
      {
        icon: 'bot',
        title: 'Configure Auto Trader',
        detail: 'Enable strategies, set risk, and arm pending entries.',
        href: '/app?view=bot',
      },
      {
        icon: 'brokers',
        title: 'Connect a broker',
        detail: 'Link Alpaca or OANDA for paper or live execution.',
        href: '/app?view=brokers',
      },
      ...common.slice(0, 2),
    ]
  }

  if (planId === 'starter') {
    return [
      common[0],
      {
        icon: 'bot',
        title: 'Try a bot scan',
        detail: 'Run the confluence scanner on gold, forex, or equities.',
        href: '/app?view=trading',
      },
      common[2],
      common[3],
    ]
  }

  return common
}

export function getPlanCelebrationHeadline(planId: PlanId): string {
  const labels: Record<PlanId, string> = {
    free: 'Welcome to Piplegacy',
    starter: 'Starter plan activated',
    pro: 'Professional plan activated',
    enterprise: 'Enterprise plan activated',
  }
  return labels[planId] ?? 'Subscription activated'
}

export function getPlanCelebrationSubline(planId: PlanId): string {
  const l = getPlanLimits(planId)
  if (planId === 'pro') {
    return 'Unlimited AI chats, 50 scans per day, and full auto-trader access are now linked to your account.'
  }
  if (planId === 'starter') {
    return 'Your Starter limits are active - AI analysis, scans, and paper trading are ready to use.'
  }
  if (planId === 'enterprise') {
    return 'Enterprise access is active. Your team limits and premium features are unlocked.'
  }
  return 'Your account is ready. Explore the platform below.'
}
