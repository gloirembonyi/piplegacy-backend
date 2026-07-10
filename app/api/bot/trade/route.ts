/**
 * POST /api/bot/trade
 *
 * Manual trade-execution endpoint - the "Place this trade" button on the
 * Chart Analysis page. Re-runs the risk guard and routes to the chosen
 * broker. The cron scanner uses the same risk guard + broker registry but
 * iterates strategies on its own schedule.
 */

import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { rateLimit } from '@/lib/rate-limit'
import { getBotConfig, tripKillSwitch, upsertStrategy } from '@/lib/bot-config-store'
import { evaluateRiskGuard } from '@/lib/bot-risk-guard'
import { resolveBrokerForTrade } from '@/lib/brokers/registry'
import { appendTradeLog } from '@/lib/trade-log-store'
import type { TradingSetup } from '@/lib/agent/pipeline-types'
import type { BotStrategy } from '@/lib/bot-config-store'
import type { BrokerId } from '@/lib/brokers/types'

type TradeBody = {
  setup: TradingSetup
  /** When provided, the saved strategy supplies riskPct / maxConcurrent / mode. */
  strategyId?: string
  /** Otherwise the user must supply these via the UI (one-off trade). */
  overrideBrokerId?: BrokerId
  overrideMode?: 'paper' | 'live'
  overrideRiskPct?: number
}

function isLiveTradingAllowed(): boolean {
  return process.env.BOT_LIVE_TRADING_ENABLED === 'true'
}

export async function POST(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const rl = await rateLimit(`bot:trade:${auth.email}`, 30, 600)
  if (!rl.ok) {
    return Response.json({ error: 'Trade rate limit reached.' }, { status: 429 })
  }

  const body = (await req.json().catch(() => null)) as TradeBody | null
  if (!body?.setup?.symbol) {
    return Response.json({ error: 'Missing setup' }, { status: 400 })
  }

  const cfg = await getBotConfig(auth.email)
  let strategy: BotStrategy | null = null
  if (body.strategyId) {
    strategy = cfg.strategies.find((s) => s.id === body.strategyId) ?? null
    if (!strategy) {
      return Response.json({ error: 'Unknown strategyId' }, { status: 404 })
    }
  } else {
    // Build a one-off pseudo-strategy from overrides.
    strategy = {
      id: `oneoff-${Date.now()}`,
      name: `One-off ${body.setup.symbol}`,
      symbol: body.setup.symbol,
      timeframe: '1h',
      brokerId: body.overrideBrokerId ?? 'alpaca',
      mode: body.overrideMode ?? 'paper',
      enabled: true,
      confluenceThreshold: 0,
      riskPct: body.overrideRiskPct ?? body.setup.suggestedRiskPct ?? 1,
      maxConcurrent: 1,
      createdAt: new Date().toISOString(),
    }
  }

  const resolved = await resolveBrokerForTrade(
    auth.email,
    body.setup.symbol,
    body.overrideBrokerId ?? strategy.brokerId
  )
  const client = resolved.client

  if (!client) {
    await appendTradeLog(auth.email, {
      kind: 'rejected',
      strategyId: strategy?.id ?? null,
      symbol: body.setup.symbol,
      reason: resolved.reason ?? 'No broker connected for this asset class',
    })
    return Response.json(
      { error: resolved.reason ?? 'No broker connected' },
      { status: 412 }
    )
  }

  const guard = await evaluateRiskGuard({
    strategy,
    killSwitch: cfg.killSwitch,
    setup: body.setup,
    client,
    liveTradingAllowed: isLiveTradingAllowed(),
    ignoreSoftBlockers: true,
  })

  if (!guard.ok) {
    if (guard.tripKillSwitch) {
      await tripKillSwitch(auth.email, guard.reason)
    }
    await appendTradeLog(auth.email, {
      kind: 'rejected',
      strategyId: strategy.id,
      symbol: body.setup.symbol,
      reason: guard.reason,
    })
    return Response.json({ ok: false, reason: guard.reason }, { status: 412 })
  }

  try {
    const order = await client.placeOrder({
      symbol: body.setup.symbol,
      side: guard.side,
      quantity: guard.quantity,
      type: 'market',
      stopLoss: guard.stopLoss ?? undefined,
      takeProfit: guard.takeProfit ?? undefined,
      clientOrderId: `ms-${strategy.id}-${Date.now()}`,
    })
    await appendTradeLog(auth.email, {
      kind: 'placed',
      strategyId: strategy.id,
      brokerId: client.brokerId,
      mode: strategy.mode,
      symbol: body.setup.symbol,
      side: guard.side,
      quantity: guard.quantity,
      type: 'market',
      orderId: order.id,
      stopLoss: guard.stopLoss,
      takeProfit: guard.takeProfit,
    })
    if (body.strategyId) {
      await upsertStrategy(auth.email, {
        id: strategy.id,
        lastOrderAt: new Date().toISOString(),
      })
    }
    return Response.json({ ok: true, order, account: guard.account })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Order placement failed'
    await appendTradeLog(auth.email, {
      kind: 'rejected',
      strategyId: strategy.id,
      symbol: body.setup.symbol,
      reason: `Broker error: ${msg}`,
    })
    return Response.json({ error: msg }, { status: 502 })
  }
}
