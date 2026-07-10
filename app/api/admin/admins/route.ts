import { NextResponse } from 'next/server'
import { addAdmin, listAdmins, removeAdmin } from '@/lib/admin-store'
import { isAuthSession } from '@/lib/require-auth'
import { requireSuperAdmin } from '@/lib/require-admin'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireSuperAdmin(request)
  if (!isAuthSession(auth)) return auth

  const admins = await listAdmins()
  return NextResponse.json({ admins, count: admins.length })
}

export async function POST(request: Request) {
  const auth = await requireSuperAdmin(request)
  if (!isAuthSession(auth)) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const email =
    typeof body === 'object' && body !== null && 'email' in body
      ? String((body as { email: unknown }).email).trim().toLowerCase()
      : ''
  const roleRaw =
    typeof body === 'object' && body !== null && 'role' in body
      ? String((body as { role: unknown }).role)
      : 'admin'
  const role = roleRaw === 'super' ? 'super' : 'admin'

  if (!email.includes('@')) {
    return NextResponse.json({ error: 'Valid email required' }, { status: 400 })
  }

  const result = await addAdmin(email, role, auth.email)
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Failed to add admin' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, email, role })
}

export async function DELETE(request: Request) {
  const auth = await requireSuperAdmin(request)
  if (!isAuthSession(auth)) return auth

  const url = new URL(request.url)
  const email = url.searchParams.get('email')?.trim().toLowerCase()
  if (!email) {
    return NextResponse.json({ error: 'email query param required' }, { status: 400 })
  }

  if (email === auth.email.toLowerCase()) {
    return NextResponse.json({ error: 'You cannot remove yourself.' }, { status: 400 })
  }

  const result = await removeAdmin(email)
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Failed to remove admin' }, { status: 400 })
  }

  return NextResponse.json({ ok: true, email })
}
