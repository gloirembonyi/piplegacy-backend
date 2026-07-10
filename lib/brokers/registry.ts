/**
 * Per-user broker registry - looks up encrypted credentials and returns a
 * ready `BrokerClient`. Used by API routes (`/api/bot/trade`,
 * `/api/brokers/account`) and the cron scanner.
 */

import { AlpacaBroker } from '@/lib/brokers/alpaca'
import { OandaBroker } from '@/lib/brokers/oanda'
import { brokerSupportsSymbol, getSymbolAssetClass, brokerMismatchMessage } from '@/lib/brokers/symbol-support'
import type { BrokerClient, BrokerId } from '@/lib/brokers/types'
import { getBrokerCredential } from '@/lib/broker-store'

export {
  brokerSupportsSymbol,
  compatibleBrokers,
  getSymbolAssetClass,
  pickPreferredBrokerId,
  brokerMismatchMessage,
} from '@/lib/brokers/symbol-support'

/** Builds a broker client from an explicit credential payload - used by the
 *  "Test connection" path before we persist anything. */
export function buildBrokerClient(
  cred:
    | { brokerId: 'alpaca'; env: 'paper' | 'live'; keyId: string; secret: string }
    | { brokerId: 'oanda'; env: 'paper' | 'live'; token: string; accountId: string }
): BrokerClient {
  if (cred.brokerId === 'alpaca') {
    return new AlpacaBroker({ keyId: cred.keyId, secret: cred.secret, env: cred.env })
  }
  return new OandaBroker({
    token: cred.token,
    accountId: cred.accountId,
    env: cred.env,
  })
}

/** Resolves the user's saved credentials and returns a ready client, or null
 *  if they haven't connected this broker yet. */
export async function getBrokerForUser(
  email: string,
  brokerId: BrokerId
): Promise<BrokerClient | null> {
  const cred = await getBrokerCredential(email, brokerId)
  if (!cred) return null
  return buildBrokerClient(cred)
}

/** True if at least one broker is connected. */
export async function userHasAnyBroker(email: string): Promise<boolean> {
  return (
    (await getBrokerCredential(email, 'alpaca')) !== null ||
    (await getBrokerCredential(email, 'oanda')) !== null
  )
}

/**
 * Pick the right broker for a symbol's asset class.
 * - Forex / metals → OANDA
 * - Stocks / crypto → Alpaca
 * Falls back to whichever is connected if the preferred one isn't.
 */
export async function pickBrokerForSymbol(
  email: string,
  symbol: string
): Promise<BrokerClient | null> {
  const asset = getSymbolAssetClass(symbol)
  const order: BrokerId[] =
    asset === 'forex' || asset === 'metal'
      ? ['oanda', 'alpaca']
      : ['alpaca', 'oanda']

  for (const id of order) {
    if (!brokerSupportsSymbol(id, symbol)) continue
    const client = await getBrokerForUser(email, id)
    if (client) return client
  }
  return null
}

/** Resolve a broker client that can actually route orders for this symbol. */
export async function resolveBrokerForTrade(
  email: string,
  symbol: string,
  preferredBrokerId?: BrokerId
): Promise<{ client: BrokerClient | null; reason?: string }> {
  if (preferredBrokerId) {
    if (!brokerSupportsSymbol(preferredBrokerId, symbol)) {
      const fallback = await pickBrokerForSymbol(email, symbol)
      if (fallback) return { client: fallback }
      return {
        client: null,
        reason:
          brokerMismatchMessage(symbol, preferredBrokerId) ??
          `${preferredBrokerId} cannot trade ${symbol}`,
      }
    }
    const client = await getBrokerForUser(email, preferredBrokerId)
    if (client) return { client }
    return { client: null, reason: `${preferredBrokerId} is not connected` }
  }

  const client = await pickBrokerForSymbol(email, symbol)
  if (client) return { client }
  const asset = getSymbolAssetClass(symbol)
  if (asset === 'forex' || asset === 'metal') {
    return {
      client: null,
      reason: `Connect OANDA to trade ${symbol} (forex/metals). Alpaca only supports stocks and crypto.`,
    }
  }
  return { client: null, reason: 'No compatible broker connected for this symbol' }
}
