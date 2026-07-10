/**
 * Alpaca Markets v2 REST client.
 *
 * Docs: https://docs.alpaca.markets/reference
 * Paper:  https://paper-api.alpaca.markets
 * Live:   https://api.alpaca.markets
 *
 * The free paper environment is the safe default - `env: 'live'` only flips the
 * base URL; it does NOT bypass the per-strategy "live-mode" toggle elsewhere.
 */

import { displaySymbolLabel, normalizeSymbol } from '@/lib/symbols'
import {
  BrokerError,
  type BrokerAccount,
  type BrokerCapabilities,
  type BrokerClient,
  type BrokerEnv,
  type Order,
  type OrderRequest,
  type OrderStatus,
  type Position,
} from '@/lib/brokers/types'

const ALPACA_BASE = {
  paper: 'https://paper-api.alpaca.markets',
  live: 'https://api.alpaca.markets',
} as const

/** Alpaca uses dashed crypto pairs (BTC/USD); normalize common forms. */
function toAlpacaSymbol(symbol: string): string {
  const upper = normalizeSymbol(symbol)
  if (upper.includes('/')) return upper
  if (upper.includes(':')) {
    const tail = upper.split(':')[1] ?? upper
    return toAlpacaSymbol(tail)
  }
  const cryptoMap: Record<string, string> = {
    BTCUSD: 'BTC/USD',
    BTCUSDT: 'BTC/USDT',
    ETHUSD: 'ETH/USD',
    ETHUSDT: 'ETH/USDT',
    SOLUSD: 'SOL/USD',
    SOLUSDT: 'SOL/USDT',
    XRPUSD: 'XRP/USD',
    DOGEUSD: 'DOGE/USD',
    AVAXUSD: 'AVAX/USD',
    LTCUSD: 'LTC/USD',
  }
  return cryptoMap[upper] ?? upper
}

function fromAlpacaStatus(status: string): OrderStatus {
  const s = status.toLowerCase()
  if (s === 'filled') return 'filled'
  if (s === 'partially_filled') return 'partially_filled'
  if (s === 'canceled' || s === 'cancelled') return 'cancelled'
  if (s === 'rejected') return 'rejected'
  if (s === 'expired') return 'expired'
  if (s === 'new' || s === 'accepted' || s === 'pending_new') return 'open'
  return 'pending'
}

type AlpacaAccount = {
  id: string
  currency: string
  cash: string
  equity: string
  buying_power: string
  trading_blocked: boolean
  account_blocked: boolean
  last_equity: string
}

type AlpacaPosition = {
  symbol: string
  qty: string
  side: 'long' | 'short'
  avg_entry_price: string
  current_price: string | null
  unrealized_pl: string | null
  unrealized_plpc: string | null
  created_at?: string
}

type AlpacaOrder = {
  id: string
  client_order_id: string | null
  symbol: string
  side: 'buy' | 'sell'
  type: string
  qty: string | null
  notional: string | null
  filled_qty: string
  limit_price: string | null
  stop_price: string | null
  status: string
  submitted_at: string
  filled_at: string | null
  legs?: Array<{ side: string; type: string; stop_price: string | null; limit_price: string | null }>
}

export class AlpacaBroker implements BrokerClient {
  readonly brokerId = 'alpaca' as const
  readonly env: BrokerEnv
  readonly capabilities: BrokerCapabilities = {
    brokerId: 'alpaca',
    assets: ['stock', 'crypto'],
    brackets: true,
    fractional: true,
    minOrderUsd: 1,
  }

  private readonly keyId: string
  private readonly secret: string

  constructor(opts: { keyId: string; secret: string; env: BrokerEnv }) {
    this.keyId = opts.keyId
    this.secret = opts.secret
    this.env = opts.env
  }

  private get base(): string {
    return ALPACA_BASE[this.env]
  }

  private async req<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        'APCA-API-KEY-ID': this.keyId,
        'APCA-API-SECRET-KEY': this.secret,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const msg = body.slice(0, 300) || `HTTP ${res.status}`
      const status =
        res.status === 401 || res.status === 403 ? 401 : res.status >= 500 ? 502 : 400
      throw new BrokerError(`Alpaca ${path}: ${msg}`, status, `ALPACA_${res.status}`)
    }
    if (res.status === 204) return undefined as unknown as T
    return (await res.json()) as T
  }

  async getAccount(): Promise<BrokerAccount> {
    const a = await this.req<AlpacaAccount>('/v2/account')
    const equity = Number(a.equity)
    const lastEquity = Number(a.last_equity)
    const dailyPnl = Number.isFinite(equity) && Number.isFinite(lastEquity)
      ? equity - lastEquity
      : null
    return {
      brokerId: 'alpaca',
      env: this.env,
      accountId: a.id,
      currency: a.currency,
      equity,
      cash: Number(a.cash),
      buyingPower: Number(a.buying_power),
      dailyPnl,
      tradingEnabled: !a.trading_blocked && !a.account_blocked,
    }
  }

  async getPositions(): Promise<Position[]> {
    const list = await this.req<AlpacaPosition[]>('/v2/positions')
    return list.map((p) => ({
      brokerId: 'alpaca',
      symbol: p.symbol,
      label: displaySymbolLabel(p.symbol),
      side: p.side === 'long' ? 'buy' : 'sell',
      quantity: Math.abs(Number(p.qty)),
      avgEntryPrice: Number(p.avg_entry_price),
      marketPrice: p.current_price != null ? Number(p.current_price) : null,
      unrealizedPnl: p.unrealized_pl != null ? Number(p.unrealized_pl) : null,
      unrealizedPnlPct:
        p.unrealized_plpc != null ? Number(p.unrealized_plpc) * 100 : null,
      openedAt: p.created_at ?? null,
    }))
  }

  async getOpenOrders(): Promise<Order[]> {
    const list = await this.req<AlpacaOrder[]>('/v2/orders?status=open&nested=true&limit=50')
    return list.map((o) => this.toOrder(o))
  }

  async placeOrder(req: OrderRequest): Promise<Order> {
    if (req.quantity == null && req.notional == null) {
      throw new BrokerError('Order must specify quantity or notional', 400, 'INVALID_ORDER')
    }
    const symbol = toAlpacaSymbol(req.symbol)
    const body: Record<string, unknown> = {
      symbol,
      side: req.side,
      type: req.type,
      time_in_force: req.timeInForce ?? (req.type === 'market' ? 'day' : 'gtc'),
    }
    if (req.quantity != null) body.qty = String(req.quantity)
    if (req.notional != null) body.notional = String(req.notional)
    if (req.limitPrice != null) body.limit_price = String(req.limitPrice)
    if (req.stopPrice != null) body.stop_price = String(req.stopPrice)
    if (req.clientOrderId) body.client_order_id = req.clientOrderId

    if (req.stopLoss != null || req.takeProfit != null) {
      body.order_class = 'bracket'
      if (req.stopLoss != null) {
        body.stop_loss = { stop_price: String(req.stopLoss) }
      }
      if (req.takeProfit != null) {
        body.take_profit = { limit_price: String(req.takeProfit) }
      }
    }

    const o = await this.req<AlpacaOrder>('/v2/orders', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return this.toOrder(o)
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.req<void>(`/v2/orders/${orderId}`, { method: 'DELETE' })
  }

  async closePosition(symbol: string): Promise<void> {
    await this.req<void>(`/v2/positions/${encodeURIComponent(toAlpacaSymbol(symbol))}`, {
      method: 'DELETE',
    })
  }

  async ping(): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
    const start = Date.now()
    try {
      await this.getAccount()
      return { ok: true, latencyMs: Date.now() - start }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private toOrder(o: AlpacaOrder): Order {
    const stopLoss = o.legs?.find((l) => l.type === 'stop')?.stop_price ?? null
    const takeProfit = o.legs?.find((l) => l.type === 'limit')?.limit_price ?? null
    return {
      brokerId: 'alpaca',
      id: o.id,
      clientOrderId: o.client_order_id,
      symbol: o.symbol,
      label: displaySymbolLabel(o.symbol),
      side: o.side,
      type: (o.type as Order['type']) ?? 'market',
      quantity: Number(o.qty ?? o.filled_qty ?? 0),
      filledQuantity: Number(o.filled_qty),
      limitPrice: o.limit_price != null ? Number(o.limit_price) : null,
      stopPrice: o.stop_price != null ? Number(o.stop_price) : null,
      status: fromAlpacaStatus(o.status),
      submittedAt: o.submitted_at,
      filledAt: o.filled_at,
      stopLoss: stopLoss != null ? Number(stopLoss) : null,
      takeProfit: takeProfit != null ? Number(takeProfit) : null,
    }
  }
}
