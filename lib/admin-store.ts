import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { getDataDir } from '@/lib/data-dir'
import { ensureSchema, getSql } from '@/lib/db'

export type AdminRole = 'super' | 'admin'

export type AdminRecord = {
  email: string
  role: AdminRole
  createdBy: string | null
  createdAt: string
}

const ADMIN_FILE = 'admins.json'

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function getEnvAdminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS?.trim()
  if (!raw) return []
  return [...new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))]
}

function getSuperAdminBootstrapEmail(): string | null {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase()
  return email && email.includes('@') ? email : null
}

async function readAdminsFile(): Promise<AdminRecord[]> {
  try {
    const raw = await readFile(path.join(getDataDir('admin'), ADMIN_FILE), 'utf-8')
    const parsed = JSON.parse(raw) as AdminRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeAdminsFile(admins: AdminRecord[]): Promise<boolean> {
  try {
    const dir = getDataDir('admin')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, ADMIN_FILE), JSON.stringify(admins, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('[admin-store] writeAdminsFile failed:', err)
    return false
  }
}

async function readAdminsDb(): Promise<AdminRecord[]> {
  const sql = getSql()
  if (!sql || !(await ensureSchema())) return []
  try {
    const rows = (await sql`
      SELECT email, role, created_by, created_at
      FROM ms_admin_roles
      ORDER BY created_at ASC
    `) as Array<{
      email: string
      role: AdminRole
      created_by: string | null
      created_at: Date | string
    }>
    return rows.map((r) => ({
      email: normalizeEmail(r.email),
      role: r.role === 'super' ? 'super' : 'admin',
      createdBy: r.created_by,
      createdAt:
        r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }))
  } catch (err) {
    console.error('[admin-store] readAdminsDb failed:', err)
    return []
  }
}

async function upsertAdminDb(record: AdminRecord): Promise<boolean> {
  const sql = getSql()
  if (!sql || !(await ensureSchema())) return false
  try {
    await sql`
      INSERT INTO ms_admin_roles (email, role, created_by, created_at)
      VALUES (
        ${record.email},
        ${record.role},
        ${record.createdBy},
        ${record.createdAt}
      )
      ON CONFLICT (email) DO UPDATE SET
        role = EXCLUDED.role,
        created_by = COALESCE(ms_admin_roles.created_by, EXCLUDED.created_by)
    `
    return true
  } catch (err) {
    console.error('[admin-store] upsertAdminDb failed:', err)
    return false
  }
}

async function deleteAdminDb(email: string): Promise<boolean> {
  const sql = getSql()
  if (!sql || !(await ensureSchema())) return false
  try {
    await sql`DELETE FROM ms_admin_roles WHERE email = ${normalizeEmail(email)}`
    return true
  } catch (err) {
    console.error('[admin-store] deleteAdminDb failed:', err)
    return false
  }
}

/** Merge DB + file records; DB wins on conflict. */
async function listAdminRecords(): Promise<AdminRecord[]> {
  const [fromDb, fromFile] = await Promise.all([readAdminsDb(), readAdminsFile()])
  const byEmail = new Map<string, AdminRecord>()
  for (const r of fromFile) byEmail.set(r.email, r)
  for (const r of fromDb) byEmail.set(r.email, r)
  return [...byEmail.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )
}

export async function isAdminConfiguredAsync(): Promise<boolean> {
  const records = await listAdminRecords()
  if (records.length > 0) return true
  if (getEnvAdminEmails().length > 0) return true
  return Boolean(getSuperAdminBootstrapEmail())
}

export async function isUserAdmin(email: string | undefined | null): Promise<boolean> {
  if (!email) return false
  const normalized = normalizeEmail(email)
  const bootstrap = getSuperAdminBootstrapEmail()
  if (bootstrap === normalized) return true
  const records = await listAdminRecords()
  if (records.some((r) => r.email === normalized)) return true
  return getEnvAdminEmails().includes(normalized)
}

export async function isUserSuperAdmin(email: string | undefined | null): Promise<boolean> {
  if (!email) return false
  const normalized = normalizeEmail(email)
  const records = await listAdminRecords()
  const match = records.find((r) => r.email === normalized)
  if (match) return match.role === 'super'
  const bootstrap = getSuperAdminBootstrapEmail()
  return bootstrap === normalized
}

export async function listAdmins(): Promise<AdminRecord[]> {
  return listAdminRecords()
}

export async function addAdmin(
  email: string,
  role: AdminRole,
  createdBy: string
): Promise<{ ok: boolean; error?: string }> {
  const normalized = normalizeEmail(email)
  if (!normalized.includes('@')) {
    return { ok: false, error: 'Invalid email' }
  }

  const record: AdminRecord = {
    email: normalized,
    role,
    createdBy,
    createdAt: new Date().toISOString(),
  }

  const wroteDb = await upsertAdminDb(record)
  if (wroteDb) return { ok: true }

  const admins = await readAdminsFile()
  const idx = admins.findIndex((a) => a.email === normalized)
  if (idx >= 0) admins[idx] = record
  else admins.push(record)
  const wroteFile = await writeAdminsFile(admins)
  if (!wroteFile) {
    return { ok: false, error: 'Could not save admin role. Set DATABASE_URL on the server.' }
  }
  return { ok: true }
}

export async function removeAdmin(
  email: string,
  opts?: { allowRemoveSuper?: boolean }
): Promise<{ ok: boolean; error?: string }> {
  const normalized = normalizeEmail(email)
  const records = await listAdminRecords()
  const target = records.find((r) => r.email === normalized)
  if (!target) return { ok: false, error: 'Admin not found' }
  if (target.role === 'super' && !opts?.allowRemoveSuper) {
    const supers = records.filter((r) => r.role === 'super')
    if (supers.length <= 1) {
      return { ok: false, error: 'Cannot remove the only super admin.' }
    }
  }

  await deleteAdminDb(normalized)
  const fileAdmins = (await readAdminsFile()).filter((a) => a.email !== normalized)
  await writeAdminsFile(fileAdmins)
  return { ok: true }
}

/** Ensure SUPER_ADMIN_EMAIL from env has super role in DB (idempotent). */
export async function ensureBootstrapSuperAdmin(): Promise<void> {
  const email = getSuperAdminBootstrapEmail()
  if (!email) return
  const existing = await listAdminRecords()
  if (existing.some((r) => r.email === email)) return
  await addAdmin(email, 'super', 'system:bootstrap')
}

/** Safe display id for logs. */
export function adminEmailTag(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 8)
}
