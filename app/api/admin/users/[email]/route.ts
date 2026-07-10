import { NextResponse } from 'next/server'
import { adminSetUserPlan } from '@/lib/admin-users'
import { normalizePlanId } from '@/lib/plan-limits'
import { isAuthSession } from '@/lib/require-auth'
import { requireAdmin } from '@/lib/require-admin'

export const dynamic = 'force-dynamic'

const ALLOWED_PLANS = new Set(['free', 'starter', 'pro', 'enterprise'])

export async function PATCH(
  request: Request,
  context: { params: Promise<{ email: string }> }
) {
  const auth = await requireAdmin(request)
  if (!isAuthSession(auth)) return auth

  const { email: rawEmail } = await context.params
  const email = decodeURIComponent(rawEmail).trim().toLowerCase()
  if (!email.includes('@')) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const plan =
    typeof body === 'object' && body !== null && 'plan' in body
      ? normalizePlanId(String((body as { plan: unknown }).plan))
      : null

  if (!plan || !ALLOWED_PLANS.has(plan)) {
    return NextResponse.json(
      { error: 'Invalid plan. Use free, starter, pro, or enterprise.' },
      { status: 400 }
    )
  }

  const result = await adminSetUserPlan(email, plan)
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Update failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, email, plan })
}
