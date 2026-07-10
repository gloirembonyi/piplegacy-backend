import { NextResponse } from 'next/server'
import {
  initAdminSystem,
  isAdminConfiguredAsync,
  isUserAdmin,
  isUserSuperAdmin,
} from '@/lib/admin'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import type { SessionUser } from '@/lib/session-token'

export function forbiddenAdminJson() {
  return NextResponse.json({ error: 'Admin access required.' }, { status: 403 })
}

export function forbiddenSuperAdminJson() {
  return NextResponse.json({ error: 'Super admin access required.' }, { status: 403 })
}

export function adminNotConfiguredJson() {
  return NextResponse.json(
    {
      error:
        'Admin panel is not configured. Run pnpm seed:super-admin or set SUPER_ADMIN_EMAIL / ADMIN_EMAILS in environment variables.',
    },
    { status: 503 }
  )
}

/** Returns session user or 401/403/503 NextResponse. */
export async function requireAdmin(
  request: Request
): Promise<SessionUser | NextResponse> {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  await initAdminSystem()

  if (!(await isAdminConfiguredAsync())) {
    return adminNotConfiguredJson()
  }

  if (!(await isUserAdmin(auth.email))) {
    return forbiddenAdminJson()
  }

  return auth
}

export async function requireSuperAdmin(
  request: Request
): Promise<SessionUser | NextResponse> {
  const auth = await requireAdmin(request)
  if (!isAuthSession(auth)) return auth

  if (!(await isUserSuperAdmin(auth.email))) {
    return forbiddenSuperAdminJson()
  }

  return auth
}
