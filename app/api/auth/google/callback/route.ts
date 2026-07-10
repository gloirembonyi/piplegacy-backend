import { NextResponse } from 'next/server'
import { setSessionOnResponse } from '@/lib/auth'
import { ensureUserData } from '@/lib/user-store'
import { mintDesktopExchangeCode } from '@/lib/desktop-auth'
import {
  getRequestBaseUrl,
  isGoogleAuthConfigured,
  isSecureRequest,
  isSessionConfigured,
  sanitizeRedirectPath,
} from '@/lib/env'
import {
  OAUTH_STATE_COOKIE,
  verifyOAuthState,
} from '@/lib/oauth-state'

// The desktop app can't be Google's redirect_uri directly (OAuth web clients only allow
// http(s) redirect URIs) — so the desktop flow lands here just like the web flow, then hops
// to the custom URI scheme as a second redirect once we've authenticated the user.
const DESKTOP_DEEP_LINK_BASE =
  process.env.DESKTOP_DEEP_LINK_URL || 'piplegacy://auth-callback'

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {}
  return Object.fromEntries(
    header.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=')
      return [k, decodeURIComponent(v.join('='))]
    })
  )
}

export async function GET(request: Request) {
  const baseUrl = getRequestBaseUrl(request)

  try {
    if (!isSessionConfigured()) {
      return NextResponse.redirect(
        new URL('/login?error=server_config', baseUrl)
      )
    }

    if (!isGoogleAuthConfigured()) {
      return NextResponse.redirect(
        new URL('/login?error=google_not_configured', baseUrl)
      )
    }

    const { searchParams } = new URL(request.url)
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')

    if (error || !code || !state) {
      return NextResponse.redirect(
        new URL('/login?error=google_auth_failed', baseUrl)
      )
    }

    const cookies = parseCookies(request.headers.get('cookie'))
    const verifiedState =
      verifyOAuthState(state, cookies[OAUTH_STATE_COOKIE]) ?? null

    if (!verifiedState) {
      return NextResponse.redirect(
        new URL('/login?error=google_auth_failed', baseUrl)
      )
    }

    const { redirect: redirectPath, client } = verifiedState

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${baseUrl}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    })

    const tokens = await tokenRes.json()
    if (!tokens.access_token) {
      console.error('Google token error:', tokens)
      return NextResponse.redirect(
        new URL('/login?error=google_auth_failed', baseUrl)
      )
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })

    const profile = await userRes.json()
    if (!profile.email) {
      return NextResponse.redirect(
        new URL('/login?error=google_auth_failed', baseUrl)
      )
    }

    const normalizedEmail = profile.email.toLowerCase()
    await ensureUserData(normalizedEmail)
    const user = { email: normalizedEmail, name: profile.name || profile.email.split('@')[0] }

    if (client === 'desktop') {
      const code = await mintDesktopExchangeCode(user)
      const response = NextResponse.redirect(`${DESKTOP_DEEP_LINK_BASE}?code=${code}`)
      response.cookies.delete(OAUTH_STATE_COOKIE)
      return response
    }

    const response = NextResponse.redirect(
      new URL(sanitizeRedirectPath(redirectPath), baseUrl)
    )
    await setSessionOnResponse(response, user, isSecureRequest(request))
    response.cookies.delete(OAUTH_STATE_COOKIE)

    return response
  } catch (err) {
    console.error('Google callback error:', err)
    return NextResponse.redirect(
      new URL('/login?error=google_auth_failed', baseUrl)
    )
  }
}
