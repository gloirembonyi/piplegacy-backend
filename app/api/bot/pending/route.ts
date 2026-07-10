/**
 * GET  /api/bot/pending - list armed / recent pending setups
 * POST /api/bot/pending - arm a setup (wait for entry price)
 */

import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { rateLimit } from '@/lib/rate-limit'
import { getPlanLimits } from '@/lib/plan-limits'
import { getUserData } from '@/lib/user-store'
import { armPendingSetup, listPendingSetups } from '@/lib/pending-setup-store'
import { fetchYahooQuote } from '@/lib/candle-providers/yahoo'
import { processPendingSetupsForUser } from '@/lib/pending-setup-engine'
import { pickPreferredBrokerId } from '@/lib/brokers/symbol-support'
import { getBrokerCredential } from '@/lib/broker-store'
import type { TradingSetup } from '@/lib/agent/pipeline-types'
import type { BrokerId } from '@/lib/brokers/types'

type ArmBody = {
  setup: TradingSetup
  brokerId?: BrokerId
  riskPct?: number
}

function isLiveTradingAllowed(): boolean {
  return process.env.BOT_LIVE_TRADING_ENABLED === 'true'
}

export async function GET(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const url = new URL(req.url)
  const activeOnly = url.searchParams.get('active') === '1'
  const setups = await listPendingSetups(
    auth.email,
    activeOnly ? { status: 'active' } : {}
  )
  return Response.json({ setups })
}

export async function POST(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const rl = await rateLimit(`bot:pending:arm:${auth.email}`, 30, 600)
  if (!rl.ok) {
    return Response.json({ error: 'Rate limit reached.' }, { status: 429 })
  }

  const user = await getUserData(auth.email)
  const limits = getPlanLimits(user.plan)
  if (!limits.autoTrader || limits.pendingSetupsMax === 0) {
    return Response.json(
      {
        error: 'Pending setups require a paid plan. Upgrade at /pricing.',
        upgradeRequired: true,
      },
      { status: 403 }
    )
  }

  const body = (await req.json().catch(() => null)) as ArmBody | null
  if (!body?.setup?.symbol || body.setup.bias === 'HOLD') {
    return Response.json({ error: 'Invalid setup - need BUY/SELL with entry/stop' }, { status: 400 })
  }
  if (body.setup.entry == null || body.setup.stopLoss == null) {
    return Response.json({ error: 'Entry and stop loss required' }, { status: 400 })
  }

  const connected: BrokerId[] = []
  if (await getBrokerCredential(auth.email, 'alpaca')) connected.push('alpaca')
  if (await getBrokerCredential(auth.email, 'oanda')) connected.push('oanda')

  const brokerId =
    body.brokerId && connected.includes(body.brokerId)
      ? body.brokerId
      : pickPreferredBrokerId(body.setup.symbol, connected)

  if (!brokerId) {
    return Response.json(
      { error: 'No compatible broker connected for this symbol' },
      { status: 412 }
    )
  }

  let armedPrice: number | null = null
  try {
    const q = await fetchYahooQuote(body.setup.symbol)
    armedPrice = q?.price ?? null
  } catch {
    /* optional */
  }

  let pending
  try {
    pending = await armPendingSetup(auth.email, {
      setup: body.setup,
      brokerId,
      mode: 'paper',
      riskPct: body.riskPct ?? body.setup.suggestedRiskPct,
      armedPrice,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'PLAN_UPGRADE_REQUIRED') {
      return Response.json(
        { error: 'Pending setups require a paid plan. Upgrade at /pricing.', upgradeRequired: true },
        { status: 403 }
      )
    }
    if (msg === 'PENDING_SETUP_LIMIT') {
      return Response.json(
        {
          error: `You can arm up to ${limits.pendingSetupsMax} setups on your plan. Upgrade at /pricing.`,
          upgradeRequired: true,
        },
        { status: 429 }
      )
    }
    throw err
  }

  // If price is already at entry, try to fill immediately.
  const results = await processPendingSetupsForUser(auth.email, isLiveTradingAllowed())
  const mine = results.find((r) => r.id === pending.id)

  const refreshed = (await listPendingSetups(auth.email, { status: 'active' })).find(
    (s) => s.id === pending.id
  )

  return Response.json({
    ok: true,
    pending: refreshed ?? pending,
    trigger: mine ?? null,
  })
}
