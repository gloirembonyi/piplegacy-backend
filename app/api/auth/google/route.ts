import { NextResponse } from 'next/server'
import {
  getRequestBaseUrl,
  isGoogleAuthConfigured,
  isSecureRequest,
  isSessionConfigured,
  sanitizeRedirectPath,
} from '@/lib/env'
import {
  createOAuthState,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE,
  type OAuthClient,
} from '@/lib/oauth-state'

function parseClient(value: string | null): OAuthClient {
  return value === 'desktop' ? 'desktop' : 'web'
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
    const redirect = sanitizeRedirectPath(searchParams.get('redirect'))
    const client = parseClient(searchParams.get('client'))
    const { state, nonce } = createOAuthState(redirect, client)

    const response = NextResponse.redirect(
      new URL(
        `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          redirect_uri: `${baseUrl}/api/auth/google/callback`,
          response_type: 'code',
          scope: 'openid email profile',
          state,
          access_type: 'online',
          prompt: 'select_account',
        }).toString()}`
      )
    )

    response.cookies.set(OAUTH_STATE_COOKIE, nonce, {
      httpOnly: true,
      secure: isSecureRequest(request),
      sameSite: 'lax',
      maxAge: OAUTH_STATE_MAX_AGE,
      path: '/',
    })

    return response
  } catch (err) {
    console.error('Google auth start error:', err)
    return NextResponse.redirect(new URL('/login?error=server_config', baseUrl))
  }
}
