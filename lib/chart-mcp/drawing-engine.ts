/**
 * Drawing engine - pure geometry, hit-testing and canvas rendering for the
 * interactive chart drawing layer. No React here; the layer component owns the
 * canvas + pointer events and calls into these helpers.
 *
 * Coordinate model
 * ────────────────
 * X is a Lightweight-Charts **logical index** (float bar position) so drawings
 * stay anchored to candles through pan/zoom and can extend into future
 * whitespace. Y is a **price**. Everything is converted to/from screen pixels
 * through the live chart scale via the `ChartView` below.
 */

import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type {
  ChartArrowDrawing,
  ChartDrawing,
  ChartFibDrawing,
  ChartHLineDrawing,
  ChartHLineRole,
  ChartLabelDrawing,
  ChartPositionDrawing,
  ChartTrendlineDrawing,
  ChartVLineDrawing,
  ChartZoneDrawing,
  ChartZoneKind,
} from '@/lib/chart-drawings'

export type Pt = { x: number; y: number }

export type Handle = { id: string; x: number; y: number }

/** Live, pixel-accurate view onto the chart scale. */
export type ChartView = {
  /** CSS-pixel plot area (series pane, excludes price scale + time axis). */
  plotRight: number
  plotBottom: number
  width: number
  height: number
  /** Logical index at the right edge of the data (last bar). */
  lastLogical: number
  visibleFrom: number
  visibleTo: number
  priceToY: (price: number) => number | null
  yToPrice: (y: number) => number | null
  logicalToX: (logical: number) => number | null
  xToLogical: (x: number) => number | null
  formatPrice: (price: number) => string
}

export const ROLE_COLOR: Record<ChartHLineRole, string> = {
  support: '#26a69a',
  resistance: '#ef5350',
  entry: '#2962ff',
  target: '#26a69a',
  pivot: '#9c27b0',
  liquidity: '#ff9800',
  invalidation: '#b71c1c',
  neutral: '#787b86',
}

export const ZONE_STYLE: Record<
  ChartZoneKind,
  { fill: string; stroke: string; label: string }
> = {
  fvg:        { fill: 'rgba(41,98,255,0.06)',   stroke: 'rgba(41,98,255,0.55)',   label: 'FVG' },
  orderBlock: { fill: 'rgba(156,39,176,0.07)',  stroke: 'rgba(156,39,176,0.5)',   label: 'OB' },
  supply:     { fill: 'rgba(239,83,80,0.07)',   stroke: 'rgba(239,83,80,0.55)',   label: 'SUPPLY' },
  demand:     { fill: 'rgba(38,166,154,0.08)',  stroke: 'rgba(38,166,154,0.55)', label: 'DEMAND' },
  range:      { fill: 'rgba(120,123,134,0.05)', stroke: 'rgba(120,123,134,0.4)', label: 'RANGE' },
  liquidity:  { fill: 'rgba(255,152,0,0.07)',   stroke: 'rgba(255,152,0,0.55)',   label: 'LIQ' },
  trigger:    { fill: 'rgba(255,235,59,0.06)',  stroke: 'rgba(249,168,37,0.65)', label: 'WAIT' },
}

/** Fibonacci levels (ratio, label, alpha) */
const FIB_LEVELS: Array<{ ratio: number; label: string; color: string }> = [
  { ratio: 0,     label: '0',     color: '#ef5350' },
  { ratio: 0.236, label: '0.236', color: '#ff9800' },
  { ratio: 0.382, label: '0.382', color: '#f9a825' },
  { ratio: 0.5,   label: '0.5',   color: '#787b86' },
  { ratio: 0.618, label: '0.618', color: '#26a69a' },
  { ratio: 0.786, label: '0.786', color: '#2196f3' },
  { ratio: 1,     label: '1',     color: '#9c27b0' },
]

const TREND_COLOR: Record<string, string> = {
  trend:      '#2962ff',
  support:    '#26a69a',
  resistance: '#ef5350',
}

const SELECT_COLOR = '#2962ff'
const HANDLE_R = 6
const HIT_TOL = 12
const FONT =
  '500 9px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif'
const FONT_BOLD =
  '600 9px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif'

// ── Build a ChartView from the live chart + series ────────────────────────────

export function buildChartView(
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  width: number,
  height: number,
  symbolDecimals: (price: number) => string
): ChartView | null {
  try {
    const ts = chart.timeScale()
    let plotRight = width
    let plotBottom = height
    try {
      const psw = chart.priceScale('right').width()
      if (Number.isFinite(psw) && psw > 0) plotRight = Math.max(0, width - psw)
      const tsh = ts.height()
      if (Number.isFinite(tsh) && tsh > 0) plotBottom = Math.max(0, height - tsh)
    } catch {
      /* fall back to full size */
    }

    const range = ts.getVisibleLogicalRange()
    // Chart not laid out yet (first mount / just after a symbol or timeframe
    // switch) - don't fabricate a 0/0 range, callers treat null as "skip
    // this pass" and retry once a real range is available.
    if (range == null) return null
    const visibleFrom = range.from
    const visibleTo = range.to
    const lastLogical = visibleTo > 0 ? visibleTo - 1 : 0

    return {
      plotRight,
      plotBottom,
      width,
      height,
      lastLogical,
      visibleFrom,
      visibleTo,
      priceToY: (price) => {
        const y = series.priceToCoordinate(price)
        return y == null ? null : y
      },
      yToPrice: (y) => {
        const p = series.coordinateToPrice(y)
        return p == null ? null : (p as number)
      },
      logicalToX: (logical) => {
        const x = ts.logicalToCoordinate(logical as never)
        return x == null ? null : (x as number)
      },
      xToLogical: (x) => {
        const l = ts.coordinateToLogical(x)
        return l == null ? null : (l as number)
      },
      formatPrice: symbolDecimals,
    }
  } catch {
    return null
  }
}

// ── Default logical anchors for AI drawings that lack them ───────────────────

/** Minimum horizontal span for setup boxes (bars). */
export const AI_BOX_MIN_LOGICAL_SPAN = 8

/** ~12% of visible range - TradingView-style setup box width. */
export function aiBoxLogicalWidth(view: ChartView): number {
  const span = Math.max(view.visibleTo - view.visibleFrom, 24)
  return Math.max(span * 0.12, AI_BOX_MIN_LOGICAL_SPAN)
}

export function ensureMinLogicalSpan(
  fromL: number,
  toL: number,
  view: ChartView
): { from: number; to: number } {
  const minW = aiBoxLogicalWidth(view)
  let from = Math.min(fromL, toL)
  let to = Math.max(fromL, toL)
  if (to - from < minW) {
    const mid = (from + to) / 2
    from = mid - minW / 2
    to = mid + minW / 2
  }
  return { from, to }
}

/** Right edge: slightly into future whitespace so the box sits ahead of price. */
export function defaultRightLogical(view: ChartView): number {
  return defaultSetupBoxLogicalSpan(view).to
}

export function defaultLeftLogical(view: ChartView): number {
  return defaultSetupBoxLogicalSpan(view).from
}

/** Center the setup box on the live bar (TradingView long/short tool behavior). */
export function defaultSetupBoxLogicalSpan(view: ChartView): { from: number; to: number } {
  const width = aiBoxLogicalWidth(view)
  const visSpan = Math.max(view.visibleTo - view.visibleFrom, 24)
  const liveBar =
    view.lastLogical > view.visibleFrom
      ? view.lastLogical
      : Math.max(view.visibleTo - 1, view.visibleFrom + visSpan * 0.88)
  let to = liveBar + width * 0.22
  let from = to - width
  return ensureMinLogicalSpan(from, to, view)
}

/** Re-anchor only when the box was placed before the chart scale was ready. */
export function setupBoxNeedsReanchor(view: ChartView, d: ChartPositionDrawing): boolean {
  if (d.userPlaced) return false
  if (d.boxFromLogical == null || d.boxToLogical == null) return true
  const visSpan = view.visibleTo - view.visibleFrom
  if (!Number.isFinite(visSpan) || visSpan <= 0) return true
  const width = Math.abs(d.boxToLogical - d.boxFromLogical)
  if (width < AI_BOX_MIN_LOGICAL_SPAN * 0.5) return true
  const center = (d.boxFromLogical + d.boxToLogical) / 2
  if (center < view.visibleFrom + visSpan * 0.04) return true
  if (center < view.visibleFrom - visSpan * 0.1) return true
  return false
}

export function normXToLogical(view: ChartView, nx: number): number {
  const span = view.visibleTo - view.visibleFrom || 40
  return view.visibleFrom + Math.min(1, Math.max(0, nx)) * span
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function nearHandle(p: Pt, handles: Handle[]): string | null {
  for (const h of handles) {
    if (Math.hypot(p.x - h.x, p.y - h.y) <= HANDLE_R + HIT_TOL) return h.id
  }
  return null
}

// ── Per-drawing pixel resolution ─────────────────────────────────────────────

type TrendPx = { a: Pt; b: Pt }

function trendPx(view: ChartView, d: ChartTrendlineDrawing): TrendPx | null {
  const aL = d.fromLogical ?? normXToLogical(view, d.fromX)
  const bL = d.toLogical ?? normXToLogical(view, d.toX)
  const ay = view.priceToY(d.fromPrice)
  const by = view.priceToY(d.toPrice)
  const ax = view.logicalToX(aL)
  let bx = view.logicalToX(bL)
  if (ay == null || by == null || ax == null || bx == null) return null
  if (d.ray) {
    const dx = bx - ax
    const dy = by - ay
    if (dx > 0) {
      const t = (view.plotRight - ax) / dx
      const ry = ay + t * dy
      return { a: { x: ax, y: ay }, b: { x: view.plotRight, y: ry } }
    } else if (dx < 0) {
      const t = (0 - ax) / dx
      const ry = ay + t * dy
      return { a: { x: ax, y: ay }, b: { x: 0, y: ry } }
    } else {
      const ry = dy > 0 ? view.plotBottom : 0
      return { a: { x: ax, y: ay }, b: { x: ax, y: ry } }
    }
  }
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } }
}

function zonePx(
  view: ChartView,
  d: ChartZoneDrawing
): { x0: number; x1: number; yTop: number; yBottom: number } | null {
  const yTop = view.priceToY(Math.max(d.top, d.bottom))
  const yBottom = view.priceToY(Math.min(d.top, d.bottom))
  if (yTop == null || yBottom == null) return null
  let x0 = 0
  let x1 = view.plotRight
  if (d.fromLogical != null && d.toLogical != null) {
    const span = ensureMinLogicalSpan(d.fromLogical, d.toLogical, view)
    const a = view.logicalToX(span.from)
    const b = view.logicalToX(span.to)
    if (a != null && b != null) {
      x0 = Math.min(a, b)
      x1 = Math.max(a, b)
    }
  }
  const minPx = Math.max(56, view.plotRight * 0.14)
  if (x1 - x0 < minPx) {
    x1 = Math.min(view.plotRight, x0 + minPx)
  }
  let yTopPx = yTop
  let yBottomPx = yBottom
  const minBandPx = 12
  if (Math.abs(yBottomPx - yTopPx) < minBandPx) {
    const mid = (yTopPx + yBottomPx) / 2
    yTopPx = mid - minBandPx / 2
    yBottomPx = mid + minBandPx / 2
  }
  return { x0, x1, yTop: yTopPx, yBottom: yBottomPx }
}

function positionPx(
  view: ChartView,
  d: ChartPositionDrawing
): { x0: number; x1: number; yE: number; yS: number; yT: number } | null {
  const yE = view.priceToY(d.entry)
  const yS = view.priceToY(d.stopLoss)
  const yT = view.priceToY(d.takeProfit)
  if (yE == null || yS == null || yT == null) return null
  const span = ensureMinLogicalSpan(
    d.boxFromLogical ?? defaultLeftLogical(view),
    d.boxToLogical ?? defaultRightLogical(view),
    view
  )
  const a = view.logicalToX(span.from)
  const b = view.logicalToX(span.to)
  let x0 = a
  let x1 = b
  if (x0 == null || x1 == null) {
    const def = defaultSetupBoxLogicalSpan(view)
    x0 = view.logicalToX(def.from)
    x1 = view.logicalToX(def.to)
  }
  if (x0 == null || x1 == null) {
    const w = Math.max(view.plotRight * 0.1, 48)
    x1 = Math.max(w, view.plotRight * 0.92)
    x0 = x1 - w
  }
  x0 = Math.min(x0, x1)
  x1 = Math.max(x0, x1)
  const minPx = Math.max(32, view.plotRight * 0.06)
  if (x1 - x0 < minPx) {
    x1 = Math.min(view.plotRight, x0 + minPx)
  }
  return { x0, x1, yE, yS, yT }
}

function labelPx(view: ChartView, d: ChartLabelDrawing): Pt | null {
  const y = view.priceToY(d.price)
  if (y == null) return null
  const lg = d.atLogical ?? normXToLogical(view, d.atX ?? 0.7)
  const x = view.logicalToX(lg) ?? view.plotRight * 0.7
  return { x, y }
}

function vlinePx(view: ChartView, d: ChartVLineDrawing): number | null {
  return view.logicalToX(d.logical)
}

function fibPx(
  view: ChartView,
  d: ChartFibDrawing
): { x0: number; x1: number; fromY: number; toY: number } | null {
  const x0raw = view.logicalToX(d.fromLogical)
  const x1raw = view.logicalToX(d.toLogical)
  const fromY = view.priceToY(d.fromPrice)
  const toY = view.priceToY(d.toPrice)
  if (x0raw == null || x1raw == null || fromY == null || toY == null) return null
  return {
    x0: Math.min(x0raw, x1raw),
    x1: Math.max(x0raw, x1raw),
    fromY,
    toY,
  }
}

function arrowPx(
  view: ChartView,
  d: ChartArrowDrawing
): TrendPx | null {
  const ax = view.logicalToX(d.fromLogical)
  const bx = view.logicalToX(d.toLogical)
  const ay = view.priceToY(d.fromPrice)
  const by = view.priceToY(d.toPrice)
  if (ax == null || bx == null || ay == null || by == null) return null
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } }
}

// ── Public: handles for the selected drawing ─────────────────────────────────

export function getHandles(view: ChartView, d: ChartDrawing): Handle[] {
  if (d.type === 'hline') {
    const y = view.priceToY(d.price)
    if (y == null) return []
    return [{ id: 'price', x: view.plotRight - 14, y }]
  }
  if (d.type === 'trendline') {
    const px = trendPx(view, d)
    if (!px) return []
    return [
      { id: 'a', x: px.a.x, y: px.a.y },
      { id: 'b', x: px.b.x, y: px.b.y },
    ]
  }
  if (d.type === 'zone') {
    const px = zonePx(view, d)
    if (!px) return []
    const midX = (px.x0 + px.x1) / 2
    return [
      { id: 'top', x: midX, y: px.yTop },
      { id: 'bottom', x: midX, y: px.yBottom },
    ]
  }
  if (d.type === 'position') {
    const px = positionPx(view, d)
    if (!px) return []
    const midX = (px.x0 + px.x1) / 2
    const midY = (Math.min(px.yE, px.yS, px.yT) + Math.max(px.yE, px.yS, px.yT)) / 2
    return [
      { id: 'entry', x: midX, y: px.yE },
      { id: 'stop', x: midX, y: px.yS },
      { id: 'target', x: midX, y: px.yT },
      { id: 'left', x: px.x0 + 4, y: midY },
      { id: 'right', x: px.x1 - 4, y: midY },
    ]
  }
  if (d.type === 'label') {
    const px = labelPx(view, d)
    if (!px) return []
    return [{ id: 'pos', x: px.x, y: px.y }]
  }
  if (d.type === 'vline') {
    const x = vlinePx(view, d)
    if (x == null) return []
    return [{ id: 'x', x, y: view.plotBottom / 2 }]
  }
  if (d.type === 'fib') {
    const px = fibPx(view, d)
    if (!px) return []
    return [
      { id: 'a', x: px.x0, y: px.fromY },
      { id: 'b', x: px.x1, y: px.toY },
    ]
  }
  if (d.type === 'arrow') {
    const px = arrowPx(view, d)
    if (!px) return []
    return [
      { id: 'a', x: px.a.x, y: px.a.y },
      { id: 'b', x: px.b.x, y: px.b.y },
    ]
  }
  return []
}

// ── Public: hit testing ──────────────────────────────────────────────────────

export type HitResult = { handle: string | null }

export function hitTest(
  view: ChartView,
  d: ChartDrawing,
  p: Pt
): HitResult | null {
  if (d.locked) return null
  const handles = getHandles(view, d)
  const onHandle = nearHandle(p, handles)
  if (onHandle) return { handle: onHandle }

  if (d.type === 'hline') {
    const y = view.priceToY(d.price)
    if (y != null && Math.abs(p.y - y) <= HIT_TOL && p.x <= view.plotRight)
      return { handle: null }
    return null
  }
  if (d.type === 'trendline') {
    const px = trendPx(view, d)
    if (px && distToSegment(p, px.a, px.b) <= HIT_TOL) return { handle: null }
    return null
  }
  if (d.type === 'zone') {
    const px = zonePx(view, d)
    if (
      px &&
      p.x >= px.x0 &&
      p.x <= px.x1 &&
      p.y >= px.yTop &&
      p.y <= px.yBottom
    )
      return { handle: null }
    return null
  }
  if (d.type === 'position') {
    const px = positionPx(view, d)
    if (
      px &&
      p.x >= px.x0 - 4 &&
      p.x <= px.x1 + 4 &&
      p.y >= Math.min(px.yE, px.yS, px.yT) - 4 &&
      p.y <= Math.max(px.yE, px.yS, px.yT) + 4
    )
      return { handle: null }
    return null
  }
  if (d.type === 'label') {
    const px = labelPx(view, d)
    if (px && Math.hypot(p.x - px.x, p.y - px.y) <= 22) return { handle: null }
    return null
  }
  if (d.type === 'vline') {
    const x = vlinePx(view, d)
    if (x != null && Math.abs(p.x - x) <= HIT_TOL && p.y <= view.plotBottom)
      return { handle: null }
    return null
  }
  if (d.type === 'fib') {
    const px = fibPx(view, d)
    if (!px) return null
    if (p.x >= px.x0 && p.x <= px.x1) {
      const yMin = Math.min(px.fromY, px.toY)
      const yMax = Math.max(px.fromY, px.toY)
      if (p.y >= yMin - HIT_TOL && p.y <= yMax + HIT_TOL) return { handle: null }
    }
    return null
  }
  if (d.type === 'arrow') {
    const px = arrowPx(view, d)
    if (px && distToSegment(p, px.a, px.b) <= HIT_TOL) return { handle: null }
    return null
  }
  return null
}

/** First drawing (top-most) hit at a point. */
export function pickDrawing(
  view: ChartView,
  drawings: ChartDrawing[],
  p: Pt
): { id: string; handle: string | null } | null {
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i]
    if (!d.id) continue
    const hit = hitTest(view, d, p)
    if (hit) return { id: d.id, handle: hit.handle }
  }
  return null
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function dpiLine(
  ctx: CanvasRenderingContext2D,
  a: Pt,
  b: Pt,
  color: string,
  width: number,
  dash: number[] = []
) {
  ctx.save()
  ctx.beginPath()
  ctx.setLineDash(dash)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
  ctx.restore()
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  from: Pt,
  to: Pt,
  color: string,
  size = 9
) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  ctx.save()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(
    to.x - size * Math.cos(angle - Math.PI / 6),
    to.y - size * Math.sin(angle - Math.PI / 6)
  )
  ctx.lineTo(
    to.x - size * Math.cos(angle + Math.PI / 6),
    to.y - size * Math.sin(angle + Math.PI / 6)
  )
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** Offset overlapping right-axis tags so they stay readable. */
function layoutAxisTags(
  items: Array<{ y: number; text: string; color: string }>,
  minGap = 12
): Array<{ y: number; text: string; color: string }> {
  const sorted = [...items].sort((a, b) => a.y - b.y)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y < minGap) {
      sorted[i].y = sorted[i - 1].y + minGap
    }
  }
  return sorted
}

/** Compact right-axis tag (pro analytics - thin, small). */
function compactTag(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  anchor: 'start' | 'end' = 'end'
) {
  ctx.save()
  ctx.font = FONT
  const padX = 3
  const w = ctx.measureText(text).width + padX * 2
  const h = 11
  const bx = anchor === 'end' ? x - w : x
  const by = y - h / 2
  ctx.fillStyle = color
  const r = 2
  ctx.beginPath()
  ctx.moveTo(bx + r, by)
  ctx.arcTo(bx + w, by, bx + w, by + h, r)
  ctx.arcTo(bx + w, by + h, bx, by + h, r)
  ctx.arcTo(bx, by + h, bx, by, r)
  ctx.arcTo(bx, by, bx + w, by, r)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText(text, bx + padX, by + h / 2 + 0.5)
  ctx.restore()
}

function tag(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  align: CanvasTextAlign = 'left'
) {
  ctx.save()
  ctx.font = FONT_BOLD
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, x, y)
  ctx.restore()
}

function handleDot(ctx: CanvasRenderingContext2D, h: Handle) {
  ctx.save()
  ctx.beginPath()
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = SELECT_COLOR
  ctx.lineWidth = 1.5
  ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

export type RenderDrawingOpts = {
  /** Lightweight Charts native price lines render E/SL/TP - canvas skips duplicate lines. */
  nativePriceLines?: boolean
}

export function renderDrawing(
  ctx: CanvasRenderingContext2D,
  view: ChartView,
  d: ChartDrawing,
  selected: boolean,
  opts?: RenderDrawingOpts
) {
  if (d.type === 'hline') {
    if (opts?.nativePriceLines && d.source !== 'user') return
    const y = view.priceToY(d.price)
    if (y == null) return
    const role = (d.role ?? 'neutral') as ChartHLineRole
    const color = ROLE_COLOR[role] ?? ROLE_COLOR.neutral
    const dash =
      role === 'entry' ? [] : role === 'invalidation' ? [3, 3] : [6, 4]
    dpiLine(
      ctx,
      { x: 0, y },
      { x: view.plotRight, y },
      color,
      role === 'entry' ? 1.25 : 0.85,
      dash
    )
    if (d.label) {
      const short =
        d.label.length > 14 ? d.label.slice(0, 12) + '…' : d.label
      const txt = `${short} ${view.formatPrice(d.price)}`
      compactTag(ctx, view.plotRight - 2, y, txt, color, 'end')
    } else if (d.role && d.role !== 'neutral') {
      compactTag(ctx, view.plotRight - 2, y, view.formatPrice(d.price), color, 'end')
    }
    return
  }

  if (d.type === 'vline') {
    const x = vlinePx(view, d)
    if (x == null) return
    const color = d.color ?? '#787b86'
    dpiLine(
      ctx,
      { x, y: 0 },
      { x, y: view.plotBottom },
      color,
      1,
      [4, 3]
    )
    if (d.label) {
      ctx.save()
      ctx.font = FONT
      ctx.fillStyle = color
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(d.label, x + 4, 4)
      ctx.restore()
    }
    return
  }

  if (d.type === 'zone') {
    const px = zonePx(view, d)
    if (!px) return
    const style = ZONE_STYLE[d.kind]
    ctx.save()
    ctx.fillStyle = style.fill
    ctx.fillRect(px.x0, px.yTop, px.x1 - px.x0, px.yBottom - px.yTop)
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = style.stroke
    ctx.lineWidth = 1
    ctx.strokeRect(px.x0, px.yTop, px.x1 - px.x0, px.yBottom - px.yTop)
    ctx.restore()
    const bandH = Math.abs(px.yBottom - px.yTop)
    const label = d.label ? d.label : style.label
    if (bandH >= 10) {
      compactTag(ctx, px.x0 + 4, px.yTop + 10, label, style.stroke, 'start')
    }
    return
  }

  if (d.type === 'trendline') {
    const px = trendPx(view, d)
    if (!px) return
    const color = TREND_COLOR[d.role ?? 'trend'] ?? TREND_COLOR.trend
    dpiLine(ctx, px.a, px.b, color, 1, d.ray ? [] : [6, 4])
    if (d.label) {
      const midX = (px.a.x + px.b.x) / 2
      const midY = (px.a.y + px.b.y) / 2
      tag(ctx, midX, midY - 6, d.label, color, 'center')
    }
    return
  }

  if (d.type === 'fib') {
    const px = fibPx(view, d)
    if (!px) return
    const priceRange = Math.abs(d.toPrice - d.fromPrice)
    const isUp = d.toPrice > d.fromPrice

    for (const { ratio, label, color } of FIB_LEVELS) {
      const fibPrice = isUp
        ? d.fromPrice + ratio * priceRange
        : d.fromPrice - ratio * priceRange
      const y = view.priceToY(fibPrice)
      if (y == null) continue

      // Fill between adjacent levels
      if (ratio > 0) {
        const prevRatio = FIB_LEVELS[FIB_LEVELS.findIndex(l => l.ratio === ratio) - 1]?.ratio ?? 0
        const prevPrice = isUp
          ? d.fromPrice + prevRatio * priceRange
          : d.fromPrice - prevRatio * priceRange
        const prevY = view.priceToY(prevPrice)
        if (prevY != null) {
          ctx.save()
          ctx.fillStyle = color.replace(')', ', 0.04)').replace('rgb', 'rgba')
          ctx.globalAlpha = 0.12
          ctx.fillRect(px.x0, Math.min(y, prevY), px.x1 - px.x0, Math.abs(prevY - y))
          ctx.globalAlpha = 1
          ctx.restore()
        }
      }

      // Level line
      dpiLine(
        ctx,
        { x: px.x0, y },
        { x: px.x1, y },
        color,
        0.8,
        []
      )

      // Label
      ctx.save()
      ctx.font = FONT
      ctx.fillStyle = color
      ctx.textAlign = 'right'
      ctx.textBaseline = 'bottom'
      ctx.fillText(`${label}  ${view.formatPrice(fibPrice)}`, px.x1 - 4, y - 2)
      ctx.restore()
    }

    // Border lines
    dpiLine(ctx, { x: px.x0, y: px.fromY }, { x: px.x0, y: px.toY }, '#787b86', 0.5, [3, 3])
    dpiLine(ctx, { x: px.x1, y: px.fromY }, { x: px.x1, y: px.toY }, '#787b86', 0.5, [3, 3])

    if (d.label) tag(ctx, px.x0 + 4, Math.min(px.fromY, px.toY) + 12, `FIB · ${d.label}`, '#787b86')
    return
  }

  if (d.type === 'arrow') {
    const px = arrowPx(view, d)
    if (!px) return
    const color = d.color ?? '#2962ff'
    dpiLine(ctx, px.a, px.b, color, 1.5)
    drawArrowhead(ctx, px.a, px.b, color, 9)
    if (d.label) {
      const midX = (px.a.x + px.b.x) / 2
      const midY = (px.a.y + px.b.y) / 2
      tag(ctx, midX, midY - 6, d.label, color, 'center')
    }
    return
  }

  if (d.type === 'position') {
    const px = positionPx(view, d)
    if (!px) return
    const isShort = d.side === 'short'
    const dash = d.pending ? [6, 4] : []
    const greenFill = 'rgba(38,166,154,0.14)'
    const redFill = 'rgba(239,83,80,0.14)'
    const rewardTop = Math.min(px.yE, px.yT)
    const rewardH = Math.abs(px.yT - px.yE)
    const riskTop = Math.min(px.yE, px.yS)
    const riskH = Math.abs(px.yS - px.yE)
    const w = px.x1 - px.x0
    ctx.save()
    ctx.setLineDash(dash)
    ctx.lineWidth = 0.5
    ctx.fillStyle = greenFill
    ctx.strokeStyle = '#26a69a'
    ctx.fillRect(px.x0, rewardTop, w, rewardH)
    ctx.strokeRect(px.x0, rewardTop, w, rewardH)
    ctx.fillStyle = redFill
    ctx.strokeStyle = '#ef5350'
    ctx.fillRect(px.x0, riskTop, w, riskH)
    ctx.strokeRect(px.x0, riskTop, w, riskH)
    ctx.restore()

    if (!opts?.nativePriceLines) {
      const lineEnd = view.plotRight - 2
      dpiLine(
        ctx,
        { x: 0, y: px.yS },
        { x: lineEnd, y: px.yS },
        '#ef5350',
        0.85,
        [5, 4]
      )
      dpiLine(
        ctx,
        { x: 0, y: px.yT },
        { x: lineEnd, y: px.yT },
        '#26a69a',
        0.85,
        [5, 4]
      )
      dpiLine(
        ctx,
        { x: 0, y: px.yE },
        { x: lineEnd, y: px.yE },
        '#2962ff',
        1,
        d.pending ? [5, 4] : []
      )

      const tags = layoutAxisTags([
        { y: px.yE, text: `E ${view.formatPrice(d.entry)}`, color: '#2962ff' },
        { y: px.yT, text: `TP ${view.formatPrice(d.takeProfit)}`, color: '#26a69a' },
        { y: px.yS, text: `SL ${view.formatPrice(d.stopLoss)}`, color: '#ef5350' },
      ])
      for (const t of tags) {
        compactTag(ctx, lineEnd, t.y, t.text, t.color, 'end')
      }
    }

    compactTag(
      ctx,
      px.x0 + 3,
      Math.min(px.yE, px.yS, px.yT) + 8,
      isShort ? 'SHORT' : 'LONG',
      '#787b86',
      'start'
    )
    return
  }

  if (d.type === 'label') {
    const px = labelPx(view, d)
    if (!px) return
    compactTag(ctx, px.x, px.y, `${d.text}  ${view.formatPrice(d.price)}`, '#d1d4dc', 'start')
    return
  }
}

export function renderSelection(
  ctx: CanvasRenderingContext2D,
  view: ChartView,
  d: ChartDrawing
) {
  for (const h of getHandles(view, d)) handleDot(ctx, h)
}
