import {
  base64UrlToBytes,
  base64UrlToString,
  hmacSha256Base64Url,
  stringToBase64Url,
  timingSafeEqualBytes,
} from '@/lib/crypto-utils'

const SESSION_VERSION = 1

export type SessionAudience = 'web' | 'desktop'

export type SignedSessionPayload = {
  v: number
  email: string
  name: string
  exp: number
  aud?: SessionAudience
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim()
  if (process.env.NODE_ENV === 'production') {
    if (!secret || secret.length < 32) {
      throw new Error(
        'SESSION_SECRET must be set to a random string of at least 32 characters in production.'
      )
    }
    return secret
  }
  return secret || 'dev-only-change-me-before-production-32chars'
}

export async function signSessionPayload(payload: SignedSessionPayload): Promise<string> {
  const body = stringToBase64Url(JSON.stringify(payload))
  const sig = await hmacSha256Base64Url(getSessionSecret(), body)
  return `${body}.${sig}`
}

export async function verifySessionToken(
  token: string
): Promise<SignedSessionPayload | null> {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null

  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = await hmacSha256Base64Url(getSessionSecret(), body)

  const sigBytes = base64UrlToBytes(sig)
  const expectedBytes = base64UrlToBytes(expected)
  if (!sigBytes || !expectedBytes || !timingSafeEqualBytes(sigBytes, expectedBytes)) {
    return null
  }

  try {
    const raw = base64UrlToString(body)
    if (!raw) return null
    const data = JSON.parse(raw) as SignedSessionPayload
    if (data.v !== SESSION_VERSION || !data.email || !data.exp) return null
    if (data.exp < Date.now()) return null
    return data
  } catch {
    return null
  }
}

export function buildSessionPayload(
  email: string,
  name: string,
  maxAgeSec: number,
  aud: SessionAudience = 'web'
): SignedSessionPayload {
  return {
    v: SESSION_VERSION,
    email: email.trim().toLowerCase(),
    name: name.trim() || email.split('@')[0],
    exp: Date.now() + maxAgeSec * 1000,
    aud,
  }
}
