import { NextResponse } from 'next/server'
import { consumeDesktopExchangeCode } from '@/lib/desktop-auth'
import { encodeSessionToken } from '@/lib/session-token'
import { isSessionConfigured } from '@/lib/env'
import { rateLimit, getClientIp } from '@/lib/rate-limit'

/**
 * @swagger
 * /api/auth/desktop/exchange:
 *   post:
 *     summary: Exchange a one-time desktop OAuth code for a bearer session token
 *     description: >
 *       Called by piplegacy-desktop after it receives a `piplegacy://auth-callback?code=...`
 *       deep link. The code is single-use and expires within minutes.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code:
 *                 type: string
 *     responses:
 *       200:
 *         description: Bearer token issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *                   properties:
 *                     email: { type: string }
 *                     name: { type: string }
 *       400:
 *         description: Missing code
 *       401:
 *         description: Code invalid, already used, or expired
 */
export async function POST(request: Request) {
  if (!isSessionConfigured()) {
    return NextResponse.json({ error: 'Server not configured' }, { status: 500 })
  }

  const ip = getClientIp(request)
  const { ok } = await rateLimit(`desktop-exchange:${ip}`, 20, 900)
  if (!ok) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }

  let code: unknown
  try {
    ;({ code } = await request.json())
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (typeof code !== 'string' || !code) {
    return NextResponse.json({ error: 'Missing code' }, { status: 400 })
  }

  const user = await consumeDesktopExchangeCode(code)
  if (!user) {
    return NextResponse.json({ error: 'Code invalid, already used, or expired' }, { status: 401 })
  }

  const token = await encodeSessionToken(user, 'desktop')
  return NextResponse.json({ token, user })
}
