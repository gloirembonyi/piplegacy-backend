import { NextResponse } from 'next/server'
import { getAiConfigStatus } from '@/lib/ai-config'
import { runAiHealthCheck } from '@/lib/ai-health'
import { buildAdminUsageReport } from '@/lib/ai-admin-metrics'
import { aggregateUserStats, countKvUsers, listAdminUsers } from '@/lib/admin-users'
import { initAdminSystem, isAdminConfiguredAsync, listAdmins } from '@/lib/admin'
import { isAuthStorageConfigured, isSessionConfigured, isStripeConfigured } from '@/lib/env'
import { isAuthSession } from '@/lib/require-auth'
import { requireAdmin } from '@/lib/require-admin'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!isAuthSession(auth)) return auth

  await initAdminSystem()

  const [users, aiHealth, kvUserCount, admins, usage] = await Promise.all([
    listAdminUsers(),
    runAiHealthCheck({ probeLive: false }),
    countKvUsers(),
    listAdmins(),
    buildAdminUsageReport(),
  ])

  const stats = aggregateUserStats(users)
  const aiConfig = getAiConfigStatus()

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    deployment: {
      vercel: Boolean(process.env.VERCEL),
      region: process.env.VERCEL_REGION ?? null,
      nodeEnv: process.env.NODE_ENV,
    },
    config: {
      adminConfigured: await isAdminConfiguredAsync(),
      sessionConfigured: isSessionConfigured(),
      authStorageConfigured: isAuthStorageConfigured(),
      stripeConfigured: isStripeConfigured(),
      ai: aiConfig,
    },
    users: stats,
    kvUserCount,
    admins: { count: admins.length, superCount: admins.filter((a) => a.role === 'super').length },
    ai: aiHealth,
    usage: {
      platform: usage.platform,
      geminiDailyBudgetPerKey: usage.geminiDailyBudgetPerKey,
      topUsersToday: usage.topUsersToday,
      keyCount: usage.keys.length,
      deepseekTotalBalance: usage.deepseekBalances
        .filter((b) => b.ok && b.primaryDisplay)
        .map((b) => b.primaryDisplay)
        .join(' · ') || null,
    },
    adminEmail: auth.email,
  })
}
