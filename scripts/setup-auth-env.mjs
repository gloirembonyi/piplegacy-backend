#!/usr/bin/env node
/**
 * Prints required auth env vars for Vercel production.
 * Run: node scripts/setup-auth-env.mjs
 */
import { randomBytes } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const envPath = resolve(process.cwd(), '.env.local')
const vars = {}

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    vars[key] = value
  }
}

const sessionSecret =
  vars.SESSION_SECRET || randomBytes(32).toString('base64url')

console.log(`
=== Auth environment for Vercel (Production) ===

Add these in Vercel → Project → Settings → Environment Variables → Production:

SESSION_SECRET=${sessionSecret}
GOOGLE_CLIENT_ID=${vars.GOOGLE_CLIENT_ID || '<from Google Cloud Console>'}
GOOGLE_CLIENT_SECRET=${vars.GOOGLE_CLIENT_SECRET || '<from Google Cloud Console>'}
DATABASE_URL=${vars.DATABASE_URL || '<your Neon connection string>'}
NEXT_PUBLIC_APP_URL=https://signalmarket-ten.vercel.app
NEXT_PUBLIC_BASE_URL=https://signalmarket-ten.vercel.app

Optional (Upstash Redis - Postgres is used if DATABASE_URL is set):
KV_REST_API_URL=<upstash url>
KV_REST_API_TOKEN=<upstash token>

=== Google OAuth redirect URI ===

In Google Cloud Console → Credentials → your OAuth client, add:

  https://signalmarket-ten.vercel.app/api/auth/google/callback

Keep localhost for local dev:

  http://localhost:3000/api/auth/google/callback

After saving env vars in Vercel, redeploy the project.
`)

if (!vars.SESSION_SECRET) {
  console.log(
    `Tip: add SESSION_SECRET=${sessionSecret} to your .env.local file.\n`
  )
}
