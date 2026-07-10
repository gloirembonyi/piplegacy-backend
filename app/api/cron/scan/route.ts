/**
 * GET /api/cron/scan
 *
 * Vercel Cron entrypoint. Schedule lives in vercel.json (currently disabled;
 * see vercel.crons.reference.json and enable-vercel-crons skill).
 *
 * For each user with an active bot config:
 *   for each enabled strategy:
 *     if `lastScanAt` is older than the timeframe cadence:
 *       run the multi-agent pipeline (fast mode)
 *       hand the setup to the risk guard
 *       if approved → place order via broker
 *       log everything
 *
 * Gated by `CRON_SECRET` (Vercel Cron sends it as `Authorization: Bearer ...`).
 * Per-tick budget is ~50s - we cap how many strategies we scan per run so a
 * cold start doesn't blow past Vercel's function timeout.
 */

import { runPipeline } from '@/lib/agent/pipeline'
import { evaluateRiskGuard } from '@/lib/bot-risk-guard'
import {
  getBotConfig,
  tfCadenceMinutes,
  tripKillSwitch,
  upsertStrategy,
} from '@/lib/bot-config-store'
import { getBrokerForUser } from '@/lib/brokers/registry'
import { listAllBotConfigEmails } from '@/lib/bot-discovery'
import { processPendingSetupsForUser } from '@/lib/pending-setup-engine'
import { listEmailsWithActivePending } from '@/lib/pending-setup-store'
import { appendTradeLog } from '@/lib/trade-log-store'

const MAX_STRATEGIES_PER_TICK = 6
const TICK_DEADLINE_MS = 50_000

function isLiveTradingAllowed(): boolean {
  return process.env.BOT_LIVE_TRADING_ENABLED === 'true'
}

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') ?? ''
  return auth === `Bearer ${secret}`
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const deadline = Date.now() + TICK_DEADLINE_MS
  const emails = await listAllBotConfigEmails()
  const tickResults: Array<{
    email: string
    strategyId: string
    symbol: string
    outcome: string
  }> = []

  let executed = 0
  const now = new Date()

  outer: for (const email of emails) {
    if (Date.now() > deadline) break
    const cfg = await getBotConfig(email)
    if (cfg.strategies.length === 0) continue

    for (const strategy of cfg.strategies) {
      if (executed >= MAX_STRATEGIES_PER_TICK) break outer
      if (Date.now() > deadline) break outer
      if (!strategy.enabled) continue

      // Cadence: only scan if enough time has passed since the last scan.
      const cadenceMs = tfCadenceMinutes(strategy.timeframe) * 60_000
      const lastScan = strategy.lastScanAt ? Date.parse(strategy.lastScanAt) : 0
      if (Number.isFinite(lastScan) && now.getTime() - lastScan < cadenceMs) continue

      executed++

      try {
        const result = await runPipeline({
          symbol: strategy.symbol,
          timeframe: strategy.timeframe,
          riskBudgetPct: strategy.riskPct,
          fast: true,
        })

        await upsertStrategy(email, {
          id: strategy.id,
          lastScanAt: new Date().toISOString(),
        })
        await appendTradeLog(email, {
          kind: 'scan',
          strategyId: strategy.id,
          symbol: strategy.symbol,
          timeframe: strategy.timeframe,
          confluenceScore: result.setup.confluenceScore,
          bias: result.setup.bias,
          durationMs: result.durationMs,
        })

        if (result.setup.bias === 'HOLD') {
          tickResults.push({
            email,
            strategyId: strategy.id,
            symbol: strategy.symbol,
            outcome: `HOLD (${result.setup.confluenceScore})`,
          })
          continue
        }

        const client = await getBrokerForUser(email, strategy.brokerId)
        if (!client) {
          await appendTradeLog(email, {
            kind: 'rejected',
            strategyId: strategy.id,
            symbol: strategy.symbol,
            reason: `Broker ${strategy.brokerId} not connected`,
          })
          continue
        }

        const guard = await evaluateRiskGuard({
          strategy,
          killSwitch: cfg.killSwitch,
          setup: result.setup,
          client,
          liveTradingAllowed: isLiveTradingAllowed(),
        })

        if (!guard.ok) {
          if (guard.tripKillSwitch) {
            await tripKillSwitch(email, guard.reason)
          }
          await appendTradeLog(email, {
            kind: 'rejected',
            strategyId: strategy.id,
            symbol: strategy.symbol,
            reason: guard.reason,
          })
          tickResults.push({
            email,
            strategyId: strategy.id,
            symbol: strategy.symbol,
            outcome: `REJECT: ${guard.reason.slice(0, 80)}`,
          })
          continue
        }

        const order = await client.placeOrder({
          symbol: strategy.symbol,
          side: guard.side,
          quantity: guard.quantity,
          type: 'market',
          stopLoss: guard.stopLoss ?? undefined,
          takeProfit: guard.takeProfit ?? undefined,
          clientOrderId: `cron-${strategy.id}-${Date.now()}`,
        })

        await appendTradeLog(email, {
          kind: 'placed',
          strategyId: strategy.id,
          brokerId: client.brokerId,
          mode: strategy.mode,
          symbol: strategy.symbol,
          side: guard.side,
          quantity: guard.quantity,
          type: 'market',
          orderId: order.id,
          stopLoss: guard.stopLoss,
          takeProfit: guard.takeProfit,
        })
        await upsertStrategy(email, {
          id: strategy.id,
          lastOrderAt: new Date().toISOString(),
        })
        tickResults.push({
          email,
          strategyId: strategy.id,
          symbol: strategy.symbol,
          outcome: `FILL ${guard.side} ${guard.quantity}`,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await appendTradeLog(email, {
          kind: 'rejected',
          strategyId: strategy.id,
          symbol: strategy.symbol,
          reason: `Cron pipeline error: ${msg}`,
        })
        tickResults.push({
          email,
          strategyId: strategy.id,
          symbol: strategy.symbol,
          outcome: `ERROR: ${msg.slice(0, 80)}`,
        })
      }
    }
  }

  let pendingFilled = 0
  try {
    const pendingEmails = (await listEmailsWithActivePending()).slice(0, 10)
    for (const email of pendingEmails) {
      if (Date.now() > deadline) break
      const results = await processPendingSetupsForUser(email, isLiveTradingAllowed())
      pendingFilled += results.filter((r) => r.outcome === 'filled').length
    }
  } catch (err) {
    console.error('cron scan: pending trigger sweep failed', err)
  }

  return Response.json({
    ok: true,
    executed,
    emails: emails.length,
    pendingFilled,
    results: tickResults,
    elapsedMs: Date.now() - (deadline - TICK_DEADLINE_MS),
  })
}
