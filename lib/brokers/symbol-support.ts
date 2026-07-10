/**
 * Symbol ↔ broker compatibility helpers.
 *
 * Alpaca routes stocks + crypto only. OANDA routes forex + metals.
 * The UI and trade API use these to auto-pick the right broker and surface
 * clear errors instead of opaque 422 responses like `asset "XAUUSD" not found`.
 */

import { normalizeSymbol } from '@/lib/symbols'
import type { AssetClass, BrokerId } from '@/lib/brokers/types'

export function getSymbolAssetClass(symbol: string): AssetClass {
  const upper = normalizeSymbol(symbol)
  const bare = upper.includes(':') ? (upper.split(':')[1] ?? upper) : upper

  if (upper.startsWith('XAU') || upper.startsWith('XAG') || bare.startsWith('XAU') || bare.startsWith('XAG')) {
    return 'metal'
  }

  const cryptoPrefixes = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC', 'AVAX', 'BNB', 'ADA']
  if (cryptoPrefixes.some((p) => upper.startsWith(p) || bare.startsWith(p))) {
    return 'crypto'
  }

  // Six-letter pairs: EURUSD, GBPUSD, USDJPY, etc.
  const pair = bare.replace(/[^A-Z]/g, '')
  if (/^[A-Z]{6}$/.test(pair)) {
    return 'forex'
  }

  // Alpaca-style dashed crypto (BTC/USD).
  if (bare.includes('/')) {
    return 'crypto'
  }

  // Default - treat as US equity ticker.
  if (/^[A-Z]{1,5}$/.test(bare)) {
    return 'stock'
  }

  return 'other'
}

const BROKER_ASSETS: Record<BrokerId, AssetClass[]> = {
  alpaca: ['stock', 'crypto'],
  oanda: ['forex', 'metal'],
}

export function brokerSupportsSymbol(brokerId: BrokerId, symbol: string): boolean {
  const asset = getSymbolAssetClass(symbol)
  if (asset === 'other') return false
  return BROKER_ASSETS[brokerId].includes(asset)
}

/** Preferred broker order for a symbol; filters to only those connected. */
export function compatibleBrokers(
  symbol: string,
  connected: BrokerId[]
): BrokerId[] {
  const asset = getSymbolAssetClass(symbol)
  const order: BrokerId[] =
    asset === 'forex' || asset === 'metal'
      ? ['oanda', 'alpaca']
      : asset === 'stock' || asset === 'crypto'
        ? ['alpaca', 'oanda']
        : ['oanda', 'alpaca']

  const supported = order.filter((id) => connected.includes(id) && brokerSupportsSymbol(id, symbol))
  return supported
}

export function pickPreferredBrokerId(
  symbol: string,
  connected: BrokerId[]
): BrokerId | null {
  const list = compatibleBrokers(symbol, connected)
  return list[0] ?? null
}

export function brokerMismatchMessage(symbol: string, brokerId: BrokerId): string | null {
  if (brokerSupportsSymbol(brokerId, symbol)) return null
  const asset = getSymbolAssetClass(symbol)
  if (brokerId === 'alpaca' && (asset === 'forex' || asset === 'metal')) {
    return `${symbol} is ${asset === 'metal' ? 'a metal' : 'forex'} - Alpaca only supports stocks and crypto. Connect OANDA for ${symbol}.`
  }
  if (brokerId === 'oanda' && (asset === 'stock' || asset === 'crypto')) {
    return `${symbol} is ${asset} - OANDA only supports forex and metals. Use Alpaca for ${symbol}.`
  }
  return `${brokerId} cannot trade ${symbol}.`
}
