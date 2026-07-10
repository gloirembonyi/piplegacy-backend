import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { getUserData, updatePreferences } from '@/lib/user-store'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const data = await getUserData(auth.email)
  return NextResponse.json({
    preferences: data.preferences ?? {},
    email: auth.email,
  })
}

export async function PATCH(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  let patch: Record<string, unknown>
  try {
    patch = (await request.json()) ?? {}
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const data = await updatePreferences(auth.email, patch)
  return NextResponse.json({
    preferences: data.preferences ?? {},
    email: auth.email,
  })
}
