/** Consistent price rounding / display for agent output and UI. */

export function marketPriceDecimals(price: number, symbol?: string): number {
  const abs = Math.abs(price)
  const u = symbol?.toUpperCase() ?? ''

  if (u.includes('JPY')) return abs >= 100 ? 2 : 3
  if (u.includes('XAU') || u.includes('XAG')) return 2

  if (abs >= 10_000) return 2
  if (abs >= 100) return 2
  if (abs >= 1) return 4
  if (abs >= 0.01) return 5
  return 6
}

export function roundMarketPrice(price: number, symbol?: string): number {
  if (!Number.isFinite(price)) return price
  const d = marketPriceDecimals(price, symbol)
  const factor = 10 ** d
  return Math.round(price * factor) / factor
}

export function formatMarketPrice(
  price: number | null | undefined,
  symbol?: string
): string {
  if (price == null || !Number.isFinite(price)) return '-'
  const rounded = roundMarketPrice(price, symbol)
  const d = marketPriceDecimals(rounded, symbol)
  return rounded.toLocaleString(undefined, {
    minimumFractionDigits: d >= 4 ? d : Math.min(2, d),
    maximumFractionDigits: d,
  })
}

/** Clean long float noise the model/pipeline sometimes emits in prose. */
export function scrubNoisyDecimals(text: string): string {
  return text.replace(
    /(?<![\d.])(\d{1,12}\.\d{5,})(?![\d.])/g,
    (raw) => {
      const n = parseFloat(raw)
      return Number.isFinite(n) ? formatMarketPrice(n) : raw
    }
  )
}
