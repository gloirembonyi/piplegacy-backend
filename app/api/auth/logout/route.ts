import { NextResponse } from 'next/server'
import { getSessionCookieOptions } from '@/lib/auth'
import { isSecureRequest } from '@/lib/env'
import { OAUTH_STATE_COOKIE } from '@/lib/oauth-state'
import { SESSION_COOKIE } from '@/lib/session-token'

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Clear the web session cookie
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       200:
 *         description: Session cleared
 */
export async function POST(request: Request) {
  const secure = isSecureRequest(request)
  const cleared = getSessionCookieOptions(secure)

  const response = NextResponse.json({ success: true })
  response.cookies.set(SESSION_COOKIE, '', { ...cleared, maxAge: 0 })
  response.cookies.delete(OAUTH_STATE_COOKIE)

  return response
}
