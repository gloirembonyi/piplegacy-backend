import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getSessionFromRequest, isProtectedApiRoute, isPublicAuthApiRoute } from '@/lib/require-auth'
import { corsHeaders, resolveCorsOrigin } from '@/lib/cors'

// This is an API-only service — unlike market-signal's proxy.ts, there are no pages to gate
// (no /app, /admin, /plan routes here; those live in piplegacy-desktop/frontend and check auth
// client-side). This proxy only needs to: (1) answer CORS preflight, (2) gate protected API
// routes by session (cookie for a web client, Bearer token for the desktop client), and
// (3) stamp CORS headers on every /api/* response.
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const origin = resolveCorsOrigin(request)

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
  }

  if (isProtectedApiRoute(pathname) && !isPublicAuthApiRoute(pathname)) {
    const session = await getSessionFromRequest(request)
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized. Please sign in to access this feature.' },
        { status: 401, headers: corsHeaders(origin) }
      )
    }
  }

  const response = NextResponse.next({ request })
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    response.headers.set(key, value)
  }
  return response
}

export const config = {
  matcher: ['/api/:path*'],
}
