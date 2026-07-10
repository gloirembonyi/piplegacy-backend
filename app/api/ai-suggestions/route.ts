import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { getUserData } from '@/lib/user-store'
import { rateLimit, getClientIp } from '@/lib/rate-limit'
import { getPlanLimits } from '@/lib/plan-limits'
import { buildAiSuggestions } from '@/lib/ai-suggestions'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const { searchParams } = new URL(request.url)
  const force = searchParams.get('refresh') === '1'

  // Forced refresh is cheap-but-not-free - cap to 4/min per user.
  if (force) {
    const user = await getUserData(auth.email)
    if (!getPlanLimits(user.plan).aiSuggestionsRefresh) {
      return NextResponse.json(
        {
          error: 'AI suggestion refresh requires a paid plan. Upgrade at /pricing.',
          upgradeRequired: true,
        },
        { status: 403 }
      )
    }
    const limit = await rateLimit(`ai-suggest:${auth.email}`, 4, 60)
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Refreshing too quickly, try again in a minute.' },
        { status: 429 }
      )
    }
  } else {
    // Background fetches still get a soft IP-level limit to avoid abuse.
    const limit = await rateLimit(`ai-suggest-ip:${getClientIp(request)}`, 30, 60)
    if (!limit.ok) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }
  }

  try {
    const user = await getUserData(auth.email)
    const suggestions = await buildAiSuggestions({
      userEmail: auth.email,
      watchlist: user.watchlist ?? [],
      forceRefresh: force,
    })
    return NextResponse.json(suggestions)
  } catch (error) {
    console.error('ai-suggestions error:', error)
    return NextResponse.json(
      { error: 'Failed to build suggestions' },
      { status: 500 }
    )
  }
}
