/**
 * POST /api/bot/pending/check
 *
 * Client poll endpoint - checks armed setups against live price and
 * executes any that hit entry. Works in local dev without Vercel cron.
 */

import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { processPendingSetupsForUser } from '@/lib/pending-setup-engine'
import { listPendingSetups } from '@/lib/pending-setup-store'

function isLiveTradingAllowed(): boolean {
  return process.env.BOT_LIVE_TRADING_ENABLED === 'true'
}

export async function POST(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const armed = await listPendingSetups(auth.email, { status: 'armed' })
  if (armed.length === 0) {
    return Response.json({ ok: true, results: [], setups: [] })
  }

  const results = await processPendingSetupsForUser(auth.email, isLiveTradingAllowed())
  const setups = await listPendingSetups(auth.email, { status: 'active' })

  return Response.json({ ok: true, results, setups })
}
