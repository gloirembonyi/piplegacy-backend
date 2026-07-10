import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { getBrokerForUser } from '@/lib/brokers/registry'
import type { BrokerAccount, BrokerId, Position } from '@/lib/brokers/types'

const ALL: BrokerId[] = ['alpaca', 'oanda']

export async function GET(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const accounts: BrokerAccount[] = []
  const positions: Position[] = []
  const errors: { brokerId: BrokerId; error: string }[] = []

  await Promise.all(
    ALL.map(async (id) => {
      const client = await getBrokerForUser(auth.email, id)
      if (!client) return
      try {
        const [acc, pos] = await Promise.all([client.getAccount(), client.getPositions()])
        accounts.push(acc)
        positions.push(...pos)
      } catch (err) {
        errors.push({
          brokerId: id,
          error: err instanceof Error ? err.message : 'Unknown',
        })
      }
    })
  )

  return Response.json({ accounts, positions, errors })
}
