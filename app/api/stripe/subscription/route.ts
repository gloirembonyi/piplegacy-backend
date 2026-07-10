import { NextResponse } from 'next/server'
import { isStripeConfigured } from '@/lib/env'
import { getPlanFeatures } from '@/lib/plan-features'
import { getPlanLimits, normalizePlanId } from '@/lib/plan-limits'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { getUserData } from '@/lib/user-store'
import { getPlanUsageSummary } from '@/lib/plan-usage'
import { getUserLastAiCall } from '@/lib/ai-usage-tracker'
import { rateLimit, getClientIp } from '@/lib/rate-limit'
import {
  cancelSubscriptionAtPeriodEnd,
  cancelSubscriptionImmediately,
  getSubscriptionDetails,
  resumeSubscription,
  syncUserSubscription,
} from '@/lib/stripe-subscription'

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  try {
    await syncUserSubscription(auth.email, { force: true })
    const data = await getUserData(auth.email)
    const plan = normalizePlanId(data.plan)
    const limits = getPlanLimits(plan)
    const features = getPlanFeatures(plan)
    const usage = await getPlanUsageSummary(auth.email, plan)
    const subscription = await getSubscriptionDetails(auth.email)
    const lastAiCall = await getUserLastAiCall(auth.email)

    return NextResponse.json({
      email: auth.email,
      name: auth.name,
      plan,
      planLabel: limits.label,
      limits,
      features,
      usage,
      lastAiCall,
      subscriptionStatus: data.subscriptionStatus ?? null,
      planActivatedAt: data.planActivatedAt ?? null,
      stripeSubscriptionId: data.stripeSubscriptionId ?? null,
      subscription,
    })
  } catch (error) {
    console.error('Subscription GET error:', error)
    return NextResponse.json({ error: 'Failed to load subscription' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const ipLimit = await rateLimit(`stripe-sub:${getClientIp(request)}`, 8, 3600)
  if (!ipLimit.ok) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  if (!isStripeConfigured()) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })
  }

  try {
    const body = await request.json()
    const action = body?.action as string

    if (action === 'cancel') {
      const result = await cancelSubscriptionAtPeriodEnd(auth.email)
      return NextResponse.json({ ok: true, ...result })
    }

    if (action === 'cancel_immediate') {
      await cancelSubscriptionImmediately(auth.email)
      return NextResponse.json({ ok: true, plan: 'free', subscriptionStatus: 'canceled' })
    }

    if (action === 'resume') {
      await resumeSubscription(auth.email)
      const subscription = await getSubscriptionDetails(auth.email)
      return NextResponse.json({ ok: true, subscription })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Subscription POST error:', error)
    const message = error instanceof Error ? error.message : 'Subscription update failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
