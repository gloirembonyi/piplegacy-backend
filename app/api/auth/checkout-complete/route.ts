import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { isStripeConfigured } from '@/lib/env'
import { getPlanFeatures } from '@/lib/plan-features'
import { getPlanLimits, normalizePlanId } from '@/lib/plan-limits'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { getUserData } from '@/lib/user-store'
import { markStripeSessionRedeemed } from '@/lib/stripe-redeem'
import {
  applyCheckoutToUser,
  planFromCheckoutMetadata,
  syncUserSubscription,
} from '@/lib/stripe-subscription'
import { rateLimit, getClientIp } from '@/lib/rate-limit'

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured')
  return new Stripe(secretKey, { apiVersion: '2025-09-30.clover' })
}

function isCheckoutPaid(session: Stripe.Checkout.Session): boolean {
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
    return true
  }
  if (session.status === 'complete' && session.mode === 'subscription') {
    return true
  }
  return false
}

function buildSuccessPayload(
  authEmail: string,
  session: Stripe.Checkout.Session,
  planId: string,
  alreadyProcessed: boolean
) {
  const plan = normalizePlanId(planId)
  const limits = getPlanLimits(plan)
  const features = getPlanFeatures(plan)

  return {
    success: true,
    alreadyProcessed,
    email: authEmail,
    planId: plan,
    planLabel: limits.label,
    limits,
    features,
    isAnnual: session.metadata?.isAnnual === 'true',
    amountTotal: session.amount_total ?? null,
    currency: session.currency ?? 'usd',
    customerEmail: session.customer_email ?? authEmail,
    subscriptionId:
      typeof session.subscription === 'string' ? session.subscription : null,
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const ipLimit = await rateLimit(`checkout-complete:${getClientIp(request)}`, 10, 3600)
  if (!ipLimit.ok) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  try {
    if (!isStripeConfigured()) {
      return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })
    }

    const { sessionId } = await request.json()
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
      return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 })
    }

    const stripe = getStripe()
    const session = await stripe.checkout.sessions.retrieve(sessionId)

    if (!isCheckoutPaid(session)) {
      return NextResponse.json({ error: 'Payment not completed' }, { status: 400 })
    }

    const created = session.created ? session.created * 1000 : 0
    if (created && Date.now() - created > 1000 * 60 * 60 * 48) {
      return NextResponse.json({ error: 'Checkout session expired' }, { status: 400 })
    }

    const ownerEmail = session.client_reference_id?.trim().toLowerCase()
    if (!ownerEmail || ownerEmail !== auth.email) {
      return NextResponse.json(
        {
          error:
            'This payment does not belong to your account. Sign in with the email used at checkout.',
        },
        { status: 403 }
      )
    }

    const planId = planFromCheckoutMetadata(session.metadata?.planId)

    // Apply plan first so a failed save can be retried on refresh.
    await applyCheckoutToUser(
      auth.email,
      planId,
      typeof session.customer === 'string' ? session.customer : null,
      typeof session.subscription === 'string' ? session.subscription : null
    )

    await syncUserSubscription(auth.email, { force: true })

    const firstRedeem = await markStripeSessionRedeemed(sessionId)
    const data = await getUserData(auth.email)
    const activePlan = normalizePlanId(data.plan ?? planId)

    return NextResponse.json(
      buildSuccessPayload(auth.email, session, activePlan, !firstRedeem)
    )
  } catch (error) {
    console.error('Checkout complete error:', error)
    return NextResponse.json({ error: 'Failed to verify payment' }, { status: 500 })
  }
}
