import { NextResponse } from 'next/server'
import { getApiCatalog, getApiCatalogStats } from '@/lib/admin-api-catalog'
import { isAuthSession } from '@/lib/require-auth'
import { requireAdmin } from '@/lib/require-admin'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!isAuthSession(auth)) return auth

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    stats: getApiCatalogStats(),
    endpoints: getApiCatalog(),
  })
}
