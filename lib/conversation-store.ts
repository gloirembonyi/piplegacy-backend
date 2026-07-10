/**
 * Unified conversation persistence: Convex (optional) → KV → Postgres → file.
 */

import type { StoredChatMessage, StoredConversation } from '@/lib/user-types'
import {
  clearAllConversations as clearAllLegacy,
  clearConversation as clearLegacy,
  getConversation as getLegacy,
  listConversations as listLegacy,
  saveConversation as saveLegacy,
} from '@/lib/user-store'
import {
  convexClearConversation,
  convexGetConversation,
  convexListConversations,
  convexSaveConversation,
} from '@/lib/convex/conversations'

export function isConvexConversationStoreEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_CONVEX_URL?.trim())
}

export async function loadConversation(
  email: string,
  scope: string
): Promise<StoredConversation | null> {
  const legacy = await getLegacy(email, scope)

  if (!isConvexConversationStoreEnabled()) {
    return legacy
  }

  try {
    const fromConvex = await convexGetConversation(email, scope)
    if (fromConvex && legacy) {
      const convexTs = Date.parse(fromConvex.updatedAt || '0')
      const legacyTs = Date.parse(legacy.updatedAt || '0')
      return convexTs >= legacyTs ? fromConvex : legacy
    }
    return fromConvex ?? legacy
  } catch (err) {
    console.warn('[conversation-store] Convex read failed, falling back:', err)
    return legacy
  }
}

/** Alias for API routes. */
export const getConversation = loadConversation

export async function persistConversation(
  email: string,
  scope: string,
  messages: StoredChatMessage[],
  title?: string
): Promise<StoredConversation | null> {
  let conv: StoredConversation | null = null

  if (isConvexConversationStoreEnabled()) {
    try {
      conv = await convexSaveConversation(email, scope, messages, title)
      if (conv) {
        // Mirror to legacy store as offline fallback
        await saveLegacy(email, scope, messages, title).catch(() => undefined)
        return conv
      }
    } catch (err) {
      console.warn('[conversation-store] Convex write failed, falling back:', err)
    }
  }

  return saveLegacy(email, scope, messages, title)
}

export async function listConversations(
  email: string
): Promise<StoredConversation[]> {
  const legacy = await listLegacy(email)

  if (!isConvexConversationStoreEnabled()) {
    return legacy
  }

  try {
    const fromConvex = await convexListConversations(email)
    // null = Convex list unavailable (undeployed function) - use legacy only
    if (fromConvex === null) return legacy
    if (fromConvex.length === 0 && legacy.length > 0) return legacy

    const byScope = new Map<string, StoredConversation>()
    for (const conv of legacy) byScope.set(conv.scope, conv)
    for (const conv of fromConvex) {
      const prev = byScope.get(conv.scope)
      if (!prev) {
        byScope.set(conv.scope, conv)
        continue
      }
      const convexTs = Date.parse(conv.updatedAt || '0')
      const legacyTs = Date.parse(prev.updatedAt || '0')
      byScope.set(conv.scope, convexTs >= legacyTs ? conv : prev)
    }
    return Array.from(byScope.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )
  } catch (err) {
    console.warn('[conversation-store] Convex list failed, falling back:', err)
  }

  return legacy
}

export async function removeConversation(
  email: string,
  scope: string
): Promise<boolean> {
  // Tombstone empty first so a late in-flight PUT cannot resurrect deleted data.
  await persistConversation(email, scope, []).catch(() => undefined)

  if (isConvexConversationStoreEnabled()) {
    try {
      await convexClearConversation(email, scope)
    } catch {
      /* fall through */
    }
  }
  return clearLegacy(email, scope)
}

export async function removeAllConversations(email: string): Promise<void> {
  if (isConvexConversationStoreEnabled()) {
    try {
      const list = await convexListConversations(email)
      if (list) {
        await Promise.all(
          list.map((c) => convexClearConversation(email, c.scope))
        )
      }
    } catch {
      /* fall through */
    }
  }
  await clearAllLegacy(email)
}

export { isValidConversationScope } from '@/lib/user-store'
