/**
 * Admin access - env fallback + database roles (see admin-store.ts).
 * Prefer async helpers for route handlers and server components.
 */

import {
  ensureBootstrapSuperAdmin,
  isAdminConfiguredAsync,
  isUserAdmin,
  isUserSuperAdmin,
} from '@/lib/admin-store'

export {
  addAdmin,
  ensureBootstrapSuperAdmin,
  isAdminConfiguredAsync,
  isUserAdmin,
  isUserSuperAdmin,
  listAdmins,
  removeAdmin,
  type AdminRecord,
  type AdminRole,
} from '@/lib/admin-store'

/** Comma-separated admin emails in ADMIN_EMAILS (legacy bootstrap). */
export function getAdminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS?.trim()
  if (!raw) return []
  return [...new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))]
}

/** @deprecated Use isUserAdmin() - sync env-only check. */
export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false
  const normalized = email.trim().toLowerCase()
  const bootstrap = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase()
  if (bootstrap && bootstrap === normalized) return true
  return getAdminEmails().includes(normalized)
}

/** @deprecated Use isAdminConfiguredAsync() */
export function isAdminConfigured(): boolean {
  if (getAdminEmails().length > 0) return true
  return Boolean(process.env.SUPER_ADMIN_EMAIL?.trim())
}

/** Call once during admin API boot to sync SUPER_ADMIN_EMAIL into DB. */
export async function initAdminSystem(): Promise<void> {
  await ensureBootstrapSuperAdmin()
}
