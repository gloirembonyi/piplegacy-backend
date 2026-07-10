function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.pathname
  return input.url
}

/** Fetch wrapper - redirects to login when session is missing, expired, or route unavailable. */
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: 'same-origin' })

  if (typeof window === 'undefined') return res

  const path = requestPath(input)
  const isUserEndpoint = path.startsWith('/api/user')
  const needsSession =
    isUserEndpoint || path.startsWith('/api/create-checkout-session')

  if (res.status === 401 && needsSession) {
    const redirectPath = window.location.pathname + window.location.search
    window.location.href = `/login?redirect=${encodeURIComponent(redirectPath || '/app')}`
    return res
  }

  // Stale session or missing route handler in dev - send user back to sign in
  if (res.status === 404 && isUserEndpoint) {
    const redirectPath = window.location.pathname + window.location.search
    window.location.href = `/login?redirect=${encodeURIComponent(redirectPath || '/app')}`
  }

  return res
}
