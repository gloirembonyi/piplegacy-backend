/**
 * GET /api/cron/trade-watch
 *
 * Background scan for users with Trade Watch enabled.
 * Vercel schedule is disabled in vercel.json (Hobby plan limit).
 * Re-enable via .cursor/skills/enable-vercel-crons/SKILL.md
 */

import { getUserData } from '@/lib/user-store'
import {
  pushSessionAlertsIfNeeded,
  scanWatchlistForUser,
} from '@/lib/trade-watch-scan'
import { listEmailsWithEnabledTradeWatch } from '@/lib/trade-watch-store'

const MAX_USERS_PER_TICK = 8
const TICK_DEADLINE_MS = 50_000

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
  const emails = (await listEmailsWithEnabledTradeWatch()).slice(0, MAX_USERS_PER_TICK)
  const summary: Array<{ email: string; scanned: number; alerts: number }> = []

  for (const email of emails) {
    if (Date.now() > deadline) break
    try {
      const user = await getUserData(email)
      const symbols = user.watchlist ?? []
      await pushSessionAlertsIfNeeded(email, symbols)
      const result = await scanWatchlistForUser(email, { force: true })
      summary.push({
        email,
        scanned: result.scanned,
        alerts: result.newAlerts.length,
      })
    } catch (err) {
      console.error(`cron trade-watch failed for ${email}:`, err)
    }
  }

  return Response.json({
    ok: true,
    users: summary.length,
    summary,
  })
}
