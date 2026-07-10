import { NextResponse } from 'next/server'
import { getForexVolatilityProfile } from '@/lib/forex-volatility-profile'
import { isAuthSession, requireAuth } from '@/lib/require-auth'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  try {
    const { searchParams } = new URL(request.url)
    const timeZone = searchParams.get('tz') || 'America/New_York'
    const data = await getForexVolatilityProfile(timeZone)

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'private, max-age=300, stale-while-revalidate=600',
      },
    })
  } catch (error) {
    console.error('forex-volatility error:', error)
    return NextResponse.json({ error: 'Failed to load volatility profile' }, { status: 500 })
  }
}
