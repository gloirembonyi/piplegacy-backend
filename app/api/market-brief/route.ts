import { NextResponse } from 'next/server'
import { buildMarketBrief } from '@/lib/market-brief'
import { isAuthSession, requireAuth } from '@/lib/require-auth'

export const dynamic = 'force-dynamic'
/** Brief recomputes from live quotes - Next caches for 2 minutes server-side. */
export const revalidate = 120

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  try {
    const brief = await buildMarketBrief()
    return NextResponse.json(brief)
  } catch (error) {
    console.error('market-brief error:', error)
    return NextResponse.json({ error: 'Failed to build brief' }, { status: 500 })
  }
}
