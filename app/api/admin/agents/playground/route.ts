import { NextResponse } from 'next/server'
import {
  executePlaygroundAgent,
  executePlaygroundTool,
  getPlaygroundCatalog,
  type PlaygroundContext,
} from '@/lib/admin-agent-playground'
import { isAuthSession } from '@/lib/require-auth'
import { requireAdmin } from '@/lib/require-admin'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!isAuthSession(auth)) return auth

  const catalog = getPlaygroundCatalog()
  return NextResponse.json({
    timestamp: new Date().toISOString(),
    ...catalog,
  })
}

type ExecuteBody = {
  kind: 'tool' | 'agent'
  id: string
  args?: Record<string, unknown>
  context?: PlaygroundContext
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request)
  if (!isAuthSession(auth)) return auth

  let body: ExecuteBody
  try {
    body = (await request.json()) as ExecuteBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  if (!body?.id || !body?.kind) {
    return NextResponse.json({ error: 'kind and id are required.' }, { status: 400 })
  }

  const args = body.args && typeof body.args === 'object' ? body.args : {}
  const context = body.context

  const result =
    body.kind === 'tool'
      ? await executePlaygroundTool(body.id, args, context)
      : await executePlaygroundAgent(body.id, args, context)

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    kind: body.kind,
    id: body.id,
    ...result,
  })
}
