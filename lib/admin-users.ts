import { createHash } from 'crypto'
import { readdir, readFile } from 'fs/promises'
import path from 'path'
import { ensureSchema, getSql } from '@/lib/db'
import { getDataDir } from '@/lib/data-dir'
import { getRedis } from '@/lib/redis'
import { getUserData, saveUserData } from '@/lib/user-store'
import type { UserData } from '@/lib/user-types'
import { normalizePlanId } from '@/lib/plan-limits'

export type AdminUserRow = {
  email: string
  name?: string
  plan: string
  createdAt: string
  updatedAt: string
  watchlistCount: number
  conversationCount: number
  analysisCount: number
  subscriptionStatus?: string | null
  planSource?: string | null
  storage: 'db' | 'kv' | 'file' | 'unknown'
}

function summarizeUser(data: UserData, storage: AdminUserRow['storage']): AdminUserRow {
  const conversations = Object.values(data.conversations ?? {})
  return {
    email: data.email,
    plan: normalizePlanId(data.plan),
    createdAt: data.createdAt ?? data.updatedAt,
    updatedAt: data.updatedAt,
    watchlistCount: data.watchlist?.length ?? 0,
    conversationCount: conversations.length,
    analysisCount: data.analyses?.length ?? 0,
    subscriptionStatus: data.subscriptionStatus ?? null,
    planSource: data.planSource ?? null,
    storage,
  }
}

async function listFromDb(): Promise<AdminUserRow[]> {
  const sql = getSql()
  if (!sql || !(await ensureSchema())) return []
  try {
    const rows = (await sql`
      SELECT email, data, updated_at
      FROM ms_user_data
      ORDER BY updated_at DESC
      LIMIT 500
    `) as Array<{ email: string; data: UserData; updated_at: string }>
    return rows.map((r) =>
      summarizeUser(
        { ...r.data, email: r.email, updatedAt: r.updated_at ?? r.data.updatedAt },
        'db'
      )
    )
  } catch (err) {
    console.error('[admin-users] listFromDb failed:', err)
    return []
  }
}

async function listFromFiles(): Promise<AdminUserRow[]> {
  const dir = getDataDir('users')
  try {
    const files = await readdir(dir)
    const out: AdminUserRow[] = []
    for (const file of files.slice(0, 500)) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await readFile(path.join(dir, file), 'utf-8')
        const data = JSON.parse(raw) as UserData
        if (data.email) out.push(summarizeUser(data, 'file'))
      } catch {
        /* skip corrupt file */
      }
    }
    return out
  } catch {
    return []
  }
}

async function listCredentialEmails(): Promise<Map<string, { name: string; createdAt: string }>> {
  const sql = getSql()
  const map = new Map<string, { name: string; createdAt: string }>()
  if (!sql || !(await ensureSchema())) return map
  try {
    const rows = (await sql`
      SELECT email, name, created_at
      FROM ms_credentials
      ORDER BY created_at DESC
      LIMIT 500
    `) as Array<{ email: string; name: string; created_at: string }>
    for (const r of rows) {
      map.set(r.email.toLowerCase(), { name: r.name, createdAt: r.created_at })
    }
  } catch {
    /* optional table */
  }
  return map
}

export async function listAdminUsers(): Promise<AdminUserRow[]> {
  const [dbUsers, fileUsers, creds] = await Promise.all([
    listFromDb(),
    listFromFiles(),
    listCredentialEmails(),
  ])

  const byEmail = new Map<string, AdminUserRow>()
  for (const u of fileUsers) byEmail.set(u.email.toLowerCase(), u)
  for (const u of dbUsers) byEmail.set(u.email.toLowerCase(), u)

  for (const [email, cred] of creds) {
    if (!byEmail.has(email)) {
      byEmail.set(email, {
        email,
        name: cred.name,
        plan: 'free',
        createdAt: cred.createdAt,
        updatedAt: cred.createdAt,
        watchlistCount: 0,
        conversationCount: 0,
        analysisCount: 0,
        storage: 'unknown',
      })
    } else {
      const row = byEmail.get(email)!
      row.name = row.name ?? cred.name
    }
  }

  return [...byEmail.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
}

export async function adminSetUserPlan(
  email: string,
  plan: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await getUserData(email)
    data.plan = normalizePlanId(plan)
    data.planSource = 'manual'
    data.updatedAt = new Date().toISOString()
    await saveUserData(data)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to update plan',
    }
  }
}

export type AdminUserStats = {
  totalUsers: number
  byPlan: Record<string, number>
  activeLast7d: number
}

export function aggregateUserStats(users: AdminUserRow[]): AdminUserStats {
  const byPlan: Record<string, number> = {}
  const weekAgo = Date.now() - 7 * 86_400_000
  let activeLast7d = 0
  for (const u of users) {
    byPlan[u.plan] = (byPlan[u.plan] ?? 0) + 1
    if (new Date(u.updatedAt).getTime() >= weekAgo) activeLast7d++
  }
  return { totalUsers: users.length, byPlan, activeLast7d }
}

/** Safe hash prefix for admin display (not reversible). */
export function emailHashPrefix(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 8)
}

/** Optional: count KV user keys when Redis is configured. */
export async function countKvUsers(): Promise<number | null> {
  const redis = getRedis()
  if (!redis) return null
  try {
    const keys = await redis.keys('ms:user:*')
    return keys.length
  } catch {
    return null
  }
}
