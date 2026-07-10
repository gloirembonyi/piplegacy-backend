import type { Time } from 'lightweight-charts'
import { roundMarketPrice } from '@/lib/format-market-price'
import { normalizeAndValidateSetup, inferTradeSide } from '@/lib/setup-risk-reward'
import type {
  MarketChatLevel,
  MarketChatSetup,
  MarketChatZone,
} from '@/lib/parse-market-chat-json'

export type ChartCandle = {
  t: number
  o: number
  h: number
  l: number
  c: number
  /** Volume when the upstream provider supplies it (Yahoo, stocks). */
  v?: number
}

/**
 * Shared fields on every drawing.
 * - `id`     stable identity used for selection / move / resize / delete.
 * - `source` distinguishes AI-generated drawings from hand-drawn ones.
 * - `locked` skips hit-testing so a drawing can't be moved by accident.
 *
 * X anchors are stored as Lightweight-Charts **logical indices** (float bar
 * positions) so drawings stay glued to price action through pan/zoom and can
 * extend into the future whitespace - exactly like TradingView. When a logical
 * anchor is absent (e.g. a freshly applied AI setup) the drawing layer
 * materializes it once from the current visible range.
 */
export type DrawingTime = Time

export type ChartDrawingBase = {
  id?: string
  source?: 'ai' | 'user'
  locked?: boolean
}

export type ChartPositionDrawing = ChartDrawingBase & {
  type: 'position'
  side: 'long' | 'short'
  entry: number
  stopLoss: number
  takeProfit: number
  /**
   * When true, the position is PENDING - entry/stop/target are projected but
   * the trade is not active yet. Rendered with a dashed border to distinguish
   * it from a live setup.
   */
  pending?: boolean
  /** Set once the trader drags/resizes - skips AI re-anchor. */
  userPlaced?: boolean
  /** Logical-index bounds of the position box (X extent). */
  boxFromLogical?: number
  boxToLogical?: number
  boxFromTime?: DrawingTime
  boxToTime?: DrawingTime
}

export type ChartHLineRole =
  | 'support'
  | 'resistance'
  | 'entry'
  | 'target'
  | 'pivot'
  | 'liquidity'
  /** Hard thesis-invalidation level - distinct from the stop. */
  | 'invalidation'
  | 'neutral'

export type ChartHLineDrawing = ChartDrawingBase & {
  type: 'hline'
  price: number
  label?: string
  role?: ChartHLineRole
}

export type ChartZoneKind =
  | 'fvg'
  | 'orderBlock'
  | 'supply'
  | 'demand'
  | 'range'
  | 'liquidity'
  /** Pending-entry trigger band - "wait here, activate when price enters". */
  | 'trigger'

export type ChartZoneDrawing = ChartDrawingBase & {
  type: 'zone'
  top: number
  bottom: number
  kind: ChartZoneKind
  label?: string
  /** Optional logical-index bounds. When absent the band spans full width. */
  fromLogical?: number
  toLogical?: number
  fromTime?: DrawingTime
  toTime?: DrawingTime
}

export type ChartTrendRole = 'trend' | 'support' | 'resistance'

/**
 * Diagonal trend line in normalized chart-space (x in 0..1).
 * y-values are still price values and are mapped to chart coordinates.
 */
export type ChartTrendlineDrawing = ChartDrawingBase & {
  type: 'trendline'
  fromX: number
  toX: number
  fromPrice: number
  toPrice: number
  role?: ChartTrendRole
  label?: string
  /** When true the segment is extended to the right edge (ray). */
  ray?: boolean
  /** Logical-index anchors (preferred over fromX/toX once materialized). */
  fromLogical?: number
  toLogical?: number
  fromTime?: DrawingTime
  toTime?: DrawingTime
}

export type ChartLabelDrawing = ChartDrawingBase & {
  type: 'label'
  price: number
  text: string
  atX?: number
  atLogical?: number
  atTime?: DrawingTime
}

export type ChartVLineDrawing = ChartDrawingBase & {
  type: 'vline'
  logical: number
  label?: string
  color?: string
  time?: DrawingTime
}

export type ChartFibDrawing = ChartDrawingBase & {
  type: 'fib'
  fromLogical: number
  toLogical: number
  fromPrice: number
  toPrice: number
  label?: string
  fromTime?: DrawingTime
  toTime?: DrawingTime
}

export type ChartArrowDrawing = ChartDrawingBase & {
  type: 'arrow'
  fromLogical: number
  toLogical: number
  fromPrice: number
  toPrice: number
  color?: string
  label?: string
  fromTime?: DrawingTime
  toTime?: DrawingTime
}

export type ChartDrawing =
  | ChartPositionDrawing
  | ChartHLineDrawing
  | ChartZoneDrawing
  | ChartTrendlineDrawing
  | ChartLabelDrawing
  | ChartVLineDrawing
  | ChartFibDrawing
  | ChartArrowDrawing


export type ChartPriceRange = {
  min: number
  max: number
}

const CHART_INSETS = {
  left: 0.11,
  right: 0.13,
  top: 0.07,
  bottom: 0.17,
} as const

export function chartPlotRect(width: number, height: number) {
  const left = width * CHART_INSETS.left
  const top = height * CHART_INSETS.top
  const plotW = width * (1 - CHART_INSETS.left - CHART_INSETS.right)
  const plotH = height * (1 - CHART_INSETS.top - CHART_INSETS.bottom)
  return { left, top, width: plotW, height: plotH }
}

export function computeChartPriceRange(
  candles: ChartCandle[],
  prices: number[],
  paddingRatio = 0.06
): ChartPriceRange {
  // Focus on RECENT candles so the range moves with the chart instead of being
  // diluted by a multi-month low/high. TradingView's default view shows roughly
  // the last 40–80 bars; we mirror that so our line positions match what the
  // user sees on screen most of the time.
  const recent = candles.slice(-60)
  const fromCandles = recent.flatMap((c) => [c.h, c.l, c.c])
  const all = [...fromCandles, ...prices].filter(
    (p) => Number.isFinite(p) && p > 0
  )
  if (!all.length) {
    const fallback = prices.filter((p) => p > 0)
    const mid = fallback[0] ?? 100
    return { min: mid * 0.98, max: mid * 1.02 }
  }
  let min = Math.min(...all)
  let max = Math.max(...all)
  const span = max - min || max * 0.01
  // Guarantee a minimum visual span (≥1% of mid price) so a single tightly
  // clustered set of levels doesn't render as a 1-pixel band.
  const mid = (max + min) / 2
  const minSpan = mid * 0.012
  if (span < minSpan) {
    const grow = (minSpan - span) / 2
    min -= grow
    max += grow
  }
  min -= span * paddingRatio
  max += span * paddingRatio
  return { min, max }
}

export function priceToPlotY(
  price: number,
  range: ChartPriceRange,
  plotTop: number,
  plotHeight: number
): number {
  const span = range.max - range.min || 1
  const ratio = (range.max - price) / span
  return plotTop + Math.min(1, Math.max(0, ratio)) * plotHeight
}

/** Normalize the legacy `number[]` form into `MarketChatLevel[]`. */
function normalizeLevelsInput(
  input: number[] | MarketChatLevel[]
): MarketChatLevel[] {
  if (!Array.isArray(input)) return []
  return input
    .map<MarketChatLevel | null>((item) => {
      if (typeof item === 'number') {
        return item > 0 ? { price: item } : null
      }
      if (item && typeof item === 'object' && typeof item.price === 'number') {
        return item.price > 0 ? item : null
      }
      return null
    })
    .filter((l): l is MarketChatLevel => l != null)
}

/** Infer long/short from price geometry when bias is WAIT/HOLD. */
function inferSideFromSetup(setup: MarketChatSetup): 'long' | 'short' | null {
  const { entry, stopLoss, takeProfit } = setup
  if (entry == null || stopLoss == null || takeProfit == null) return null
  if (takeProfit > entry && stopLoss < entry) return 'long'
  if (takeProfit < entry && stopLoss > entry) return 'short'
  return 'long'
}

/** Snap setup prices to symbol-appropriate decimals so chart lines match the setup card. */
export function normalizeSetupPrices(
  setup: MarketChatSetup | null,
  symbol?: string
): MarketChatSetup | null {
  return normalizeAndValidateSetup(setup, symbol)
}

/** Round every price-bearing field on a drawing (AI + user). */
export function normalizeDrawingPrices(
  drawings: ChartDrawing[],
  symbol?: string
): ChartDrawing[] {
  return drawings.map((d) => {
    if (d.type === 'position') {
      return {
        ...d,
        entry: roundMarketPrice(d.entry, symbol),
        stopLoss: roundMarketPrice(d.stopLoss, symbol),
        takeProfit: roundMarketPrice(d.takeProfit, symbol),
      }
    }
    if (d.type === 'hline') {
      return { ...d, price: roundMarketPrice(d.price, symbol) }
    }
    if (d.type === 'zone') {
      return {
        ...d,
        top: roundMarketPrice(d.top, symbol),
        bottom: roundMarketPrice(d.bottom, symbol),
      }
    }
    if (d.type === 'trendline') {
      return {
        ...d,
        fromPrice: roundMarketPrice(d.fromPrice, symbol),
        toPrice: roundMarketPrice(d.toPrice, symbol),
      }
    }
    if (d.type === 'label') {
      return { ...d, price: roundMarketPrice(d.price, symbol) }
    }
    if (d.type === 'fib') {
      return {
        ...d,
        fromPrice: roundMarketPrice(d.fromPrice, symbol),
        toPrice: roundMarketPrice(d.toPrice, symbol),
      }
    }
    if (d.type === 'arrow') {
      return {
        ...d,
        fromPrice: roundMarketPrice(d.fromPrice, symbol),
        toPrice: roundMarketPrice(d.toPrice, symbol),
      }
    }
    return d
  })
}

function pushSetupDrawings(
  setup: MarketChatSetup,
  drawings: ChartDrawing[],
  seenZones: Set<string>,
  side: 'long' | 'short'
) {
  const { entry, stopLoss, takeProfit } = setup
  const entryType = setup.entryType ?? 'market'
  const isPending =
    entryType === 'limit' || entryType === 'stop' || setup.bias === 'WAIT'

  if (isPending && setup.triggerZone) {
    const zKey = `trigger:${setup.triggerZone.top.toFixed(5)}:${setup.triggerZone.bottom.toFixed(5)}`
    if (!seenZones.has(zKey)) {
      seenZones.add(zKey)
      drawings.push({
        type: 'zone',
        kind: 'trigger',
        top: setup.triggerZone.top,
        bottom: setup.triggerZone.bottom,
        label:
          entryType === 'limit'
            ? 'Limit zone'
            : 'Stop zone',
      })
    }
  }

  if (
    entry != null &&
    stopLoss != null &&
    takeProfit != null &&
    entry > 0 &&
    stopLoss > 0 &&
    takeProfit > 0
  ) {
    drawings.push({
      type: 'position',
      side,
      entry,
      stopLoss,
      takeProfit,
      pending: isPending,
    })
  }

  if (
    setup.invalidation != null &&
    setup.invalidation > 0 &&
    setup.invalidation !== stopLoss
  ) {
    drawings.push({
      type: 'hline',
      price: setup.invalidation,
      label: 'Invalidation',
      role: 'invalidation',
    })
  }
}

function levelNearSetupPrices(
  price: number,
  setup: MarketChatSetup,
  padRatio = 0.08
): boolean {
  const prices = [setup.entry, setup.stopLoss, setup.takeProfit].filter(
    (p): p is number => p != null && p > 0
  )
  if (prices.length === 0) return false
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const pad = Math.max(Math.abs(max - min) * padRatio, max * 0.002)
  return price >= min - pad && price <= max + pad
}

function shouldSkipAncillaryLevel(
  level: MarketChatLevel,
  setup: MarketChatSetup
): boolean {
  if (levelNearSetupPrices(level.price, setup)) return true

  const side = inferTradeSide(setup)
  const entry = setup.entry
  const stop = setup.stopLoss
  if (!side || entry == null || stop == null) return false

  const risk = Math.abs(entry - stop)
  const prices = [setup.entry, setup.stopLoss, setup.takeProfit].filter(
    (p): p is number => p != null
  )
  const tradeMin = Math.min(...prices)
  const tradeMax = Math.max(...prices)
  const band = Math.max(risk * 2, entry * 0.015)

  const label = level.label ?? ''
  const kind = level.kind ?? 'level'
  const isSwing =
    kind === 'resistance' ||
    kind === 'support' ||
    /\bswing\b/i.test(label)

  if (!isSwing) return false

  if (side === 'short' && level.price > tradeMax + band * 0.35) return true
  if (side === 'long' && level.price < tradeMin - band * 0.35) return true
  return false
}

function roleForLevel(
  level: MarketChatLevel,
  ref: number | null
): ChartHLineRole {
  if (level.kind === 'support') return 'support'
  if (level.kind === 'resistance') return 'resistance'
  if (level.kind === 'entry') return 'entry'
  if (level.kind === 'target') return 'target'
  if (level.kind === 'pivot') return 'pivot'
  if (level.kind === 'liquidity') return 'liquidity'
  if (ref != null) return level.price >= ref ? 'resistance' : 'support'
  return 'neutral'
}

export function buildDrawingsFromChat(
  setup: MarketChatSetup | null,
  levelsInput: number[] | MarketChatLevel[] = [],
  referencePrice?: number | null,
  zones: MarketChatZone[] = [],
  symbol?: string
): ChartDrawing[] {
  const drawings: ChartDrawing[] = []
  const normalizedSetup = normalizeSetupPrices(setup, symbol)
  const normalizedZones = zones.map((z) => ({
    ...z,
    top: roundMarketPrice(Math.max(z.top, z.bottom), symbol),
    bottom: roundMarketPrice(Math.min(z.top, z.bottom), symbol),
  }))

  // ── 1) Zones (FVG / OB / supply / demand) - rendered first so lines stack on top.
  const seenZones = new Set<string>()
  for (const z of normalizedZones.slice(0, 4)) {
    const top = Math.max(z.top, z.bottom)
    const bottom = Math.min(z.top, z.bottom)
    if (!(top > 0) || !(bottom > 0) || top === bottom) continue
    const key = `${z.kind}:${top.toFixed(5)}:${bottom.toFixed(5)}`
    if (seenZones.has(key)) continue
    seenZones.add(key)
    drawings.push({
      type: 'zone',
      kind: z.kind,
      top,
      bottom,
      label: z.label,
    })
  }

  // ── 2) Position box + entry/SL/TP lines + (pending) trigger zone & invalidation.
  if (normalizedSetup && (normalizedSetup.bias === 'BUY' || normalizedSetup.bias === 'SELL')) {
    pushSetupDrawings(
      normalizedSetup,
      drawings,
      seenZones,
      normalizedSetup.bias === 'SELL' ? 'short' : 'long'
    )
  } else if (normalizedSetup && (normalizedSetup.bias === 'WAIT' || normalizedSetup.bias === 'HOLD')) {
    const side = inferSideFromSetup(normalizedSetup)
    if (side) {
      pushSetupDrawings(normalizedSetup, drawings, seenZones, side)
    }
  }

  // ── 3) S/R + custom labeled levels.
  const ref =
    referencePrice && referencePrice > 0
      ? roundMarketPrice(referencePrice, symbol)
      : normalizedSetup?.entry ?? null
  const levels = normalizeLevelsInput(levelsInput).map((l) => ({
    ...l,
    price: roundMarketPrice(l.price, symbol),
  }))
  const seenPrices = new Set<number>()
  for (const d of drawings) {
    if (d.type === 'position') {
      for (const p of [d.entry, d.stopLoss, d.takeProfit]) {
        seenPrices.add(Math.round(p * 100000) / 100000)
      }
    } else if (d.type === 'hline') {
      seenPrices.add(Math.round(d.price * 100000) / 100000)
    }
  }
  for (const level of levels.slice(0, 10)) {
    const key = Math.round(level.price * 100000) / 100000
    if (seenPrices.has(key)) continue
    if (normalizedSetup && shouldSkipAncillaryLevel(level, normalizedSetup)) continue
    seenPrices.add(key)
    drawings.push({
      type: 'hline',
      price: level.price,
      label: level.label,
      role: roleForLevel(level, ref),
    })
  }

  // ── 4) Trendlines from repeated support/resistance pivots (clean visual guide).
  const resistance = levels.filter((l) => l.kind === 'resistance').slice(0, 2)
  if (resistance.length === 2) {
    drawings.push({
      type: 'trendline',
      fromX: 0.12,
      toX: 0.9,
      fromPrice: resistance[0].price,
      toPrice: resistance[1].price,
      role: 'resistance',
      label: 'Resistance trend',
    })
  }
  const support = levels.filter((l) => l.kind === 'support').slice(0, 2)
  if (support.length === 2) {
    drawings.push({
      type: 'trendline',
      fromX: 0.12,
      toX: 0.9,
      fromPrice: support[0].price,
      toPrice: support[1].price,
      role: 'support',
      label: 'Support trend',
    })
  }

  return drawings
}

/** Immediate Y-scale from drawing prices when candles are still loading. */
export function fallbackPriceRangeFromDrawings(
  drawings: ChartDrawing[]
): ChartPriceRange | null {
  const prices = drawingPriceLevels(drawings)
  if (!prices.length) return null
  return computeChartPriceRange([], prices, 0.1)
}

let drawingIdCounter = 0

/** Stable-ish unique id for a drawing (selection / edit / delete). */
export function newDrawingId(prefix = 'dw'): string {
  drawingIdCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${drawingIdCounter.toString(36)}`
}

/** Ensure every drawing has an id (assigns one when missing, in place-safe copy). */
export function withDrawingIds(
  drawings: ChartDrawing[],
  source?: 'ai' | 'user'
): ChartDrawing[] {
  return drawings.map((d) =>
    d.id
      ? d
      : {
          ...d,
          id: newDrawingId(),
          source: d.source ?? source,
          // AI position boxes must stay draggable (TradingView-style move/resize).
          locked:
            d.locked ??
            (source === 'ai' && d.type !== 'position' && d.type !== 'zone'),
        }
  )
}

/** Reset X anchors so the chart layer re-places the box on the live-price zone. */
export function resetPositionBoxAnchors(d: ChartDrawing): ChartDrawing {
  if (d.type !== 'position') return d
  return {
    ...d,
    boxFromLogical: undefined,
    boxToLogical: undefined,
    boxFromTime: undefined,
    boxToTime: undefined,
    userPlaced: false,
    locked: false,
  }
}

export function drawingPriceLevels(drawings: ChartDrawing[]): number[] {
  const prices: number[] = []
  for (const d of drawings) {
    if (d.type === 'position') {
      prices.push(d.entry, d.stopLoss, d.takeProfit)
    } else if (d.type === 'zone') {
      prices.push(d.top, d.bottom)
    } else if (d.type === 'trendline') {
      prices.push(d.fromPrice, d.toPrice)
    } else if (d.type === 'label') {
      prices.push(d.price)
    } else if (d.type === 'fib') {
      prices.push(d.fromPrice, d.toPrice)
    } else if (d.type === 'arrow') {
      prices.push(d.fromPrice, d.toPrice)
    } else if (d.type === 'vline') {
      // no price - skip
    } else {
      prices.push((d as { price: number }).price)
    }
  }
  return prices
}

function pricesNear(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1)
  return Math.abs(a - b) <= scale * 0.0005
}

/** Trade-critical prices always participate in Y autoscale (entry / SL / TP / zones). */
export function criticalAutoscalePrices(drawings: ChartDrawing[]): number[] {
  const critical: number[] = []
  for (const d of drawings) {
    if (d.type === 'position') {
      critical.push(d.entry, d.stopLoss, d.takeProfit)
    } else if (d.type === 'zone') {
      critical.push(d.top, d.bottom)
    } else if (d.type === 'hline') {
      const role = d.role ?? 'neutral'
      if (
        role === 'entry' ||
        role === 'target' ||
        role === 'invalidation' ||
        role === 'liquidity' ||
        role === 'pivot'
      ) {
        critical.push(d.price)
      }
    }
  }
  return critical.filter((p) => Number.isFinite(p) && p > 0)
}

/**
 * Prices that should expand the visible Y range.
 * Setup levels are always included; distant S/R lines are clipped to the candle window.
 */
export function autoscalePricesFromDrawings(
  drawings: ChartDrawing[],
  candleRange: { min: number; max: number } | null,
  filterAncillary: (
    prices: number[],
    range: { min: number; max: number } | null
  ) => number[]
): number[] {
  const critical = criticalAutoscalePrices(drawings)
  const all = drawingPriceLevels(drawings)
  const ancillary = all.filter((p) => !critical.some((c) => pricesNear(c, p)))
  const filtered = filterAncillary(ancillary, candleRange)
  const merged = [...critical, ...filtered]
  return merged.filter((p, i) => merged.findIndex((x) => pricesNear(x, p)) === i)
}
