import { getRedis } from '@/lib/redis'
import type { AiProvider } from '@/lib/gemini-keypool'

const RECENT_MAX = 80
const META_TTL_SEC = 7 * 86_400
const RECENT_LIST_KEY = 'admin:errors:recent'

export type AdminErrorKind = 'agent' | 'ai' | 'tool' | 'specialist'

export type AdminErrorEntry = {
  id: string
  at: string
  kind: AdminErrorKind
  /** Agent id, tool name, or route label */
  target: string
  status?: number
  message: string
  provider?: AiProvider
  keySuffix?: string
  model?: string
  userEmail?: string
  /** Extra context for operators */
  detail?: string
}

const localRecent: AdminErrorEntry[] = []

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function persistEntry(entry: AdminErrorEntry): Promise<void> {
  const payload = JSON.stringify(entry)
  const redis = getRedis()
  if (redis) {
    try {
      await redis.lpush(RECENT_LIST_KEY, payload)
      await redis.ltrim(RECENT_LIST_KEY, 0, RECENT_MAX - 1)
      await redis.expire(RECENT_LIST_KEY, META_TTL_SEC)
      return
    } catch (err) {
      console.warn('[admin-error-log] redis persist failed:', err)
    }
  }

  localRecent.unshift(entry)
  if (localRecent.length > RECENT_MAX) {
    localRecent.length = RECENT_MAX
  }
}

/** Fire-and-forget operator log for agent / AI / tool failures. */
export async function recordAdminError(input: {
  kind: AdminErrorKind
  target: string
  status?: number
  message: string
  provider?: AiProvider
  keySuffix?: string
  model?: string
  userEmail?: string
  detail?: string
}): Promise<void> {
  const message = input.message.trim().slice(0, 500)
  if (!message) return

  const entry: AdminErrorEntry = {
    id: newId(),
    at: new Date().toISOString(),
    kind: input.kind,
    target: input.target,
    status: input.status,
    message,
    provider: input.provider,
    keySuffix: input.keySuffix?.slice(-4),
    model: input.model,
    userEmail: input.userEmail,
    detail: input.detail?.slice(0, 300),
  }

  await persistEntry(entry)
}

export async function getRecentAdminErrors(limit = 30): Promise<AdminErrorEntry[]> {
  const cap = Math.max(1, Math.min(limit, RECENT_MAX))
  const redis = getRedis()
  if (redis) {
    try {
      const rows = await redis.lrange<string>(RECENT_LIST_KEY, 0, cap - 1)
      const out: AdminErrorEntry[] = []
      for (const row of rows) {
        try {
          const parsed =
            typeof row === 'string' ? (JSON.parse(row) as AdminErrorEntry) : (row as AdminErrorEntry)
          if (parsed?.at && parsed.message) out.push(parsed)
        } catch {
          /* skip */
        }
      }
      if (out.length > 0) return out
    } catch {
      /* fall through */
    }
  }
  return localRecent.slice(0, cap)
}

export function parseProviderErrorBody(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed) return null
  try {
    const j = JSON.parse(trimmed) as {
      error?: { message?: string; status?: string }
      message?: string
    }
    const msg = j.error?.message ?? j.message
    if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 240)
  } catch {
    /* not json */
  }
  if (trimmed.length <= 240) return trimmed
  return `${trimmed.slice(0, 237)}…`
}
