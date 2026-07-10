import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { listBrokers } from '@/lib/broker-store'

export async function GET(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth
  const list = await listBrokers(auth.email)
  return Response.json({ brokers: list })
}
