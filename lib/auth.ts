import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { useSecureCookies } from '@/lib/env'
import {
  encodeSessionToken,
  getSessionFromToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  type SessionUser,
} from '@/lib/session-token'

export type { SessionUser } from '@/lib/session-token'
export { SESSION_COOKIE, SESSION_MAX_AGE, getSessionFromToken } from '@/lib/session-token'

export function getSessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    maxAge: SESSION_MAX_AGE,
    path: '/',
  }
}

export async function createSession(user: SessionUser, request?: Request) {
  const cookieStore = await cookies()
  cookieStore.set(
    SESSION_COOKIE,
    await encodeSessionToken({
      email: user.email.trim().toLowerCase(),
      name: user.name.trim() || user.email.split('@')[0],
    }),
    getSessionCookieOptions(useSecureCookies(request))
  )
}

export async function setSessionOnResponse(
  response: NextResponse,
  user: SessionUser,
  secure: boolean
): Promise<NextResponse> {
  response.cookies.set(
    SESSION_COOKIE,
    await encodeSessionToken({
      email: user.email.trim().toLowerCase(),
      name: user.name.trim() || user.email.split('@')[0],
    }),
    getSessionCookieOptions(secure)
  )
  return response
}

export async function destroySession() {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE)
}

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  return getSessionFromToken(token)
}
