import { NextResponse } from 'next/server'
import { listAdminUsers } from '@/lib/admin-users'
import { isAuthSession } from '@/lib/require-auth'
import { requireAdmin } from '@/lib/require-admin'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!isAuthSession(auth)) return auth

  const users = await listAdminUsers()
  return NextResponse.json({ users, count: users.length })
}
