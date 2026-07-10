import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { getDataDir } from '@/lib/data-dir'
import { ensureSchema, getSql } from '@/lib/db'
import path from 'path'
import { getRedis } from '@/lib/redis'

export type UserCredentials = {
  email: string
  passwordHash: string
  name: string
  createdAt: string
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function credKey(email: string): string {
  return `ms:cred:${createHash('sha256').update(normalizeEmail(email)).digest('hex')}`
}

function credFilePath(email: string): string {
  return path.join(
    getDataDir('credentials'),
    `${createHash('sha256').update(normalizeEmail(email)).digest('hex')}.json`
  )
}

async function readFromFile(email: string): Promise<UserCredentials | null> {
  try {
    const raw = await readFile(credFilePath(email), 'utf-8')
    const parsed = JSON.parse(raw) as UserCredentials
    if (normalizeEmail(parsed.email) !== normalizeEmail(email)) return null
    return parsed
  } catch {
    return null
  }
}

async function writeToFile(creds: UserCredentials): Promise<boolean> {
  try {
    const dir = getDataDir('credentials')
    await mkdir(dir, { recursive: true })
    await writeFile(credFilePath(creds.email), JSON.stringify(creds, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('credentials-store writeToFile failed:', err)
    return false
  }
}

async function readFromKv(email: string): Promise<UserCredentials | null> {
  const redis = getRedis()
  if (!redis) return null
  try {
    const parsed = await redis.get<UserCredentials>(credKey(email))
    if (!parsed || normalizeEmail(parsed.email) !== normalizeEmail(email)) return null
    return parsed
  } catch {
    return null
  }
}

async function writeToKv(creds: UserCredentials): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return false
  try {
    await redis.set(credKey(creds.email), creds)
    return true
  } catch {
    return false
  }
}

async function readFromDb(email: string): Promise<UserCredentials | null> {
  const sql = getSql()
  if (!sql) return null
  try {
    if (!(await ensureSchema())) return null
    const rows = (await sql`
      SELECT email, password_hash, name, created_at
      FROM ms_credentials
      WHERE email = ${normalizeEmail(email)}
      LIMIT 1
    `) as Array<{
      email: string
      password_hash: string
      name: string
      created_at: Date | string
    }>
    const row = rows[0]
    if (!row) return null
    return {
      email: row.email,
      passwordHash: row.password_hash,
      name: row.name,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    }
  } catch (err) {
    console.error('credentials-store readFromDb failed:', err)
    return null
  }
}

async function writeToDb(creds: UserCredentials): Promise<boolean> {
  const sql = getSql()
  if (!sql) return false
  try {
    if (!(await ensureSchema())) return false
    await sql`
      INSERT INTO ms_credentials (email, password_hash, name, created_at)
      VALUES (
        ${creds.email},
        ${creds.passwordHash},
        ${creds.name},
        ${creds.createdAt}
      )
      ON CONFLICT (email) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        name = EXCLUDED.name
    `
    return true
  } catch (err) {
    console.error('credentials-store writeToDb failed:', err)
    return false
  }
}

export async function getCredentials(email: string): Promise<UserCredentials | null> {
  const normalized = normalizeEmail(email)
  const fromKv = await readFromKv(normalized)
  if (fromKv) return fromKv
  const fromDb = await readFromDb(normalized)
  if (fromDb) return fromDb
  return readFromFile(normalized)
}

export async function saveCredentials(creds: UserCredentials): Promise<void> {
  const payload: UserCredentials = {
    ...creds,
    email: normalizeEmail(creds.email),
    name: creds.name.trim() || creds.email.split('@')[0],
  }
  const wroteKv = await writeToKv(payload)
  if (wroteKv) return

  const wroteDb = await writeToDb(payload)
  if (wroteDb) return

  const wroteFile = await writeToFile(payload)
  if (!wroteFile) {
    throw new Error(
      'Could not save account. Set DATABASE_URL or KV_REST_API_URL and KV_REST_API_TOKEN on your host.'
    )
  }
}

export async function hasCredentials(email: string): Promise<boolean> {
  const creds = await getCredentials(email)
  return creds !== null
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateEmail(email: string): string | null {
  const e = email.trim().toLowerCase()
  if (!e || !EMAIL_RE.test(e) || e.length > 254) {
    return 'Enter a valid email address.'
  }
  return null
}
