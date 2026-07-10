import { base64UrlToString } from '@/lib/crypto-utils'
import {
  buildSessionPayload,
  signSessionPayload,
  verifySessionToken,
  type SessionAudience,
} from '@/lib/session-crypto'

export const SESSION_COOKIE = 'ms_session'
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7 days
// Desktop bearer tokens are short-lived relative to the web cookie session — the desktop
// app is expected to silently re-auth via the system browser if this expires.
export const DESKTOP_SESSION_MAX_AGE = 60 * 60 * 24 * 30 // 30 days

export type { SessionAudience } from '@/lib/session-crypto'

export type SessionUser = {
  email: string
  name: string
  aud?: SessionAudience
}

export async function encodeSessionToken(
  user: SessionUser,
  aud: SessionAudience = 'web'
): Promise<string> {
  const maxAge = aud === 'desktop' ? DESKTOP_SESSION_MAX_AGE : SESSION_MAX_AGE
  const payload = buildSessionPayload(user.email, user.name, maxAge, aud)
  return signSessionPayload(payload)
}

async function decodeSessionToken(token: string): Promise<SessionUser | null> {
  const verified = await verifySessionToken(token)
  if (verified) {
    return { email: verified.email, name: verified.name, aud: verified.aud ?? 'web' }
  }

  if (process.env.NODE_ENV === 'production') return null

  try {
    const raw = base64UrlToString(token)
    if (!raw) return null
    const data = JSON.parse(raw) as { email?: string; name?: string; exp?: number }
    if (!data.email || !data.exp || data.exp < Date.now()) return null
    return { email: data.email, name: data.name || data.email.split('@')[0] }
  } catch {
    return null
  }
}

export async function getSessionFromToken(
  token: string | undefined
): Promise<SessionUser | null> {
  if (!token) return null
  return decodeSessionToken(token)
}
