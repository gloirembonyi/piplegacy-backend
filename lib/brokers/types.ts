/**
 * Pluggable broker interface shared by Alpaca, OANDA, and any future broker.
 *
 * Every broker client is constructed for a single user + single account context
 * via `lib/brokers/registry.ts`. The interface intentionally exposes only the
 * minimum surface the auto-trader needs: account snapshot, positions, orders,
 * place / cancel / close. Streaming and websocket feeds are out of scope for v1.
 */

export type BrokerId = 'alpaca' | 'oanda'

export type BrokerEnv = 'paper' | 'live'

export type AssetClass = 'stock' | 'crypto' | 'forex' | 'metal' | 'other'

export type OrderSide = 'buy' | 'sell'

export type OrderType = 'market' | 'limit' | 'stop'

export type TimeInForce = 'gtc' | 'day' | 'ioc' | 'fok'

export type OrderStatus =
  | 'pending'
  | 'open'
  | 'filled'
  | 'partially_filled'
  | 'cancelled'
  | 'rejected'
  | 'expired'

export type BrokerAccount = {
  brokerId: BrokerId
  env: BrokerEnv
  accountId: string
  /** Account currency (USD / EUR / etc.). */
  currency: string
  equity: number
  cash: number
  buyingPower: number
  /** Realised + unrealised PnL for the trading day (broker-reported). */
  dailyPnl: number | null
  /** Broker says you can place orders right now. */
  tradingEnabled: boolean
}

export type Position = {
  brokerId: BrokerId
  symbol: string
  /** Canonical display label, e.g. EUR/USD or AAPL. */
  label: string
  side: OrderSide
  /** Absolute quantity (units / shares / contracts). */
  quantity: number
  avgEntryPrice: number
  marketPrice: number | null
  unrealizedPnl: number | null
  unrealizedPnlPct: number | null
  openedAt: string | null
}

export type Order = {
  brokerId: BrokerId
  id: string
  clientOrderId?: string | null
  symbol: string
  label: string
  side: OrderSide
  type: OrderType
  quantity: number
  filledQuantity: number
  limitPrice: number | null
  stopPrice: number | null
  status: OrderStatus
  submittedAt: string
  filledAt: string | null
  /** Optional bracket children (Alpaca only - OANDA models these inline). */
  stopLoss: number | null
  takeProfit: number | null
}

export type OrderRequest = {
  /** Canonical symbol - the broker client maps it to its own form. */
  symbol: string
  side: OrderSide
  /** Either quantity OR notional, exactly one. */
  quantity?: number
  notional?: number
  type: OrderType
  limitPrice?: number
  stopPrice?: number
  timeInForce?: TimeInForce
  /** Attach a protective stop-loss as a bracket child where the broker supports it. */
  stopLoss?: number
  /** Attach a take-profit as a bracket child where the broker supports it. */
  takeProfit?: number
  /** Idempotency token - broker rejects duplicates with the same client order id. */
  clientOrderId?: string
}

export type BrokerCapabilities = {
  brokerId: BrokerId
  /** Asset classes the broker can route orders for. */
  assets: AssetClass[]
  /** Broker-native bracket order support (stop + tp attached in one call). */
  brackets: boolean
  /** Fractional quantities supported (Alpaca yes, OANDA forex units no but cash settled). */
  fractional: boolean
  /** Minimum order notional/quantity hint (display only). */
  minOrderUsd: number | null
}

export interface BrokerClient {
  readonly brokerId: BrokerId
  readonly env: BrokerEnv
  readonly capabilities: BrokerCapabilities

  getAccount(): Promise<BrokerAccount>
  getPositions(): Promise<Position[]>
  getOpenOrders(): Promise<Order[]>
  placeOrder(order: OrderRequest): Promise<Order>
  cancelOrder(orderId: string): Promise<void>
  closePosition(symbol: string): Promise<void>
  /** Cheap health check - returns ok+latency or a typed error. */
  ping(): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }>
}

export class BrokerError extends Error {
  status: number
  code: string
  constructor(message: string, status = 502, code = 'BROKER_ERROR') {
    super(message)
    this.name = 'BrokerError'
    this.status = status
    this.code = code
  }
}
