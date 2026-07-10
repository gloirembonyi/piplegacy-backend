/**
 * DELETE /api/bot/pending/[id] - cancel an armed setup
 */

import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { cancelPendingSetup } from '@/lib/pending-setup-store'

type Ctx = { params: Promise<{ id: string }> }

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const { id } = await ctx.params
  const cancelled = await cancelPendingSetup(auth.email, id)
  if (!cancelled) {
    return Response.json({ error: 'Pending setup not found' }, { status: 404 })
  }
  return Response.json({ ok: true, pending: cancelled })
}
