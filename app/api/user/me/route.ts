import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { getUserData } from '@/lib/user-store'
import { getPlanFeatures } from '@/lib/plan-features'
import { getPlanLimits, normalizePlanId } from '@/lib/plan-limits'
import { getPlanUsageSummary } from '@/lib/plan-usage'
import { initAdminSystem, isUserAdmin, isUserSuperAdmin } from '@/lib/admin'
import { syncUserSubscription } from '@/lib/stripe-subscription'

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  try {
    await syncUserSubscription(auth.email)
    await initAdminSystem()
    const data = await getUserData(auth.email)
    const plan = normalizePlanId(data.plan)
    const conversations = Object.values(data.conversations ?? {})
    const totalConversationMessages = conversations.reduce(
      (n, c) => n + (c.messages?.length ?? 0),
      0
    )
    const usage = await getPlanUsageSummary(auth.email, plan)
    const limits = getPlanLimits(plan)
    const features = getPlanFeatures(plan)

    return NextResponse.json({
      email: auth.email,
      name: auth.name,
      watchlist: data.watchlist,
      favorites: data.favorites ?? [],
      plan,
      planLabel: limits.label,
      limits,
      features,
      usage,
      subscriptionStatus: data.subscriptionStatus ?? null,
      planActivatedAt: data.planActivatedAt ?? null,
      stripeSubscriptionId: data.stripeSubscriptionId ?? null,
      analysisCount: data.analyses.length,
      conversationCount: conversations.length,
      conversationMessages: totalConversationMessages,
      preferences: data.preferences ?? {},
      createdAt: data.createdAt ?? data.updatedAt,
      updatedAt: data.updatedAt,
      isAdmin: await isUserAdmin(auth.email),
      isSuperAdmin: await isUserSuperAdmin(auth.email),
    })
  } catch {
    return NextResponse.json({ error: 'Failed to load profile' }, { status: 500 })
  }
}
