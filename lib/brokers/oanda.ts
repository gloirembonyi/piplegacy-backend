/**
 * OANDA v20 REST client.
 *
 * Docs:    https://developer.oanda.com/rest-live-v20/introduction/
 * Practice: https://api-fxpractice.oanda.com
 * Live:     https://api-fxtrade.oanda.com
 *
 * OANDA instruments are underscored (EUR_USD, XAU_USD). The auto-trader passes
 * canonical symbols (EURUSD, XAUUSD or OANDA:EUR_USD) and we normalize here.
 * Bracket orders are modelled inline on the parent order (stopLossOnFill /
 * takeProfitOnFill), which is what the OANDA wire format expects.
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

const OANDA_BASE = {
  paper: 'https://api-fxpractice.oanda.com',
  live: 'https://api-fxtrade.oanda.com',
} as const

/** EURUSD / OANDA:EUR_USD / XAU/USD → EUR_USD. */
export function toOandaInstrument(symbol: string): string {
  const upper = normalizeSymbol(symbol)
  if (upper.startsWith('OANDA:')) return upper.slice(6)
  if (upper.includes('_')) return upper
  if (upper.includes('/')) return upper.replace('/', '_')
  if (/^[A-Z]{6}$/.test(upper)) return `${upper.slice(0, 3)}_${upper.slice(3)}`
  return upper
}

function fromOandaInstrument(instrument: string): string {
  return `OANDA:${instrument}`
}

function fromOandaStatus(state: string): OrderStatus {
  const s = state.toUpperCase()
  if (s === 'FILLED') return 'filled'
  if (s === 'PENDING') return 'open'
  if (s === 'CANCELLED') return 'cancelled'
  if (s === 'TRIGGERED') return 'partially_filled'
  return 'pending'
}

type OandaAccountSummary = {
  account: {
    id: string
    currency: string
    balance: string
    NAV: string
    marginAvailable: string
    pl: string
    unrealizedPL: string
    openTradeCount: number
  }
}

type OandaPosition = {
  instrument: string
  long: {
    units: string
    averagePrice: string
    unrealizedPL: string
    pl: string
  }
  short: {
    units: string
    averagePrice: string
    unrealizedPL: string
    pl: string
  }
}

type OandaPositionsResponse = {
  positions: OandaPosition[]
}

type OandaOrder = {
  id: string
  clientExtensions?: { id?: string }
  state: string
  createTime: string
  instrument?: string
  units?: string
  type: string
  price?: string
  stopLossOnFill?: { price: string }
  takeProfitOnFill?: { price: string }
}

type OandaOrdersResponse = {
  orders: OandaOrder[]
}

type OandaPricingResponse = {
  prices: Array<{ instrument: string; closeoutBid: string; closeoutAsk: string }>
}

export class OandaBroker implements BrokerClient {
  readonly brokerId = 'oanda' as const
  readonly env: BrokerEnv
  readonly capabilities: BrokerCapabilities = {
    brokerId: 'oanda',
    assets: ['forex', 'metal'],
    brackets: true,
    fractional: false,
    minOrderUsd: null,
  }

  private readonly token: string
  private readonly accountId: string

  constructor(opts: { token: string; accountId: string; env: BrokerEnv }) {
    this.token = opts.token
    this.accountId = opts.accountId
    this.env = opts.env
  }

  private get base(): string {
    return OANDA_BASE[this.env]
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const msg = body.slice(0, 300) || `HTTP ${res.status}`
      const status =
        res.status === 401 || res.status === 403 ? 401 : res.status >= 500 ? 502 : 400
      throw new BrokerError(`OANDA ${path}: ${msg}`, status, `OANDA_${res.status}`)
    }
    if (res.status === 204) return undefined as unknown as T
    return (await res.json()) as T
  }

  async getAccount(): Promise<BrokerAccount> {
    const r = await this.req<OandaAccountSummary>(
      `/v3/accounts/${this.accountId}/summary`
    )
    const a = r.account
    return {
      brokerId: 'oanda',
      env: this.env,
      accountId: a.id,
      currency: a.currency,
      equity: Number(a.NAV),
      cash: Number(a.balance),
      buyingPower: Number(a.marginAvailable),
      dailyPnl: Number(a.unrealizedPL),
      tradingEnabled: true,
    }
  }

  async getPositions(): Promise<Position[]> {
    const r = await this.req<OandaPositionsResponse>(
      `/v3/accounts/${this.accountId}/openPositions`
    )
    const out: Position[] = []
    for (const p of r.positions) {
      const longUnits = Number(p.long.units)
      const shortUnits = Number(p.short.units)
      if (longUnits > 0) {
        out.push({
          brokerId: 'oanda',
          symbol: fromOandaInstrument(p.instrument),
          label: displaySymbolLabel(fromOandaInstrument(p.instrument)),
          side: 'buy',
          quantity: longUnits,
          avgEntryPrice: Number(p.long.averagePrice),
          marketPrice: null,
          unrealizedPnl: Number(p.long.unrealizedPL),
          unrealizedPnlPct: null,
          openedAt: null,
        })
      }
      if (shortUnits < 0) {
        out.push({
          brokerId: 'oanda',
          symbol: fromOandaInstrument(p.instrument),
          label: displaySymbolLabel(fromOandaInstrument(p.instrument)),
          side: 'sell',
          quantity: Math.abs(shortUnits),
          avgEntryPrice: Number(p.short.averagePrice),
          marketPrice: null,
          unrealizedPnl: Number(p.short.unrealizedPL),
          unrealizedPnlPct: null,
          openedAt: null,
        })
      }
    }
    if (out.length > 0) {
      const instruments = [...new Set(out.map((p) => toOandaInstrument(p.symbol)))]
      try {
        const pricing = await this.req<OandaPricingResponse>(
          `/v3/accounts/${this.accountId}/pricing?instruments=${encodeURIComponent(instruments.join(','))}`
        )
        for (const p of out) {
          const inst = toOandaInstrument(p.symbol)
          const px = pricing.prices.find((x) => x.instrument === inst)
          if (px) {
            const mid = (Number(px.closeoutBid) + Number(px.closeoutAsk)) / 2
            p.marketPrice = mid
            if (p.avgEntryPrice) {
              const diff = p.side === 'buy' ? mid - p.avgEntryPrice : p.avgEntryPrice - mid
              p.unrealizedPnlPct = (diff / p.avgEntryPrice) * 100
            }
          }
        }
      } catch {
        /* pricing optional */
      }
    }
    return out
  }

  async getOpenOrders(): Promise<Order[]> {
    const r = await this.req<OandaOrdersResponse>(
      `/v3/accounts/${this.accountId}/pendingOrders`
    )
    return r.orders.map((o) => this.toOrder(o))
  }

  async placeOrder(req: OrderRequest): Promise<Order> {
    const qty = req.quantity ?? 0
    if (!qty || qty <= 0) {
      throw new BrokerError('OANDA requires positive integer quantity (units)', 400, 'INVALID_ORDER')
    }
    const units = req.side === 'buy' ? Math.round(qty) : -Math.round(qty)
    const instrument = toOandaInstrument(req.symbol)

    const order: Record<string, unknown> = {
      instrument,
      units: String(units),
      type: req.type === 'market' ? 'MARKET' : req.type === 'limit' ? 'LIMIT' : 'STOP',
      timeInForce: req.timeInForce
        ? req.timeInForce.toUpperCase() === 'DAY'
          ? 'GTD'
          : 'GTC'
        : req.type === 'market'
          ? 'FOK'
          : 'GTC',
      positionFill: 'DEFAULT',
    }
    if (req.type === 'limit' && req.limitPrice != null) {
      order.price = String(req.limitPrice)
    }
    if (req.type === 'stop' && req.stopPrice != null) {
      order.price = String(req.stopPrice)
    }
    if (req.stopLoss != null) {
      order.stopLossOnFill = { price: String(req.stopLoss), timeInForce: 'GTC' }
    }
    if (req.takeProfit != null) {
      order.takeProfitOnFill = { price: String(req.takeProfit), timeInForce: 'GTC' }
    }
    if (req.clientOrderId) {
      order.clientExtensions = { id: req.clientOrderId.slice(0, 64) }
    }

    type OrderCreateResp = {
      orderCreateTransaction?: { id: string; time: string; instrument: string; units: string }
      orderFillTransaction?: { id: string; time: string }
      lastTransactionID?: string
    }
    const r = await this.req<OrderCreateResp>(
      `/v3/accounts/${this.accountId}/orders`,
      { method: 'POST', body: JSON.stringify({ order }) }
    )
    const created = r.orderCreateTransaction
    const filled = r.orderFillTransaction
    return {
      brokerId: 'oanda',
      id: filled?.id ?? created?.id ?? r.lastTransactionID ?? '',
      clientOrderId: req.clientOrderId ?? null,
      symbol: fromOandaInstrument(instrument),
      label: displaySymbolLabel(fromOandaInstrument(instrument)),
      side: req.side,
      type: req.type,
      quantity: Math.abs(Number(created?.units ?? units)),
      filledQuantity: filled ? Math.abs(Number(created?.units ?? units)) : 0,
      limitPrice: req.limitPrice ?? null,
      stopPrice: req.stopPrice ?? null,
      status: filled ? 'filled' : 'open',
      submittedAt: created?.time ?? new Date().toISOString(),
      filledAt: filled?.time ?? null,
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.req<void>(`/v3/accounts/${this.accountId}/orders/${orderId}/cancel`, {
      method: 'PUT',
    })
  }

  async closePosition(symbol: string): Promise<void> {
    const instrument = toOandaInstrument(symbol)
    await this.req<void>(
      `/v3/accounts/${this.accountId}/positions/${instrument}/close`,
      { method: 'PUT', body: JSON.stringify({ longUnits: 'ALL', shortUnits: 'ALL' }) }
    )
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

  private toOrder(o: OandaOrder): Order {
    const units = o.units != null ? Number(o.units) : 0
    return {
      brokerId: 'oanda',
      id: o.id,
      clientOrderId: o.clientExtensions?.id ?? null,
      symbol: o.instrument ? fromOandaInstrument(o.instrument) : '',
      label: o.instrument ? displaySymbolLabel(fromOandaInstrument(o.instrument)) : '',
      side: units >= 0 ? 'buy' : 'sell',
      type:
        o.type.toLowerCase() === 'market'
          ? 'market'
          : o.type.toLowerCase() === 'limit'
            ? 'limit'
            : 'stop',
      quantity: Math.abs(units),
      filledQuantity: 0,
      limitPrice: o.price != null ? Number(o.price) : null,
      stopPrice: null,
      status: fromOandaStatus(o.state),
      submittedAt: o.createTime,
      filledAt: null,
      stopLoss: o.stopLossOnFill ? Number(o.stopLossOnFill.price) : null,
      takeProfit: o.takeProfitOnFill ? Number(o.takeProfitOnFill.price) : null,
    }
  }
}
