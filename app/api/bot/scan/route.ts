/**
 * POST /api/bot/scan
 *
 * Runs the multi-agent pipeline for a single symbol and streams pipeline
 * events back as NDJSON. Same wire format used by the Insights chat panel
 * (`lib/agent-stream.ts`) so the UI can reuse the streaming reader.
 *
 * This is the *manual* path - the cron scheduler calls `runPipeline` directly.
 */

import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { rateLimit } from '@/lib/rate-limit'
import { consumePlanUsage } from '@/lib/plan-usage'
import { getPlanLimits } from '@/lib/plan-limits'
import { getUserData } from '@/lib/user-store'
import { appendTradeLog } from '@/lib/trade-log-store'
import { armPendingSetup } from '@/lib/pending-setup-store'
import { processPendingSetupsForUser } from '@/lib/pending-setup-engine'
import { fetchYahooQuote } from '@/lib/candle-providers/yahoo'
import { pickPreferredBrokerId } from '@/lib/brokers/symbol-support'
import { getBrokerCredential } from '@/lib/broker-store'
import { isValidSymbol } from '@/lib/symbols'
import type { BrokerId } from '@/lib/brokers/types'

function isLiveTradingAllowed(): boolean {
  return process.env.BOT_LIVE_TRADING_ENABLED === 'true'
}

type ScanBody = {
  symbol?: string
  timeframe?: string
  riskBudgetPct?: number
  fast?: boolean
  strategyId?: string
}

export async function POST(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const user = await getUserData(auth.email)
  const limits = getPlanLimits(user.plan)
  if (!limits.autoTrader) {
    return Response.json(
      {
        error: 'Auto-trader scans require a paid plan. Upgrade at /pricing.',
        upgradeRequired: true,
      },
      { status: 403 }
    )
  }

  const scanLimit = await consumePlanUsage(auth.email, user.plan, 'botScanDay')
  if (!scanLimit.ok) {
    return Response.json(
      { error: scanLimit.message ?? 'Scan limit reached.', upgradeRequired: scanLimit.upgradeRequired },
      { status: 429 }
    )
  }

  const rl = await rateLimit(`bot:scan:${auth.email}`, 60, 600)
  if (!rl.ok) {
    return Response.json({ error: 'Scan rate limit reached.' }, { status: 429 })
  }

  const body = (await req.json().catch(() => null)) as ScanBody | null
  if (!body?.symbol || !isValidSymbol(body.symbol)) {
    return Response.json({ error: 'Missing or invalid symbol' }, { status: 400 })
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const write = (obj: unknown) => {
        controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'))
      }

      try {
        const { runPipelineStreaming } = await import('@/lib/agent/pipeline')
        const gen = runPipelineStreaming({
          symbol: body.symbol!,
          timeframe: body.timeframe,
          riskBudgetPct: body.riskBudgetPct,
          fast: body.fast,
        })
        for await (const event of gen) {
          write(event)
          if (event.type === 'done') {
            // Audit-log the manual scan
            try {
              await appendTradeLog(auth.email, {
                kind: 'scan',
                strategyId: body.strategyId ?? 'manual',
                symbol: event.result.symbol,
                timeframe: event.result.timeframe,
                confluenceScore: event.result.setup.confluenceScore,
                bias: event.result.setup.bias,
                durationMs: event.result.durationMs,
              })
              if (event.result.setup.bias !== 'HOLD') {
                await appendTradeLog(auth.email, {
                  kind: 'proposed',
                  strategyId: body.strategyId ?? 'manual',
                  symbol: event.result.symbol,
                  timeframe: event.result.timeframe,
                  bias: event.result.setup.bias,
                  entry: event.result.setup.entry,
                  stopLoss: event.result.setup.stopLoss,
                  takeProfit: event.result.setup.takeProfit,
                  confluenceScore: event.result.setup.confluenceScore,
                  reasoning: event.result.setup.reasoning,
                })

                // Auto-arm: save setup and wait for price to reach entry.
                if (
                  event.result.setup.entry != null &&
                  event.result.setup.stopLoss != null
                ) {
                  try {
                    const connected: BrokerId[] = []
                    if (await getBrokerCredential(auth.email, 'alpaca')) {
                      connected.push('alpaca')
                    }
                    if (await getBrokerCredential(auth.email, 'oanda')) {
                      connected.push('oanda')
                    }
                    const brokerId = pickPreferredBrokerId(
                      event.result.setup.symbol,
                      connected
                    )
                    if (brokerId) {
                      let armedPrice: number | null = null
                      try {
                        const q = await fetchYahooQuote(event.result.setup.symbol)
                        armedPrice = q?.price ?? null
                      } catch {
                        /* optional */
                      }
                      const pending = await armPendingSetup(auth.email, {
                        setup: event.result.setup,
                        brokerId,
                        mode: 'paper',
                        riskPct: body.riskBudgetPct,
                        strategyId: body.strategyId ?? 'manual',
                        armedPrice,
                      })
                      write({
                        type: 'pending_armed',
                        pending,
                      })
                      await processPendingSetupsForUser(
                        auth.email,
                        isLiveTradingAllowed()
                      )
                    }
                  } catch (armErr) {
                    console.error('Auto-arm pending failed:', armErr)
                  }
                }
              }
            } catch (err) {
              console.error('Trade log append failed:', err)
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Pipeline failed'
        write({ type: 'error', error: msg })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
