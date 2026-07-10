export function getBaseUrl(): string {
  const url =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
    ''
  return url.replace(/\/$/, '')
}

/** Use the incoming request origin for OAuth (avoids localhost env on production). */
export function getRequestBaseUrl(request: Request): string {
  return new URL(request.url).origin
}

/**
 * Most reliable absolute base URL for *external* redirects (Stripe success_url,
 * Google OAuth callback, etc). Picks the first source in this order:
 *   1. `X-Forwarded-Host` + `X-Forwarded-Proto` headers (set by Vercel, Render,
 *      AWS ALB, Cloudflare, NGINX). This survives reverse proxies that rewrite
 *      `request.url` to an internal host.
 *   2. `request.url`'s origin (works for direct hits / Next dev).
 *   3. `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_BASE_URL` only when the request URL
 *      somehow resolves to localhost while the env points elsewhere.
 *
 * Crucially this means a user paying from `https://yourdomain.com` will be
 * sent back to `https://yourdomain.com`, never to `http://localhost:3000`,
 * regardless of how the environment is configured.
 */
export function getExternalBaseUrl(request: Request): string {
  const headers = request.headers
  const forwardedHost = headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost) {
    const proto = forwardedProto || 'https'
    return `${proto}://${forwardedHost}`.replace(/\/$/, '')
  }

  const reqUrl = (() => {
    try {
      return new URL(request.url)
    } catch {
      return null
    }
  })()

  const hostHeader = headers.get('host')
  if (reqUrl) {
    // Honour the `Host:` header over `request.url` when set - some hosts
    // route requests through an internal hostname that doesn't match the
    // public one but the `Host` header always reflects the public origin.
    if (hostHeader && hostHeader !== reqUrl.host) {
      const proto =
        forwardedProto ||
        (process.env.NODE_ENV === 'production' ? 'https' : reqUrl.protocol.replace(':', ''))
      return `${proto}://${hostHeader}`.replace(/\/$/, '')
    }
    const origin = reqUrl.origin
    if (origin && !/localhost|127\.0\.0\.1/i.test(origin)) {
      return origin.replace(/\/$/, '')
    }
    // Fall through: localhost origin but maybe env is configured for prod.
    const envUrl = getBaseUrl()
    if (envUrl && !/localhost|127\.0\.0\.1/i.test(envUrl)) {
      return envUrl
    }
    return origin.replace(/\/$/, '')
  }

  return getBaseUrl() || 'http://localhost:3000'
}

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:'
}

/** Only allow same-site relative paths after login. */
export function sanitizeRedirectPath(path: string | null | undefined): string {
  if (!path || typeof path !== 'string') return '/app'
  if (!path.startsWith('/') || path.startsWith('//')) return '/app'
  return path
}

/** Prefer request protocol in Route Handlers; dev on localhost always uses non-secure cookies. */
export function useSecureCookies(request?: Request): boolean {
  if (request) {
    return isSecureRequest(request)
  }
  if (process.env.NODE_ENV !== 'production') {
    return false
  }
  return getBaseUrl().startsWith('https://')
}

export function isStripeConfigured(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY &&
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  )
}

export function isGoogleAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  )
}

/** Google Custom Search JSON API (programmable search engine for agent web research). */
export function isGoogleCustomSearchConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CUSTOM_SEARCH_API_KEY?.trim() ||
      process.env.GOOGLE_CSE_API_KEY?.trim()
  )
}

export function isSessionConfigured(): boolean {
  const secret = process.env.SESSION_SECRET?.trim()
  if (process.env.NODE_ENV !== 'production') return true
  return Boolean(secret && secret.length >= 32)
}

export function isAuthStorageConfigured(): boolean {
  return Boolean(
    process.env.DATABASE_URL?.trim() ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ||
      (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  )
}
