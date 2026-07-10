import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { listTradeLog } from '@/lib/trade-log-store'

export async function GET(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const url = new URL(req.url)
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50')))
  const symbol = url.searchParams.get('symbol')?.toUpperCase()
  let entries = await listTradeLog(auth.email, limit)
  if (symbol) {
    entries = entries.filter((e) => e.symbol.toUpperCase() === symbol)
  }
  return Response.json({ entries })
}
