#!/usr/bin/env node
/**
 * Create or update the bootstrap super-admin account + role.
 *
 * Usage (password never stored in repo):
 *   SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD='YourPass123!' pnpm seed:super-admin
 *
 * Or add SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD to .env.local (gitignored).
 */
import { randomBytes, scryptSync } from 'crypto'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'
import { createHash } from 'crypto'

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function loadEnvLocal() {
  const envPath = resolve(process.cwd(), '.env.local')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (process.env[key]) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, SCRYPT_OPTIONS)
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`
}

function getDataDir(subdir) {
  const base = process.env.VERCEL
    ? join('/tmp', 'market-signal')
    : join(process.cwd(), '.data')
  return join(base, subdir)
}

function credFilePath(email) {
  const hash = createHash('sha256').update(email.toLowerCase()).digest('hex')
  return join(getDataDir('credentials'), `${hash}.json`)
}

function userFilePath(email) {
  const hash = createHash('sha256').update(email.toLowerCase()).digest('hex')
  return join(getDataDir('users'), `${hash}.json`)
}

async function saveToDb(email, passwordHash, name) {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) return false
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(url)
  const now = new Date().toISOString()

  await sql`
    CREATE TABLE IF NOT EXISTS ms_credentials (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS ms_user_data (
      email TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS ms_admin_roles (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('super', 'admin')),
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    INSERT INTO ms_credentials (email, password_hash, name, created_at)
    VALUES (${email}, ${passwordHash}, ${name}, ${now})
    ON CONFLICT (email) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      name = EXCLUDED.name
  `

  const userData = {
    email,
    watchlist: ['OANDA:XAU_USD', 'BINANCE:BTCUSDT', 'SPY'],
    favorites: ['OANDA:XAU_USD', 'BINANCE:BTCUSDT'],
    analyses: [],
    conversations: {},
    preferences: {},
    plan: 'enterprise',
    planSource: 'manual',
    createdAt: now,
    updatedAt: now,
  }

  await sql`
    INSERT INTO ms_user_data (email, data, updated_at)
    VALUES (${email}, ${userData}, ${now})
    ON CONFLICT (email) DO UPDATE SET
      data = ms_user_data.data,
      updated_at = EXCLUDED.updated_at
  `

  await sql`
    INSERT INTO ms_admin_roles (email, role, created_by, created_at)
    VALUES (${email}, ${'super'}, ${'seed:super-admin'}, ${now})
    ON CONFLICT (email) DO UPDATE SET role = 'super'
  `

  return true
}

function saveToFiles(email, passwordHash, name) {
  const now = new Date().toISOString()
  mkdirSync(getDataDir('credentials'), { recursive: true })
  mkdirSync(getDataDir('users'), { recursive: true })
  mkdirSync(getDataDir('admin'), { recursive: true })

  writeFileSync(
    credFilePath(email),
    JSON.stringify({ email, passwordHash, name, createdAt: now }, null, 2)
  )

  const userData = {
    email,
    watchlist: ['OANDA:XAU_USD', 'BINANCE:BTCUSDT', 'SPY'],
    favorites: ['OANDA:XAU_USD', 'BINANCE:BTCUSDT'],
    analyses: [],
    conversations: {},
    preferences: {},
    plan: 'enterprise',
    planSource: 'manual',
    createdAt: now,
    updatedAt: now,
  }
  writeFileSync(userFilePath(email), JSON.stringify(userData, null, 2))

  writeFileSync(
    join(getDataDir('admin'), 'admins.json'),
    JSON.stringify(
      [{ email, role: 'super', createdBy: 'seed:super-admin', createdAt: now }],
      null,
      2
    )
  )
  return true
}

async function main() {
  loadEnvLocal()

  const email = (process.env.SUPER_ADMIN_EMAIL || process.argv[2] || '').trim().toLowerCase()
  const password = process.env.SUPER_ADMIN_PASSWORD || process.argv[3] || ''
  const name = (process.env.SUPER_ADMIN_NAME || 'Gloire Admin').trim()

  if (!email || !email.includes('@')) {
    console.error('Missing SUPER_ADMIN_EMAIL. Example:')
    console.error("  SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD='Pass123!' pnpm seed:super-admin")
    process.exit(1)
  }
  if (!password || password.length < 8) {
    console.error('Missing or weak SUPER_ADMIN_PASSWORD (min 8 chars).')
    process.exit(1)
  }

  const passwordHash = hashPassword(password)

  let storage = 'files'
  if (await saveToDb(email, passwordHash, name)) {
    storage = 'database'
  } else {
    saveToFiles(email, passwordHash, name)
  }

  console.log('')
  console.log('Super admin account ready.')
  console.log(`  Email:   ${email}`)
  console.log(`  Storage: ${storage}`)
  console.log(`  Role:    super admin`)
  console.log('')
  console.log('Sign in at /login then open /admin')
  console.log('Use Admin → Admins to add other admin accounts.')
  console.log('')
  console.log('For Vercel, also set:')
  console.log(`  SUPER_ADMIN_EMAIL=${email}`)
  console.log('  (Do NOT put the password in Vercel - only run this seed against production DATABASE_URL locally once.)')
  console.log('')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
