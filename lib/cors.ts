// The Tauri webview loads the desktop frontend from a fixed pseudo-origin (not a real web
// origin), which differs by platform. These are always allowed in addition to whatever's in
// ALLOWED_ORIGINS, since the desktop app has no other way to reach this API.
const TAURI_ORIGINS = ['tauri://localhost', 'https://tauri.localhost']

function configuredOrigins(): string[] {
  const fromEnv = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_BASE_URL || '').trim()
  return [...fromEnv, ...(appUrl ? [appUrl] : []), ...TAURI_ORIGINS]
}

/** Returns the request's Origin if it's allowed to make cross-origin calls, else null. */
export function resolveCorsOrigin(request: Request): string | null {
  const origin = request.headers.get('origin')
  if (!origin) return null
  return configuredOrigins().includes(origin) ? origin : null
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    Vary: 'Origin',
  }
}
