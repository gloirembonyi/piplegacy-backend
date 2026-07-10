import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import {
  getConversation,
  isValidConversationScope,
  listConversations,
  persistConversation,
  removeAllConversations,
  removeConversation,
} from '@/lib/conversation-store'
import type { StoredChatMessage } from '@/lib/user-types'

export const dynamic = 'force-dynamic'

/**
 * GET - list all conversations for the current user, OR fetch a single
 * conversation when `?scope=<scope>` is passed.
 */
export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const url = new URL(request.url)
  const scope = url.searchParams.get('scope')

  if (scope) {
    if (!isValidConversationScope(scope)) {
      return NextResponse.json({ error: 'Invalid scope' }, { status: 400 })
    }
    const conv = await getConversation(auth.email, scope)
    return NextResponse.json({
      scope,
      conversation: conv ?? { scope, messages: [], updatedAt: '' },
    })
  }

  const conversations = await listConversations(auth.email)
  // Return a compact summary; full messages are fetched via ?scope=.
  return NextResponse.json({
    conversations: conversations.map((c) => ({
      scope: c.scope,
      title: c.title,
      messageCount: c.messages.length,
      updatedAt: c.updatedAt,
      lastUserMessage:
        c.messages.filter((m) => m.role === 'user').slice(-1)[0]?.content?.slice(0, 120) ??
        '',
    })),
  })
}

/**
 * PUT - replace the messages array for a single scope. The client sends the
 * full message list it currently holds; the server clamps + sanitizes.
 */
export async function PUT(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  let body: { scope?: unknown; messages?: unknown; title?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const scope = typeof body.scope === 'string' ? body.scope : ''
  if (!isValidConversationScope(scope)) {
    return NextResponse.json({ error: 'Invalid scope' }, { status: 400 })
  }

  const messages = Array.isArray(body.messages)
    ? (body.messages as StoredChatMessage[])
    : []
  const title = typeof body.title === 'string' ? body.title : undefined

  const conv = await persistConversation(auth.email, scope, messages, title)
  if (!conv) {
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
  return NextResponse.json({ scope, conversation: conv })
}

/**
 * DELETE - clear a single scope (`?scope=...`) or all conversations (`?all=1`).
 */
export async function DELETE(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const url = new URL(request.url)
  if (url.searchParams.get('all') === '1') {
    await removeAllConversations(auth.email)
    return NextResponse.json({ ok: true, cleared: 'all' })
  }

  const scope = url.searchParams.get('scope')
  if (!scope || !isValidConversationScope(scope)) {
    return NextResponse.json({ error: 'Invalid scope' }, { status: 400 })
  }
  const ok = await removeConversation(auth.email, scope)
  return NextResponse.json({ ok, scope })
}
