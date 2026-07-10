/**
 * Client-side caches that must be scoped or cleared per authenticated user.
 */

import type { StoredChatMessage } from '@/lib/user-types'

export const ACTIVE_USER_SESSION_KEY = 'ms:active-user'

const LEGACY_CHAT_PREFIX = 'ms:chat:'
const SCOPED_CHAT_PREFIX = 'ms:chat:v2:'

export function normalizeEmailForCache(email: string): string {
  return email.trim().toLowerCase()
}

export function chatLocalStorageKey(email: string, scope: string): string {
  return `${SCOPED_CHAT_PREFIX}${normalizeEmailForCache(email)}:${scope}`
}

export function setActiveSessionUser(email: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (email) {
      sessionStorage.setItem(
        ACTIVE_USER_SESSION_KEY,
        normalizeEmailForCache(email)
      )
    } else {
      sessionStorage.removeItem(ACTIVE_USER_SESSION_KEY)
    }
  } catch {
    /* private mode */
  }
}

export function getActiveSessionUser(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return sessionStorage.getItem(ACTIVE_USER_SESSION_KEY)
  } catch {
    return null
  }
}

/** Remove all chat conversation keys (legacy + user-scoped). */
export function clearAllChatLocalStorage(): void {
  if (typeof window === 'undefined') return
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (
        key &&
        (key.startsWith(SCOPED_CHAT_PREFIX) || key.startsWith(LEGACY_CHAT_PREFIX))
      ) {
        keys.push(key)
      }
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export function clearChatLocalStorageForUser(email: string): void {
  if (typeof window === 'undefined') return
  const prefix = `${SCOPED_CHAT_PREFIX}${normalizeEmailForCache(email)}:`
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export function clearChatLocalStorageScope(email: string, scope: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(chatLocalStorageKey(email, scope))
    localStorage.removeItem(`${LEGACY_CHAT_PREFIX}${scope}`)
  } catch {
    /* ignore */
  }
}

export function readScopedChatLocalStorage(
  email: string,
  scope: string
): StoredChatMessage[] {
  if (typeof window === 'undefined') return []
  const active = getActiveSessionUser()
  if (active && active !== normalizeEmailForCache(email)) return []

  try {
    const raw = localStorage.getItem(chatLocalStorageKey(email, scope))
    if (!raw) return []
    const parsed = JSON.parse(raw) as { messages?: StoredChatMessage[] }
    return Array.isArray(parsed.messages) ? parsed.messages : []
  } catch {
    return []
  }
}

export function writeScopedChatLocalStorage(
  email: string,
  scope: string,
  messages: StoredChatMessage[]
): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(
      chatLocalStorageKey(email, scope),
      JSON.stringify({ messages, updatedAt: new Date().toISOString() })
    )
  } catch {
    /* quota / private mode */
  }
}

/** Call on logout so the next user never sees cached private data. */
export function clearUserSessionClientData(): void {
  clearAllChatLocalStorage()
  setActiveSessionUser(null)
}
