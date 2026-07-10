import {
  LineStyle,
  type IPriceLine,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import type {
  ChartDrawing,
  ChartHLineDrawing,
  ChartHLineRole,
} from '@/lib/chart-drawings'

const ROLE_COLOR: Record<ChartHLineRole, string> = {
  support: '#26a69a',
  resistance: '#ef5350',
  entry: '#2962ff',
  target: '#26a69a',
  pivot: '#9c27b0',
  liquidity: '#ff9800',
  invalidation: '#b71c1c',
  neutral: '#787b86',
}

const ROLE_STYLE: Record<ChartHLineRole, LineStyle> = {
  support: LineStyle.Solid,
  resistance: LineStyle.Solid,
  entry: LineStyle.Dashed,
  target: LineStyle.Dotted,
  pivot: LineStyle.Solid,
  liquidity: LineStyle.LargeDashed,
  invalidation: LineStyle.Solid,
  neutral: LineStyle.Solid,
}

function roleForDrawing(d: ChartHLineDrawing): ChartHLineRole {
  return (d.role ?? 'neutral') as ChartHLineRole
}

function formatAxisTitle(label: string, price: number): string {
  const p =
    price >= 1000
      ? price.toFixed(2)
      : price >= 10
        ? price.toFixed(2)
        : price.toFixed(4)
  return `${label}  ${p}`
}

export function syncNativePriceLines(
  series: ISeriesApi<'Candlestick'>,
  drawings: ChartDrawing[],
  existing: IPriceLine[]
): IPriceLine[] {
  for (const line of existing) {
    try {
      series.removePriceLine(line)
    } catch {
      /* already removed */
    }
  }

  const next: IPriceLine[] = []
  const seen = new Set<number>()

  for (const d of drawings) {
    if (d.type === 'hline') {
      const key = Math.round(d.price * 100000)
      if (seen.has(key)) continue
      seen.add(key)
      const role = roleForDrawing(d)
      const label = d.label ?? role.toUpperCase()
      next.push(
        series.createPriceLine({
          price: d.price,
          color: ROLE_COLOR[role],
          lineWidth: 1,
          lineStyle: ROLE_STYLE[role],
          axisLabelVisible: true,
          title: formatAxisTitle(label, d.price),
        })
      )
      continue
    }

    if (d.type === 'position') {
      const triple: Array<{ price: number; label: string; role: ChartHLineRole }> =
        [
          {
            price: d.entry,
            label: d.pending ? 'Limit' : 'Entry',
            role: 'entry',
          },
          { price: d.stopLoss, label: 'SL', role: 'resistance' },
          { price: d.takeProfit, label: 'TP', role: 'target' },
        ]
      for (const t of triple) {
        const key = Math.round(t.price * 100000)
        if (seen.has(key)) continue
        seen.add(key)
        const color =
          t.role === 'entry'
            ? '#2962ff'
            : t.role === 'target'
              ? '#26a69a'
              : '#ef5350'
        next.push(
          series.createPriceLine({
            price: t.price,
            color,
            lineWidth: 1,
            lineStyle: ROLE_STYLE[t.role],
            axisLabelVisible: true,
            title: formatAxisTitle(t.label, t.price),
          })
        )
      }
    }
  }

  return next
}

/** Dedupe + sort candle rows for Lightweight Charts. */
export function normalizeCandleRows(
  candles: Array<{ t: number; o: number; h: number; l: number; c: number }>,
  resolution: string,
  toTime: (t: number, resolution: string) => Time
) {
  const map = new Map<string, { time: Time; open: number; high: number; low: number; close: number }>()
  for (const c of candles) {
    const time = toTime(c.t, resolution)
    const key = String(time)
    map.set(key, {
      time,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    })
  }
  return [...map.values()].sort((a, b) => {
    const ta = typeof a.time === 'string' ? a.time : Number(a.time)
    const tb = typeof b.time === 'string' ? b.time : Number(b.time)
    return ta > tb ? 1 : ta < tb ? -1 : 0
  })
}

const TV_UP = '#26a69a'
const TV_DOWN = '#ef5350'

/** Volume histogram rows aligned to candle times (TradingView-style colours). */
export function normalizeVolumeRows(
  candles: Array<{ t: number; o: number; c: number; v?: number }>,
  resolution: string,
  toTime: (t: number, resolution: string) => Time
) {
  const rows: Array<{ time: Time; value: number; color: string }> = []
  for (const c of candles) {
    const vol = c.v ?? 0
    if (vol <= 0) continue
    rows.push({
      time: toTime(c.t, resolution),
      value: vol,
      color: c.c >= c.o ? TV_UP : TV_DOWN,
    })
  }
  return rows
}
