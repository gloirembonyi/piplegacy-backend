/**
 * GET /api/cron/trigger-pending
 *
 * Optional cron entrypoint for armed setups. Not scheduled on Vercel Hobby
 * (daily cron limit). The UI polls /api/bot/pending/check every 15s, and
 * /api/cron/scan also sweeps pending setups on its daily tick. Add a
 * per-minute cron on Vercel Pro for server-side triggers.
 */

import { listEmailsWithActivePending } from '@/lib/pending-setup-store'
import { processPendingSetupsForUser } from '@/lib/pending-setup-engine'

const TICK_DEADLINE_MS = 45_000
const MAX_USERS_PER_TICK = 20

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') ?? ''
  return auth === `Bearer ${secret}`
}

function isLiveTradingAllowed(): boolean {
  return process.env.BOT_LIVE_TRADING_ENABLED === 'true'
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const deadline = Date.now() + TICK_DEADLINE_MS
  const emails = (await listEmailsWithActivePending()).slice(0, MAX_USERS_PER_TICK)
  const summary: Array<{ email: string; results: number; filled: number }> = []

  for (const email of emails) {
    if (Date.now() > deadline) break
    try {
      const results = await processPendingSetupsForUser(email, isLiveTradingAllowed())
      summary.push({
        email,
        results: results.length,
        filled: results.filter((r) => r.outcome === 'filled').length,
      })
    } catch (err) {
      console.error(`trigger-pending failed for ${email}:`, err)
    }
  }

  return Response.json({
    ok: true,
    users: emails.length,
    summary,
    elapsedMs: Date.now() - (deadline - TICK_DEADLINE_MS),
  })
}
