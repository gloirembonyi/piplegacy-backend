/**
 * Stripe subscription sync - keeps paid plans attached to the user record.
 */

import Stripe from 'stripe'
import { isStripeConfigured } from '@/lib/env'
import { normalizePlanId, planRank, type PlanId } from '@/lib/plan-limits'
import { rateLimit } from '@/lib/rate-limit'
import { getUserData, saveUserData } from '@/lib/user-store'
import type { UserData } from '@/lib/user-types'

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured')
  return new Stripe(secretKey, { apiVersion: '2025-09-30.clover' })
}

function planFromStripeMetadata(raw: string | undefined | null): PlanId | null {
  if (!raw) return null
  const normalized = normalizePlanId(raw)
  return normalized === 'free' ? null : normalized
}

function isSubscriptionActive(status: Stripe.Subscription.Status): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due'
}

export type SubscriptionSyncResult = {
  plan: PlanId
  subscriptionStatus: UserData['subscriptionStatus']
  synced: boolean
  source: 'local' | 'stripe'
}

/** Apply checkout session data and never downgrade on re-redeem. */
export async function applyCheckoutToUser(
  email: string,
  planId: PlanId,
  stripeCustomerId?: string | null,
  stripeSubscriptionId?: string | null
): Promise<UserData> {
  const data = await getUserData(email)
  const incoming = normalizePlanId(planId)

  if (planRank(incoming) >= planRank(data.plan)) {
    data.plan = incoming
  } else if (!data.plan || data.plan === 'free') {
    data.plan = incoming
  }

  if (stripeCustomerId) data.stripeCustomerId = stripeCustomerId
  if (stripeSubscriptionId) data.stripeSubscriptionId = stripeSubscriptionId

  data.subscriptionStatus = 'active'
  data.planActivatedAt = data.planActivatedAt ?? new Date().toISOString()
  data.planSource = 'stripe'
  await saveUserData(data)
  return data
}

/** Verify Stripe subscription and restore plan if the local record drifted. */
export async function syncUserSubscription(
  email: string,
  opts: { force?: boolean } = {}
): Promise<SubscriptionSyncResult> {
  const data = await getUserData(email)
  const localPlan = normalizePlanId(data.plan)

  if (!isStripeConfigured()) {
    return {
      plan: localPlan,
      subscriptionStatus: data.subscriptionStatus,
      synced: false,
      source: 'local',
    }
  }

  if (!opts.force) {
    const rl = await rateLimit(`stripe-sync:${email}`, 12, 3600)
    if (!rl.ok) {
      return {
        plan: localPlan,
        subscriptionStatus: data.subscriptionStatus,
        synced: false,
        source: 'local',
      }
    }
  }

  if (!data.stripeSubscriptionId) {
    return {
      plan: localPlan,
      subscriptionStatus: data.subscriptionStatus,
      synced: false,
      source: 'local',
    }
  }

  try {
    const stripe = getStripe()
    const sub = await stripe.subscriptions.retrieve(data.stripeSubscriptionId)
    const metaPlan = planFromStripeMetadata(sub.metadata?.planId)

    if (isSubscriptionActive(sub.status)) {
      const restored = metaPlan ?? localPlan
      if (planRank(restored) > planRank(localPlan) || localPlan === 'free') {
        data.plan = restored
      }
      data.subscriptionStatus = sub.status
      data.stripeCustomerId =
        typeof sub.customer === 'string' ? sub.customer : data.stripeCustomerId
      data.planActivatedAt = data.planActivatedAt ?? new Date(sub.created * 1000).toISOString()
      data.planSource = 'stripe'
      await saveUserData(data)
      return {
        plan: normalizePlanId(data.plan),
        subscriptionStatus: data.subscriptionStatus,
        synced: true,
        source: 'stripe',
      }
    }

    if (sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'incomplete_expired') {
      data.plan = 'free'
      data.subscriptionStatus = sub.status
      await saveUserData(data)
      return {
        plan: 'free',
        subscriptionStatus: data.subscriptionStatus,
        synced: true,
        source: 'stripe',
      }
    }

    return {
      plan: localPlan,
      subscriptionStatus: sub.status,
      synced: true,
      source: 'stripe',
    }
  } catch (err) {
    console.error('syncUserSubscription failed:', err)
    return {
      plan: localPlan,
      subscriptionStatus: data.subscriptionStatus,
      synced: false,
      source: 'local',
    }
  }
}

export function planFromCheckoutMetadata(planId: string | undefined | null): PlanId {
  const normalized = normalizePlanId(planId)
  return normalized === 'free' ? 'pro' : normalized
}

export type SubscriptionDetails = {
  id: string
  status: Stripe.Subscription.Status
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: string | null
  interval: 'month' | 'year' | null
  amount: number | null
  currency: string
}

/** Live Stripe subscription metadata for billing UI. */
export async function getSubscriptionDetails(
  email: string
): Promise<SubscriptionDetails | null> {
  if (!isStripeConfigured()) return null

  const data = await getUserData(email)
  if (!data.stripeSubscriptionId) return null

  try {
    const stripe = getStripe()
    const sub = await stripe.subscriptions.retrieve(data.stripeSubscriptionId, {
      expand: ['items.data.price'],
    })

    const item = sub.items.data[0]
    const price = item?.price

    return {
      id: sub.id,
      status: sub.status,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      currentPeriodEnd: sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null,
      interval:
        price?.recurring?.interval === 'year' || price?.recurring?.interval === 'month'
          ? price.recurring.interval
          : null,
      amount: price?.unit_amount ?? null,
      currency: price?.currency ?? 'usd',
    }
  } catch (err) {
    console.error('getSubscriptionDetails failed:', err)
    return null
  }
}

export async function cancelSubscriptionAtPeriodEnd(email: string): Promise<{
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: string | null
}> {
  if (!isStripeConfigured()) {
    throw new Error('Stripe is not configured')
  }

  const data = await getUserData(email)
  if (!data.stripeSubscriptionId) {
    throw new Error('No active subscription found')
  }

  const stripe = getStripe()
  const sub = await stripe.subscriptions.update(data.stripeSubscriptionId, {
    cancel_at_period_end: true,
  })

  data.subscriptionStatus = sub.status
  await saveUserData(data)

  return {
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    currentPeriodEnd: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
  }
}

export async function resumeSubscription(email: string): Promise<void> {
  if (!isStripeConfigured()) {
    throw new Error('Stripe is not configured')
  }

  const data = await getUserData(email)
  if (!data.stripeSubscriptionId) {
    throw new Error('No subscription found')
  }

  const stripe = getStripe()
  const sub = await stripe.subscriptions.update(data.stripeSubscriptionId, {
    cancel_at_period_end: false,
  })

  data.subscriptionStatus = sub.status
  await saveUserData(data)
}

export async function cancelSubscriptionImmediately(email: string): Promise<void> {
  if (!isStripeConfigured()) {
    throw new Error('Stripe is not configured')
  }

  const data = await getUserData(email)
  if (!data.stripeSubscriptionId) {
    throw new Error('No active subscription found')
  }

  const stripe = getStripe()
  await stripe.subscriptions.cancel(data.stripeSubscriptionId)

  data.plan = 'free'
  data.subscriptionStatus = 'canceled'
  data.stripeSubscriptionId = undefined
  await saveUserData(data)
}
