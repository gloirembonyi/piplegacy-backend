import { NextResponse } from 'next/server'
import { buildMarketIdeas } from '@/lib/market-ideas'
import { isAuthSession, requireAuth } from '@/lib/require-auth'

export const dynamic = 'force-dynamic'
/** Revalidate every 5 minutes - ideas are aggregated from upstream sources. */
export const revalidate = 300

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  try {
    const ideas = await buildMarketIdeas()
    return NextResponse.json({
      ideas,
      count: ideas.length,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('market-ideas error:', error)
    return NextResponse.json(
      { ideas: [], count: 0, error: 'Failed to load market ideas' },
      { status: 500 }
    )
  }
}
