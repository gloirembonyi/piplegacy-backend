import { NextResponse } from 'next/server'
import { createSession } from '@/lib/auth'
import { getCredentials, validateEmail } from '@/lib/credentials-store'
import { verifyPassword } from '@/lib/password'
import { getUserData } from '@/lib/user-store'
import { rateLimit, getClientIp } from '@/lib/rate-limit'
import { isSessionConfigured } from '@/lib/env'

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Sign in with email + password
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Session cookie set
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Invalid credentials
 *       429:
 *         description: Rate limited
 */
export async function POST(request: Request) {
  if (!isSessionConfigured()) {
    return NextResponse.json(
      { error: 'Server is not configured for sign-in. Contact support.' },
      { status: 503 }
    )
  }

  const ip = getClientIp(request)
  const limit = await rateLimit(`login:${ip}`, 10, 900)
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many login attempts. Try again later.' },
      { status: 429 }
    )
  }

  try {
    const body = await request.json()
    const email = String(body.email || '').trim()
    const password = String(body.password || '')

    const emailError = validateEmail(email)
    if (emailError) {
      return NextResponse.json({ error: emailError }, { status: 400 })
    }

    if (!password) {
      return NextResponse.json({ error: 'Password is required.' }, { status: 400 })
    }

    const normalizedEmail = email.toLowerCase()
    const creds = await getCredentials(normalizedEmail)

    if (!creds || !verifyPassword(password, creds.passwordHash)) {
      return NextResponse.json(
        { error: 'Invalid email or password.' },
        { status: 401 }
      )
    }

    await createSession({ email: normalizedEmail, name: creds.name }, request)
    await getUserData(normalizedEmail)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Login error:', error)
    return NextResponse.json({ error: 'Login failed' }, { status: 500 })
  }
}
