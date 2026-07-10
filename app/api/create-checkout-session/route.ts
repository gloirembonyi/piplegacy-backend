import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getExternalBaseUrl, isStripeConfigured } from '@/lib/env'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { rateLimit, getClientIp } from '@/lib/rate-limit'
import { PRICING_PLANS } from '@/lib/pricing-plans'
import { BRAND_NAME } from '@/lib/brand'

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }
  return new Stripe(secretKey, { apiVersion: '2025-09-30.clover' })
}

const CHECKOUT_PRICING = {
  starter: { monthly: 2900, annual: 29000 },
  pro: { monthly: 7900, annual: 79000 },
} as const

export async function POST(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const ipLimit = await rateLimit(`checkout:${getClientIp(request)}`, 15, 3600)
  if (!ipLimit.ok) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  if (!isStripeConfigured()) {
    return NextResponse.json(
      {
        error:
          'Stripe is not configured. Add STRIPE_SECRET_KEY and NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY to .env.local (use test keys from dashboard.stripe.com/test/apikeys).',
      },
      { status: 503 }
    )
  }

  try {
    const stripe = getStripe()
    const { planId, isAnnual } = await request.json()

    if (!planId || !(planId in CHECKOUT_PRICING)) {
      return NextResponse.json(
        { error: 'Invalid plan. Choose starter or pro.' },
        { status: 400 }
      )
    }

    const planMeta = PRICING_PLANS.find((p) => p.id === planId)
    const plan = CHECKOUT_PRICING[planId as keyof typeof CHECKOUT_PRICING]
    const amount = plan[isAnnual ? 'annual' : 'monthly']
    const interval = isAnnual ? 'year' : 'month'
    const baseUrl = getExternalBaseUrl(request)

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: auth.email,
      client_reference_id: auth.email,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${BRAND_NAME} ${planMeta?.name ?? planId} Plan`,
              description: `${isAnnual ? 'Annual' : 'Monthly'} subscription`,
            },
            unit_amount: amount,
            recurring: { interval: interval as 'month' | 'year' },
          },
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pricing`,
      metadata: {
        planId: String(planId),
        isAnnual: String(Boolean(isAnnual)),
        userEmail: auth.email,
      },
      subscription_data: {
        metadata: {
          planId: String(planId),
          userEmail: auth.email,
        },
      },
    })

    return NextResponse.json({
      sessionId: session.id,
      url: session.url,
    })
  } catch (error) {
    console.error('Error creating checkout session:', error)
    const message =
      error instanceof Error ? error.message : 'Failed to create checkout session'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
