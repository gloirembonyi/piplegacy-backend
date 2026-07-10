/**
 * Cron-side helper that enumerates every user with bot strategies on file.
 *
 * Tries the same persistence layers as `bot-config-store.ts`:
 *   1. Upstash KV - SCAN over `ms:bot:cfg:*`, follow each hash back to its
 *      email via the stored `data.email`.
 *   2. Postgres   - SELECT email from `ms_bot_config`.
 *   3. Filesystem - readdir `<dataDir>/bot/*.cfg.json`.
 *
 * Returns plain email strings; the cron route loads each config with
 * `getBotConfig(email)`.
 */

import { readdir, readFile } from 'fs/promises'
import path from 'path'
import { getDataDir } from '@/lib/data-dir'
import { ensureSchema, getSql } from '@/lib/db'
import { getRedis } from '@/lib/redis'

async function fromKv(): Promise<string[] | null> {
  const r = getRedis()
  if (!r) return null
  try {
    const emails = new Set<string>()
    let cursor: string | number = 0
    do {
      const res = (await r.scan(cursor, {
        match: 'ms:bot:cfg:*',
        count: 200,
      })) as [string | number, string[]]
      const [next, keys] = res
      cursor = next
      if (keys.length > 0) {
        const values = (await r.mget<Array<{ email?: string } | null>>(...keys)) ?? []
        for (const v of values) {
          if (v?.email) emails.add(v.email)
        }
      }
    } while (Number(cursor) !== 0)
    return [...emails]
  } catch (err) {
    console.error('bot-discovery fromKv failed:', err)
    return null
  }
}

async function fromDb(): Promise<string[] | null> {
  const sql = getSql()
  if (!sql) return null
  try {
    if (!(await ensureSchema())) return null
    const rows = (await sql`
      SELECT email FROM ms_bot_config
    `) as Array<{ email: string }>
    return rows.map((r) => r.email)
  } catch (err) {
    console.error('bot-discovery fromDb failed:', err)
    return null
  }
}

async function fromFile(): Promise<string[]> {
  try {
    const dir = getDataDir('bot')
    const files = await readdir(dir).catch(() => [] as string[])
    const out = new Set<string>()
    for (const f of files) {
      if (!f.endsWith('.cfg.json')) continue
      try {
        const data = JSON.parse(await readFile(path.join(dir, f), 'utf-8')) as {
          email?: string
        }
        if (data.email) out.add(data.email)
      } catch {
        /* skip */
      }
    }
    return [...out]
  } catch {
    return []
  }
}

export async function listAllBotConfigEmails(): Promise<string[]> {
  const fromKvList = await fromKv()
  if (fromKvList && fromKvList.length > 0) return fromKvList
  const fromDbList = await fromDb()
  if (fromDbList && fromDbList.length > 0) return fromDbList
  return fromFile()
}
