import { NextResponse } from 'next/server'
import { getSessionFromToken, SESSION_COOKIE, type SessionUser } from '@/lib/session-token'

/**
 * Read session from a Request. Checks `Authorization: Bearer <token>` first (the
 * piplegacy-desktop client, which has no shared-origin cookie jar), then falls back to the
 * `ms_session` cookie (the web app). Same signed-token format for both — desktop tokens are
 * just tagged `aud: 'desktop'` when minted.
 */
export async function getSessionFromRequest(request: Request): Promise<SessionUser | null> {
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const session = await getSessionFromToken(authHeader.slice('Bearer '.length).trim())
    if (session) return session
  }

  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) return null

  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))
  return getSessionFromToken(match?.[1] ? decodeURIComponent(match[1]) : undefined)
}

export function unauthorizedJson() {
  return NextResponse.json(
    { error: 'Unauthorized. Please sign in to access this feature.' },
    { status: 401 }
  )
}

/** Returns session user or a 401 NextResponse. */
export async function requireAuth(request: Request): Promise<SessionUser | NextResponse> {
  const session = await getSessionFromRequest(request)
  if (!session) return unauthorizedJson()
  return session
}

export function isAuthSession(session: SessionUser | NextResponse): session is SessionUser {
  return !(session instanceof NextResponse)
}

/** API routes that require a logged-in user (app features). */
export const PROTECTED_API_ROUTES = [
  '/api/analyze-chart',
  '/api/market-chat',
  '/api/market-data',
  '/api/market-news',
  '/api/market-ideas',
  '/api/market-brief',
  '/api/ai-suggestions',
  '/api/notifications',
  '/api/market-context',
  '/api/economic-calendar',
  '/api/health',
  '/api/finnhub',
  '/api/market-candles',
  '/api/forex-volatility',
  '/api/chart-overlay-data',
  '/api/symbols',
  '/api/bot',
  '/api/user',
  '/api/create-checkout-session',
  '/api/stripe',
  '/api/admin',
] as const

export function isProtectedApiRoute(pathname: string): boolean {
  return PROTECTED_API_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  )
}

/** Public auth endpoints only (login, OAuth, logout). */
const PUBLIC_AUTH_ROUTES = [
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/logout',
  '/api/auth/google',
  '/api/auth/google/callback',
  '/api/auth/desktop/exchange',
] as const

export function isPublicAuthApiRoute(pathname: string): boolean {
  return PUBLIC_AUTH_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  )
}
