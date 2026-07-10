import { neon } from '@neondatabase/serverless'

let sql: ReturnType<typeof neon> | null = null
let schemaReady: Promise<boolean> | null = null

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim())
}

export function getSql() {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) return null
  if (!sql) {
    try {
      sql = neon(url)
    } catch (err) {
      console.error('neon() failed to initialise:', err)
      return null
    }
  }
  return sql
}

export async function ensureSchema(): Promise<boolean> {
  const query = getSql()
  if (!query) return false

  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await query`
          CREATE TABLE IF NOT EXISTS ms_credentials (
            email TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `
        await query`
          CREATE TABLE IF NOT EXISTS ms_user_data (
            email TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `
        await query`
          CREATE TABLE IF NOT EXISTS ms_admin_roles (
            email TEXT PRIMARY KEY,
            role TEXT NOT NULL CHECK (role IN ('super', 'admin')),
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `
        return true
      } catch (err) {
        // Reset on failure so a later call can retry once the network recovers.
        schemaReady = null
        console.error('ensureSchema failed:', err)
        return false
      }
    })()
  }

  return schemaReady
}
