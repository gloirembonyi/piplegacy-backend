import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { rateLimit } from '@/lib/rate-limit'
import {
  getBrokerMeta,
  removeBrokerCredential,
  saveBrokerCredential,
  updateBrokerMeta,
  type BrokerCredentialPayload,
} from '@/lib/broker-store'
import { buildBrokerClient } from '@/lib/brokers/registry'
import type { BrokerEnv, BrokerId } from '@/lib/brokers/types'

const VALID_BROKERS: BrokerId[] = ['alpaca', 'oanda']

type ConnectAlpacaBody = {
  env?: BrokerEnv
  keyId?: string
  secret?: string
}

type ConnectOandaBody = {
  env?: BrokerEnv
  token?: string
  accountId?: string
}

function isValidBrokerId(value: string): value is BrokerId {
  return (VALID_BROKERS as string[]).includes(value)
}

function asEnv(v: unknown): BrokerEnv {
  return v === 'live' ? 'live' : 'paper'
}

function parsePayload(brokerId: BrokerId, body: unknown): BrokerCredentialPayload | null {
  if (!body || typeof body !== 'object') return null
  if (brokerId === 'alpaca') {
    const b = body as ConnectAlpacaBody
    if (!b.keyId || !b.secret) return null
    return { brokerId: 'alpaca', env: asEnv(b.env), keyId: b.keyId, secret: b.secret }
  }
  const b = body as ConnectOandaBody
  if (!b.token || !b.accountId) return null
  return { brokerId: 'oanda', env: asEnv(b.env), token: b.token, accountId: b.accountId }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ broker: string }> }
) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const { broker: brokerParam } = await ctx.params
  if (!isValidBrokerId(brokerParam)) {
    return Response.json({ error: 'Unknown broker' }, { status: 400 })
  }

  const rl = await rateLimit(`broker:connect:${auth.email}`, 20, 600)
  if (!rl.ok) {
    return Response.json(
      { error: 'Too many broker requests. Try again later.' },
      { status: 429 }
    )
  }

  const body = (await req.json().catch(() => null)) as unknown
  const payload = parsePayload(brokerParam, body)
  if (!payload) {
    return Response.json({ error: 'Missing or invalid credentials' }, { status: 400 })
  }

  const client = buildBrokerClient(payload)
  let account
  try {
    account = await client.getAccount()
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Connection test failed'
    return Response.json({ error: msg }, { status: 400 })
  }

  const meta = await saveBrokerCredential(auth.email, payload, {
    currency: account.currency,
    equity: account.equity,
    accountId: account.accountId,
  })

  return Response.json({ ok: true, meta, account })
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ broker: string }> }
) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth
  const { broker: brokerParam } = await ctx.params
  if (!isValidBrokerId(brokerParam)) {
    return Response.json({ error: 'Unknown broker' }, { status: 400 })
  }
  const meta = await getBrokerMeta(auth.email, brokerParam)
  if (!meta) return Response.json({ connected: false })
  return Response.json({ connected: true, meta })
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ broker: string }> }
) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth
  const { broker: brokerParam } = await ctx.params
  if (!isValidBrokerId(brokerParam)) {
    return Response.json({ error: 'Unknown broker' }, { status: 400 })
  }
  await removeBrokerCredential(auth.email, brokerParam)
  return Response.json({ ok: true })
}

/** PATCH = "test connection" (no body needed). */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ broker: string }> }
) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth
  const { broker: brokerParam } = await ctx.params
  if (!isValidBrokerId(brokerParam)) {
    return Response.json({ error: 'Unknown broker' }, { status: 400 })
  }
  const { getBrokerForUser } = await import('@/lib/brokers/registry')
  const client = await getBrokerForUser(auth.email, brokerParam)
  if (!client) return Response.json({ error: 'Not connected' }, { status: 404 })

  const ping = await client.ping()
  await updateBrokerMeta(auth.email, brokerParam, {
    lastTestedAt: new Date().toISOString(),
    lastTestOk: ping.ok,
  })
  return Response.json(ping)
}
