export type PricingPlan = {
  id: 'starter' | 'pro' | 'enterprise'
  name: string
  description: string
  price: number
  yearlyPrice: number
  buttonText: string
  popular?: boolean
  includes: string[]
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    description:
      'Perfect for beginners looking to get started with AI trading signals.',
    price: 29,
    yearlyPrice: 290,
    buttonText: 'Subscribe Now',
    includes: [
      "What's included:",
      '30 AI agent chats per day',
      '15 chart analyses per day',
      '5 auto-trader scans per day',
      '3 armed pending setups',
      '15-symbol watchlist',
      'Paper trading only',
    ],
  },
  {
    id: 'pro',
    name: 'Professional',
    description:
      'Best value for active traders who need advanced AI features.',
    price: 79,
    yearlyPrice: 790,
    buttonText: 'Subscribe Now',
    popular: true,
    includes: [
      'Everything in Starter, plus:',
      'Unlimited AI agent chats',
      'Unlimited chart analyses',
      '50 auto-trader scans per day',
      '20 armed pending setups',
      '50-symbol watchlist',
      'Live broker trading (when enabled)',
      'AI suggestion refresh',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description:
      'Advanced plan with enhanced security and unlimited access for institutions.',
    price: 199,
    yearlyPrice: 1990,
    buttonText: 'Contact Sales',
    includes: [
      'Everything in Professional, plus:',
      'Unlimited API access',
      'White-label solution',
      'Dedicated account manager',
      'Custom integrations',
      'Advanced analytics',
      'Team collaboration tools',
      'Priority feature requests',
      'SLA guarantee',
      'Custom data feeds',
    ],
  },
]
