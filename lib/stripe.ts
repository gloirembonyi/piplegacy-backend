import { loadStripe } from '@stripe/stripe-js'

const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY

const stripePromise = publishableKey
  ? loadStripe(publishableKey).catch((err) => {
      console.warn('[stripe] Failed to load Stripe.js:', err)
      return null
    })
  : Promise.resolve(null)

export async function createCheckoutSession(planId: string, isAnnual: boolean) {
  const response = await fetch('/api/create-checkout-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ planId, isAnnual }),
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create checkout session')
  }

  if (data.url) {
    window.location.href = data.url
    return
  }

  const { sessionId } = data
  if (!sessionId) {
    throw new Error(data.error || 'Failed to create checkout session')
  }

  const stripe = await stripePromise
  if (!stripe) {
    throw new Error(
      'Stripe is not configured. Add NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY to .env.local'
    )
  }

  const { error } = await stripe.redirectToCheckout({ sessionId })
  if (error) {
    throw new Error(error.message)
  }
}
