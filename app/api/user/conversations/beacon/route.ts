import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import {
  isValidConversationScope,
  persistConversation,
} from '@/lib/conversation-store'
import type { StoredChatMessage } from '@/lib/user-types'

export const dynamic = 'force-dynamic'

/**
 * Beacon endpoint used by `navigator.sendBeacon` on page unload to flush the
 * very latest conversation state. Accepts a JSON body identical to PUT
 * /api/user/conversations, but returns 204 quickly so the browser doesn't
 * delay unload.
 */
export async function POST(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  try {
    const body = await request.json()
    const scope = typeof body?.scope === 'string' ? body.scope : ''
    if (!isValidConversationScope(scope)) {
      return new NextResponse(null, { status: 204 })
    }
    const messages = Array.isArray(body?.messages)
      ? (body.messages as StoredChatMessage[])
      : []
    const title = typeof body?.title === 'string' ? body.title : undefined
    await persistConversation(auth.email, scope, messages, title)
  } catch {
    /* ignore - beacons are best-effort */
  }
  return new NextResponse(null, { status: 204 })
}
