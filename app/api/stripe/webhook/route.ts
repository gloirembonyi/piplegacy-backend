import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { isStripeConfigured } from '@/lib/env'
import { getUserData, saveUserData } from '@/lib/user-store'
import { normalizePlanId, type PlanId } from '@/lib/plan-limits'
import { applyCheckoutToUser } from '@/lib/stripe-subscription'

export const dynamic = 'force-dynamic'

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured')
  return new Stripe(secretKey, { apiVersion: '2025-09-30.clover' })
}

async function findUserByStripeCustomer(customerId: string): Promise<string | null> {
  // Webhook path: scan is expensive without an index; subscription metadata carries email.
  void customerId
  return null
}

async function applyPlanByEmail(
  email: string,
  plan: string,
  stripeCustomerId?: string | null,
  stripeSubscriptionId?: string | null
) {
  const planId = normalizePlanId(plan) as PlanId
  if (planId === 'free') {
    const data = await getUserData(email)
    data.plan = 'free'
    data.subscriptionStatus = 'canceled'
    if (stripeCustomerId) data.stripeCustomerId = stripeCustomerId
    data.stripeSubscriptionId = undefined
    await saveUserData(data)
    return
  }
  await applyCheckoutToUser(email, planId, stripeCustomerId, stripeSubscriptionId)
}

export async function POST(request: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim()
  if (!webhookSecret) {
    return NextResponse.json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' }, { status: 503 })
  }

  const stripe = getStripe()
  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
  }

  const body = await request.text()
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid signature'
    return NextResponse.json({ error: message }, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const email =
          session.client_reference_id?.trim().toLowerCase() ||
          session.metadata?.userEmail?.trim().toLowerCase() ||
          session.customer_email?.trim().toLowerCase()
        if (!email) break
        const planId = session.metadata?.planId ?? 'pro'
        await applyPlanByEmail(
          email,
          planId,
          typeof session.customer === 'string' ? session.customer : null,
          typeof session.subscription === 'string' ? session.subscription : null
        )
        break
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        const email = sub.metadata?.userEmail?.trim().toLowerCase()
        const planId = sub.metadata?.planId
        if (email && planId && (sub.status === 'active' || sub.status === 'trialing')) {
          await applyPlanByEmail(email, planId, String(sub.customer), sub.id)
        }
        break
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        const email = sub.metadata?.userEmail?.trim().toLowerCase()
        if (email) {
          await applyPlanByEmail(email, 'free', String(sub.customer), null)
        } else if (typeof sub.customer === 'string') {
          const found = await findUserByStripeCustomer(sub.customer)
          if (found) await applyPlanByEmail(found, 'free', sub.customer, null)
        }
        break
      }
      default:
        break
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('Stripe webhook error:', error)
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 })
  }
}
