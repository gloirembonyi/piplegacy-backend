/**
 * Server-side Convex HTTP client for agent conversations.
 * Requires NEXT_PUBLIC_CONVEX_URL and deployed functions (`pnpm convex:deploy`).
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '../../convex/_generated/api'
import type { StoredChatMessage, StoredConversation } from '@/lib/user-types'

let client: ConvexHttpClient | null = null

/** When false, listForUser is missing on the deployed backend - skip repeat calls. */
let listForUserAvailable: boolean | null = null
let lastCapabilityWarnAt = 0

const WARN_COOLDOWN_MS = 120_000

function getClient(): ConvexHttpClient | null {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL?.trim()
  if (!url) return null
  if (!client) client = new ConvexHttpClient(url)
  return client
}

function isMissingConvexFunction(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes('Could not find public function') ||
    msg.includes('Could not find function') ||
    msg.includes('listForUser')
  )
}

function warnConvexCapabilityOnce(message: string, err?: unknown) {
  const now = Date.now()
  if (now - lastCapabilityWarnAt < WARN_COOLDOWN_MS) return
  lastCapabilityWarnAt = now
  if (err) console.warn(message, err)
  else console.warn(message)
}

function toConversation(
  scope: string,
  row: {
    title?: string
    messages?: StoredChatMessage[]
    updatedAt?: string
  } | null
): StoredConversation | null {
  if (!row) return null
  return {
    scope,
    title: row.title,
    messages: Array.isArray(row.messages) ? row.messages : [],
    updatedAt: row.updatedAt ?? new Date().toISOString(),
  }
}

export function isConvexListForUserAvailable(): boolean {
  return listForUserAvailable !== false
}

export async function convexGetConversation(
  userEmail: string,
  scope: string
): Promise<StoredConversation | null> {
  const c = getClient()
  if (!c) return null
  try {
    const row = await c.query(api.conversations.get, { userEmail, scope })
    return toConversation(scope, row)
  } catch (err) {
    if (isMissingConvexFunction(err)) {
      warnConvexCapabilityOnce(
        '[convex] conversations.get unavailable - run `pnpm convex:deploy` to sync functions.'
      )
    } else {
      console.warn('[convex] get conversation failed:', err)
    }
    return null
  }
}

export async function convexSaveConversation(
  userEmail: string,
  scope: string,
  messages: StoredChatMessage[],
  title?: string
): Promise<StoredConversation | null> {
  const c = getClient()
  if (!c) return null
  try {
    const row = await c.mutation(api.conversations.save, {
      userEmail,
      scope,
      title,
      messages,
    })
    return toConversation(scope, row)
  } catch (err) {
    if (isMissingConvexFunction(err)) {
      warnConvexCapabilityOnce(
        '[convex] conversations.save unavailable - run `pnpm convex:deploy` to sync functions.'
      )
    } else {
      console.warn('[convex] save conversation failed:', err)
    }
    return null
  }
}

export async function convexClearConversation(
  userEmail: string,
  scope: string
): Promise<void> {
  const c = getClient()
  if (!c) return
  try {
    await c.mutation(api.conversations.clear, { userEmail, scope })
  } catch (err) {
    if (!isMissingConvexFunction(err)) {
      console.warn('[convex] clear conversation failed:', err)
    }
  }
}

export async function convexListConversations(
  userEmail: string
): Promise<StoredConversation[] | null> {
  const c = getClient()
  if (!c) return null

  if (listForUserAvailable === false) return null

  try {
    const rows = await c.query(api.conversations.listForUser, { userEmail })
    listForUserAvailable = true
    if (!Array.isArray(rows)) return []
    return rows
      .map((row) => toConversation(row.scope, row))
      .filter((conv): conv is StoredConversation => conv != null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch (err) {
    if (isMissingConvexFunction(err)) {
      listForUserAvailable = false
      warnConvexCapabilityOnce(
        '[convex] conversations.listForUser not deployed - using legacy conversation store. Run `pnpm convex:deploy`.',
        err
      )
      return null
    }
    console.warn('[convex] list conversations failed:', err)
    return null
  }
}

/** Lightweight ping for health checks / dev verification. */
export async function convexPing(): Promise<boolean> {
  const c = getClient()
  if (!c) return false
  try {
    await c.query(api.conversations.get, {
      userEmail: '__ping__@local',
      scope: '__ping__',
    })
    return true
  } catch {
    return false
  }
}
