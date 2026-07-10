import { randomUUID } from 'crypto'
import { createHmac, timingSafeEqual } from 'crypto'

export const OAUTH_STATE_COOKIE = 'ms_oauth_state'
export const OAUTH_STATE_MAX_AGE = 600

export type OAuthClient = 'web' | 'desktop'

type OAuthStatePayload = {
  v: 1
  nonce: string
  redirect: string
  client: OAuthClient
  exp: number
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim()
  if (process.env.NODE_ENV === 'production' && (!secret || secret.length < 32)) {
    throw new Error('SESSION_SECRET required for OAuth')
  }
  return secret || 'dev-only-change-me-before-production-32chars'
}

function signPayload(payload: OAuthStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', getSecret()).update(body).digest('base64url')
  return `${body}.${sig}`
}

function verifyPayload(token: string): OAuthStatePayload | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = createHmac('sha256', getSecret()).update(body).digest('base64url')
  try {
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  } catch {
    return null
  }
  try {
    const data = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf-8')
    ) as OAuthStatePayload
    if (data.v !== 1 || !data.nonce || !data.exp || data.exp < Date.now()) return null
    return data
  } catch {
    return null
  }
}

export function createOAuthState(
  redirect: string,
  client: OAuthClient = 'web'
): { state: string; nonce: string } {
  const nonce = randomUUID()
  const payload: OAuthStatePayload = {
    v: 1,
    nonce,
    redirect,
    client,
    exp: Date.now() + OAUTH_STATE_MAX_AGE * 1000,
  }
  return { state: signPayload(payload), nonce }
}

export function verifyOAuthState(
  state: string | null,
  expectedNonce: string | undefined
): { redirect: string; client: OAuthClient } | null {
  if (!state || !expectedNonce) return null
  const data = verifyPayload(state)
  if (!data || data.nonce !== expectedNonce) return null
  return { redirect: data.redirect || '/app', client: data.client || 'web' }
}
