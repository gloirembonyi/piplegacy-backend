/**
 * Encrypted per-user broker credentials store (server-only).
 *
 * - Persists via KV → DB → filesystem (mirrors `lib/credentials-store.ts`).
 * - Secrets are encrypted with AES-GCM (Web Crypto, edge-compatible).
 * - Key material is derived from SESSION_SECRET + the user's email so that
 *   plaintext keys never touch disk and a leaked KV dump can't be decrypted
 *   without the server's SESSION_SECRET.
 *
 * Pure types live in `lib/broker-store-types.ts` for safe client imports.
 */

import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { getDataDir } from '@/lib/data-dir'
import { ensureSchema, getSql } from '@/lib/db'
import { getRedis } from '@/lib/redis'
import {
  base64UrlToBytes,
  bytesToBase64Url,
} from '@/lib/crypto-utils'
import type { BrokerId } from '@/lib/brokers/types'
import type {
  BrokerCredentialMeta,
  BrokerCredentialPayload,
} from '@/lib/broker-store-types'

export type {
  BrokerCredentialMeta,
  BrokerCredentialPayload,
} from '@/lib/broker-store-types'

type StoredEnvelope = {
  email: string
  ciphertext: string
  iv: string
  meta: BrokerCredentialMeta
}

type StoredFile = {
  email: string
  brokers: Record<string, StoredEnvelope>
  updatedAt: string
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function emailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex')
}

function kvKey(email: string): string {
  return `ms:broker:${emailHash(email)}`
}

function filePath(email: string): string {
  return path.join(getDataDir('brokers'), `${emailHash(email)}.json`)
}

function getSecret(): string {
  const s = process.env.SESSION_SECRET
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET must be set (min 16 chars) for broker encryption.')
  }
  return s
}

async function deriveKey(email: string): Promise<CryptoKey> {
  const material = `${getSecret()}|broker|${normalizeEmail(email)}`
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(material)
  )
  return crypto.subtle.importKey(
    'raw',
    hash,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  )
}

async function encryptJson(email: string, value: unknown): Promise<StoredEnvelope> {
  const key = await deriveKey(email)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource
  )
  return {
    email: normalizeEmail(email),
    ciphertext: bytesToBase64Url(new Uint8Array(cipherBuf)),
    iv: bytesToBase64Url(iv),
    meta: {} as BrokerCredentialMeta,
  }
}

async function decryptJson<T>(email: string, env: StoredEnvelope): Promise<T> {
  const key = await deriveKey(email)
  const iv = base64UrlToBytes(env.iv)
  const ct = base64UrlToBytes(env.ciphertext)
  if (!iv || !ct) throw new Error('Corrupted broker credentials envelope')
  // Cast through ArrayBufferLike - Web Crypto's BufferSource isn't generic
  // over the underlying buffer type and Node's lib.d.ts is stricter.
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ct as BufferSource
  )
  const text = new TextDecoder().decode(new Uint8Array(plainBuf))
  return JSON.parse(text) as T
}

// ─── Persistence helpers ─────────────────────────────────────────────

async function readFromFile(email: string): Promise<StoredFile | null> {
  try {
    const raw = await readFile(filePath(email), 'utf-8')
    return JSON.parse(raw) as StoredFile
  } catch {
    return null
  }
}

async function writeToFile(data: StoredFile): Promise<boolean> {
  try {
    await mkdir(getDataDir('brokers'), { recursive: true })
    await writeFile(filePath(data.email), JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('broker-store writeToFile failed:', err)
    return false
  }
}

async function readFromKv(email: string): Promise<StoredFile | null> {
  const redis = getRedis()
  if (!redis) return null
  try {
    return await redis.get<StoredFile>(kvKey(email))
  } catch {
    return null
  }
}

async function writeToKv(data: StoredFile): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return false
  try {
    await redis.set(kvKey(data.email), data)
    return true
  } catch {
    return false
  }
}

async function readFromDb(email: string): Promise<StoredFile | null> {
  const sql = getSql()
  if (!sql) return null
  try {
    if (!(await ensureBrokerSchema())) return null
    const rows = (await sql`
      SELECT data FROM ms_broker_data WHERE email = ${normalizeEmail(email)} LIMIT 1
    `) as Array<{ data: StoredFile }>
    return rows[0]?.data ?? null
  } catch (err) {
    console.error('broker-store readFromDb failed:', err)
    return null
  }
}

async function writeToDb(data: StoredFile): Promise<boolean> {
  const sql = getSql()
  if (!sql) return false
  try {
    if (!(await ensureBrokerSchema())) return false
    await sql`
      INSERT INTO ms_broker_data (email, data, updated_at)
      VALUES (${data.email}, ${data}, ${data.updatedAt})
      ON CONFLICT (email) DO UPDATE SET
        data = EXCLUDED.data,
        updated_at = EXCLUDED.updated_at
    `
    return true
  } catch (err) {
    console.error('broker-store writeToDb failed:', err)
    return false
  }
}

let brokerSchemaReady: Promise<boolean> | null = null
async function ensureBrokerSchema(): Promise<boolean> {
  try {
    if (!(await ensureSchema())) return false
  } catch (err) {
    console.error('broker-store ensureSchema failed:', err)
    return false
  }
  if (!brokerSchemaReady) {
    brokerSchemaReady = (async () => {
      const sql = getSql()
      if (!sql) return false
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS ms_broker_data (
            email TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `
        return true
      } catch (err) {
        console.error('broker-store CREATE TABLE failed:', err)
        return false
      }
    })()
  }
  return brokerSchemaReady
}

async function readAll(email: string): Promise<StoredFile> {
  const normalized = normalizeEmail(email)
  const fromKv = await readFromKv(normalized)
  if (fromKv) return fromKv
  const fromDb = await readFromDb(normalized)
  if (fromDb) return fromDb
  const fromFile = await readFromFile(normalized)
  if (fromFile) return fromFile
  return { email: normalized, brokers: {}, updatedAt: new Date().toISOString() }
}

async function writeAll(data: StoredFile): Promise<void> {
  data.updatedAt = new Date().toISOString()
  if (await writeToKv(data)) return
  if (await writeToDb(data)) return
  await writeToFile(data)
}

// ─── Public API ──────────────────────────────────────────────────────

export async function listBrokers(email: string): Promise<BrokerCredentialMeta[]> {
  const file = await readAll(email)
  return Object.values(file.brokers).map((b) => b.meta)
}

export async function getBrokerMeta(
  email: string,
  brokerId: BrokerId
): Promise<BrokerCredentialMeta | null> {
  const file = await readAll(email)
  return file.brokers[brokerId]?.meta ?? null
}

export async function getBrokerCredential(
  email: string,
  brokerId: BrokerId
): Promise<BrokerCredentialPayload | null> {
  const file = await readAll(email)
  const env = file.brokers[brokerId]
  if (!env) return null
  return decryptJson<BrokerCredentialPayload>(email, env)
}

export async function saveBrokerCredential(
  email: string,
  payload: BrokerCredentialPayload,
  account?: BrokerCredentialMeta['account']
): Promise<BrokerCredentialMeta> {
  const file = await readAll(email)
  const env = await encryptJson(email, payload)
  const meta: BrokerCredentialMeta = {
    brokerId: payload.brokerId,
    env: payload.env,
    connectedAt: file.brokers[payload.brokerId]?.meta.connectedAt ?? new Date().toISOString(),
    lastTestedAt: new Date().toISOString(),
    lastTestOk: true,
    account,
  }
  env.meta = meta
  file.brokers[payload.brokerId] = env
  await writeAll(file)
  return meta
}

export async function updateBrokerMeta(
  email: string,
  brokerId: BrokerId,
  patch: Partial<BrokerCredentialMeta>
): Promise<void> {
  const file = await readAll(email)
  const env = file.brokers[brokerId]
  if (!env) return
  env.meta = { ...env.meta, ...patch }
  await writeAll(file)
}

export async function removeBrokerCredential(
  email: string,
  brokerId: BrokerId
): Promise<void> {
  const file = await readAll(email)
  if (!file.brokers[brokerId]) return
  delete file.brokers[brokerId]
  await writeAll(file)
}
