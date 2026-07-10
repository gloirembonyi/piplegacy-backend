import { NextResponse } from 'next/server'
import { createSession } from '@/lib/auth'
import { hasCredentials, saveCredentials, validateEmail } from '@/lib/credentials-store'
import { hashPassword, validatePasswordStrength } from '@/lib/password'
import { getUserData } from '@/lib/user-store'
import { rateLimit, getClientIp } from '@/lib/rate-limit'
import { isSessionConfigured, isAuthStorageConfigured } from '@/lib/env'

/**
 * @swagger
 * /api/auth/signup:
 *   post:
 *     summary: Create an account with email + password
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
 *               name: { type: string }
 *     responses:
 *       200:
 *         description: Account created, session cookie set
 *       400:
 *         description: Invalid input
 *       409:
 *         description: Account already exists
 *       429:
 *         description: Rate limited
 */
export async function POST(request: Request) {
  if (!isSessionConfigured()) {
    return NextResponse.json(
      { error: 'Server is not configured for sign-up. Contact support.' },
      { status: 503 }
    )
  }

  if (process.env.NODE_ENV === 'production' && !isAuthStorageConfigured()) {
    return NextResponse.json(
      { error: 'Server storage is not configured for sign-up. Set DATABASE_URL on Vercel.' },
      { status: 503 }
    )
  }

  const ip = getClientIp(request)
  const limit = await rateLimit(`signup:${ip}`, 5, 3600)
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many sign-up attempts. Try again later.' },
      { status: 429 }
    )
  }

  try {
    const body = await request.json()
    const email = String(body.email || '').trim()
    const password = String(body.password || '')
    const name = String(body.name || '').trim()

    const emailError = validateEmail(email)
    if (emailError) {
      return NextResponse.json({ error: emailError }, { status: 400 })
    }

    const passwordError = validatePasswordStrength(password)
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 })
    }

    const normalizedEmail = email.toLowerCase()

    if (await hasCredentials(normalizedEmail)) {
      return NextResponse.json(
        { error: 'An account with this email already exists. Sign in instead.' },
        { status: 409 }
      )
    }

    const displayName = name || normalizedEmail.split('@')[0]

    await saveCredentials({
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      name: displayName,
      createdAt: new Date().toISOString(),
    })

    await getUserData(normalizedEmail)
    await createSession({ email: normalizedEmail, name: displayName }, request)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Signup error:', error)
    return NextResponse.json({ error: 'Could not create account' }, { status: 500 })
  }
}
