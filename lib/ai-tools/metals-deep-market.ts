/**
 * Deep-market intelligence for precious metals - XAUUSD (gold) and XAGUSD (silver).
 *
 * Gold and silver trade OTC so there is no public L2 order book - but free
 * institutional-grade data exists across THREE complementary sources:
 *
 * 1. COMEX FUTURES (Yahoo Finance, no key)
 *      GC=F (gold), SI=F (silver) → bid/ask, volume, intraday OHLCV.
 *      This is the actual venue where institutional flow expresses itself
 *      and the futures price + spot rarely diverge by more than the basis.
 *
 * 2. CFTC COMMITMENTS OF TRADERS  (Socrata public API, no key)
 *      Weekly disaggregated positioning showing:
 *        - Producer/Merchant (commercial hedgers - "smart money")
 *        - Swap Dealers
 *        - Managed Money (hedge funds - speculators)
 *        - Other Reportables
 *      Net positioning + divergence between commercials and specs is the
 *      single most powerful long-horizon signal for metals.
 *
 * 3. LIVE SPOT (Goldprice.org public feed, no key)
 *      Real-time XAU/USD reference price used by every retail desk.
 *
 * Combined, these three sources give the agent a "deep market" view that
 * rivals what professional metals desks watch on a Bloomberg terminal.
 */

const TIMEOUT_MS = 5000

function timeoutFetch(
  url: string,
  ms = TIMEOUT_MS,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), ms)
  return fetch(url, {
    ...init,
    signal: controller.signal,
    headers: {
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (compatible; PiplegacyAgent/1.0; +https://signalmarket-ten.vercel.app)',
      ...(init?.headers ?? {}),
    },
  }).finally(() => clearTimeout(t))
}

// ──────────────────────────────────────────────────────────────────────────
// 1) COMEX futures quote (Yahoo Finance unofficial endpoint)
// ──────────────────────────────────────────────────────────────────────────

export type FuturesQuote = {
  source: 'yahoo'
  symbol: string
  longName: string
  price: number
  bid?: number
  ask?: number
  spreadBps?: number
  high: number
  low: number
  open: number
  prevClose: number
  changePct: number
  volume: number
  /** Average daily volume - sanity check vs current. */
  avgVolume?: number
  /** Open interest if reported (futures only). */
  openInterest?: number
  marketTimeIso: string
}

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string
        regularMarketPrice?: number
        chartPreviousClose?: number
        previousClose?: number
        regularMarketTime?: number
      }
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>
          high?: Array<number | null>
          low?: Array<number | null>
          close?: Array<number | null>
          volume?: Array<number | null>
        }>
      }
    }>
  }
}

/**
 * Futures quote via Yahoo's v8 chart endpoint (query1). The legacy v7 `quote`
 * endpoint now requires a crumb/cookie and fails server-side, so we derive the
 * snapshot (price, OHLC, volume, avg-volume, prev-close) from a short daily
 * candle window instead - this is the same endpoint that powers our charts.
 */
async function fetchYahooFuturesQuote(
  symbol: string
): Promise<FuturesQuote | null> {
  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=1d&range=3mo&includePrePost=false`
    const res = await timeoutFetch(url)
    if (!res.ok) return null
    const json = (await res.json()) as YahooChartResponse
    const result = json.chart?.result?.[0]
    const meta = result?.meta
    const q = result?.indicators?.quote?.[0]
    if (!result || !q?.close?.length) return null

    let lastIdx = -1
    for (let i = q.close.length - 1; i >= 0; i--) {
      if (q.close[i] != null) {
        lastIdx = i
        break
      }
    }
    if (lastIdx < 0) return null

    const price = meta?.regularMarketPrice ?? q.close[lastIdx] ?? 0
    if (!price) return null
    const prevClose =
      lastIdx > 0
        ? q.close[lastIdx - 1] ?? price
        : meta?.chartPreviousClose ?? meta?.previousClose ?? price

    const volumes = (q.volume ?? []).filter(
      (v): v is number => typeof v === 'number' && v > 0
    )
    const avgVolume =
      volumes.length > 0
        ? volumes.reduce((a, b) => a + b, 0) / volumes.length
        : undefined

    const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0

    return {
      source: 'yahoo',
      symbol: meta?.symbol ?? symbol,
      longName: symbol,
      price,
      bid: undefined,
      ask: undefined,
      spreadBps: undefined,
      high: q.high?.[lastIdx] ?? price,
      low: q.low?.[lastIdx] ?? price,
      open: q.open?.[lastIdx] ?? price,
      prevClose: prevClose ?? price,
      changePct,
      volume: q.volume?.[lastIdx] ?? 0,
      avgVolume,
      openInterest: undefined,
      marketTimeIso: meta?.regularMarketTime
        ? new Date(meta.regularMarketTime * 1000).toISOString()
        : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 2) CFTC Commitments of Traders (Socrata public API, free, no key)
//    Disaggregated futures-only report - most useful for commodities.
// ──────────────────────────────────────────────────────────────────────────

export type COTReport = {
  source: 'cftc'
  reportDate: string // YYYY-MM-DD
  marketName: string
  contractCode: string

  openInterest: number

  /** Commercials (Producer/Merchant + Swap Dealers) - the hedger class. */
  commercialLong: number
  commercialShort: number
  commercialNet: number
  commercialNetChange: number

  /** Managed Money - the hedge-fund / speculator class. */
  managedMoneyLong: number
  managedMoneyShort: number
  managedMoneyNet: number
  managedMoneyNetChange: number

  /** Other reportable (smaller funds). */
  otherReportableLong: number
  otherReportableShort: number
  otherReportableNet: number

  /** Non-reportable (retail). */
  nonreportableLong: number
  nonreportableShort: number
  nonreportableNet: number

  /** Net managed-money positioning as a % of OI - extremes flag turning points. */
  managedMoneyNetPctOfOI: number

  /**
   * Bias interpretation:
   *  - commercials NET LONG    = smart money is bullish (often a bottom signal)
   *  - commercials NET SHORT   = smart money is hedging (often a top signal)
   *  - managed money NET LONG  = specs are crowded long
   *  - managed money NET SHORT = specs are crowded short (squeeze risk)
   *  - DIVERGENCE between commercials and specs = high-conviction edge for commercials
   */
  commercialBias: 'long' | 'short' | 'neutral'
  managedMoneyBias: 'long' | 'short' | 'neutral'
  divergent: boolean
  divergenceNote?: string
}

const COMMODITY_MARKETS: Record<string, string> = {
  // Match what Socrata stores in `market_and_exchange_names`.
  XAUUSD: 'GOLD - COMMODITY EXCHANGE INC.',
  XAU: 'GOLD - COMMODITY EXCHANGE INC.',
  GOLD: 'GOLD - COMMODITY EXCHANGE INC.',
  XAGUSD: 'SILVER - COMMODITY EXCHANGE INC.',
  XAG: 'SILVER - COMMODITY EXCHANGE INC.',
  SILVER: 'SILVER - COMMODITY EXCHANGE INC.',
}

type DisaggregatedCOTRow = {
  report_date_as_yyyy_mm_dd?: string
  market_and_exchange_names?: string
  cftc_contract_market_code?: string
  open_interest_all?: string
  prod_merc_positions_long?: string
  prod_merc_positions_short?: string
  swap_positions_long_all?: string
  swap_positions_short_all?: string
  m_money_positions_long_all?: string
  m_money_positions_short_all?: string
  other_rept_positions_long?: string
  other_rept_positions_short?: string
  nonrept_positions_long_all?: string
  nonrept_positions_short_all?: string
  // Week-over-week change fields:
  change_in_prod_merc_long?: string
  change_in_prod_merc_short?: string
  change_in_swap_long_all?: string
  change_in_swap_short_all?: string
  change_in_m_money_long_all?: string
  change_in_m_money_short_all?: string
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function classifyBias(net: number, openInterest: number): 'long' | 'short' | 'neutral' {
  if (openInterest <= 0) return 'neutral'
  const ratio = net / openInterest
  if (ratio > 0.05) return 'long'
  if (ratio < -0.05) return 'short'
  return 'neutral'
}

export async function fetchCOTReport(symbol: string): Promise<COTReport | null> {
  const upper = symbol.toUpperCase().replace(/[^A-Z]/g, '')
  // Try several alias keys.
  const marketName =
    COMMODITY_MARKETS[upper] ??
    COMMODITY_MARKETS[upper.replace(/USD$/, '')] ??
    null
  if (!marketName) return null

  try {
    const url =
      `https://publicreporting.cftc.gov/resource/72hh-3qpy.json` +
      `?$where=${encodeURIComponent(`market_and_exchange_names='${marketName}'`)}` +
      `&$order=report_date_as_yyyy_mm_dd DESC&$limit=1`

    const res = await timeoutFetch(url, 6000)
    if (!res.ok) return null
    const rows = (await res.json()) as DisaggregatedCOTRow[]
    const row = rows?.[0]
    if (!row) return null

    const openInterest = num(row.open_interest_all)
    const prodLong = num(row.prod_merc_positions_long)
    const prodShort = num(row.prod_merc_positions_short)
    const swapLong = num(row.swap_positions_long_all)
    const swapShort = num(row.swap_positions_short_all)
    const mLong = num(row.m_money_positions_long_all)
    const mShort = num(row.m_money_positions_short_all)
    const otherLong = num(row.other_rept_positions_long)
    const otherShort = num(row.other_rept_positions_short)
    const nrLong = num(row.nonrept_positions_long_all)
    const nrShort = num(row.nonrept_positions_short_all)

    const commercialLong = prodLong + swapLong
    const commercialShort = prodShort + swapShort
    const commercialNet = commercialLong - commercialShort
    const commercialNetChange =
      num(row.change_in_prod_merc_long) -
      num(row.change_in_prod_merc_short) +
      num(row.change_in_swap_long_all) -
      num(row.change_in_swap_short_all)

    const managedMoneyNet = mLong - mShort
    const managedMoneyNetChange =
      num(row.change_in_m_money_long_all) -
      num(row.change_in_m_money_short_all)

    const commercialBias = classifyBias(commercialNet, openInterest)
    const managedMoneyBias = classifyBias(managedMoneyNet, openInterest)
    const divergent =
      (commercialBias === 'long' && managedMoneyBias === 'short') ||
      (commercialBias === 'short' && managedMoneyBias === 'long')

    let divergenceNote: string | undefined
    if (divergent) {
      divergenceNote =
        commercialBias === 'long'
          ? 'Commercials accumulating while specs short - historically bullish setup (mean-reversion / bottom).'
          : 'Commercials hedging while specs chase - historically bearish setup (top warning).'
    }

    return {
      source: 'cftc',
      reportDate: row.report_date_as_yyyy_mm_dd ?? '',
      marketName,
      contractCode: row.cftc_contract_market_code ?? '',
      openInterest,
      commercialLong,
      commercialShort,
      commercialNet,
      commercialNetChange,
      managedMoneyLong: mLong,
      managedMoneyShort: mShort,
      managedMoneyNet,
      managedMoneyNetChange,
      otherReportableLong: otherLong,
      otherReportableShort: otherShort,
      otherReportableNet: otherLong - otherShort,
      nonreportableLong: nrLong,
      nonreportableShort: nrShort,
      nonreportableNet: nrLong - nrShort,
      managedMoneyNetPctOfOI:
        openInterest > 0 ? (managedMoneyNet / openInterest) * 100 : 0,
      commercialBias,
      managedMoneyBias,
      divergent,
      divergenceNote,
    }
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 3) Live spot composite (Goldprice.org JSON feed)
// ──────────────────────────────────────────────────────────────────────────

export type GoldSpotQuote = {
  source: 'goldprice'
  metal: 'gold' | 'silver'
  pricePerOzUsd: number
  changeUsd: number
  changePct: number
  timestampIso: string
}

type GoldPriceResponse = {
  items?: Array<{
    curr?: string
    xauPrice?: number
    xagPrice?: number
    chgXau?: number
    chgXag?: number
    pcXau?: number
    pcXag?: number
  }>
  ts?: number
}

export async function fetchGoldSpot(
  metal: 'gold' | 'silver' = 'gold'
): Promise<GoldSpotQuote | null> {
  try {
    const res = await timeoutFetch(
      'https://data-asg.goldprice.org/dbXRates/USD',
      5000
    )
    if (!res.ok) return null
    const json = (await res.json()) as GoldPriceResponse
    const usd = json.items?.find((it) => it.curr === 'USD')
    if (!usd) return null

    const price = metal === 'gold' ? usd.xauPrice : usd.xagPrice
    const chg = metal === 'gold' ? usd.chgXau : usd.chgXag
    const pc = metal === 'gold' ? usd.pcXau : usd.pcXag
    if (typeof price !== 'number' || !Number.isFinite(price)) return null

    return {
      source: 'goldprice',
      metal,
      pricePerOzUsd: price,
      changeUsd: typeof chg === 'number' ? chg : 0,
      changePct: typeof pc === 'number' ? pc : 0,
      timestampIso: json.ts
        ? new Date(json.ts).toISOString()
        : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Combined deep-market snapshot
// ──────────────────────────────────────────────────────────────────────────

export type MetalsDeepMarket = {
  metal: 'gold' | 'silver'
  symbol: string
  spot: GoldSpotQuote | null
  futures: FuturesQuote | null
  cot: COTReport | null
  /** Cross-source sanity: spot vs futures basis (futures - spot). */
  futuresSpotBasis: number | null
  /** Volume vs 3-month average - > 1.5 flags a high-volume session. */
  relativeVolume: number | null
  notes: string[]
}

function buildNotes(snap: {
  spot: GoldSpotQuote | null
  futures: FuturesQuote | null
  cot: COTReport | null
  basis: number | null
  relativeVolume: number | null
}): string[] {
  const notes: string[] = []
  const { spot, futures, cot, basis, relativeVolume } = snap

  if (futures && spot && basis != null) {
    if (basis > 5) {
      notes.push(
        `Futures premium of $${basis.toFixed(2)} over spot - contango / institutional demand.`
      )
    } else if (basis < -5) {
      notes.push(
        `Futures discount of $${Math.abs(basis).toFixed(2)} vs spot - unusual, often a sign of stress or physical squeeze.`
      )
    }
  }

  if (relativeVolume != null) {
    if (relativeVolume >= 1.5) {
      notes.push(
        `High relative volume (${relativeVolume.toFixed(2)}× 3-month avg) - meaningful institutional flow today.`
      )
    } else if (relativeVolume <= 0.5) {
      notes.push(
        `Low relative volume (${relativeVolume.toFixed(2)}× 3-month avg) - drift session, low-conviction moves.`
      )
    }
  }

  if (futures?.spreadBps != null) {
    if (futures.spreadBps < 1) {
      notes.push('Tight bid/ask spread - tier-1 liquidity, low slippage risk.')
    } else if (futures.spreadBps > 5) {
      notes.push(
        `Wider spread (${futures.spreadBps.toFixed(1)} bps) - execution slippage risk on size.`
      )
    }
  }

  if (cot) {
    notes.push(
      `COT (as of ${cot.reportDate}): commercials NET ${cot.commercialNet.toLocaleString()} (${cot.commercialBias}), managed money NET ${cot.managedMoneyNet.toLocaleString()} (${cot.managedMoneyBias}).`
    )
    if (cot.divergenceNote) notes.push(cot.divergenceNote)
    if (Math.abs(cot.managedMoneyNetPctOfOI) > 20) {
      notes.push(
        `Specs ${cot.managedMoneyBias} ${Math.abs(cot.managedMoneyNetPctOfOI).toFixed(1)}% of OI - crowded positioning, squeeze risk if catalyst flips sentiment.`
      )
    }
  }

  return notes
}

/**
 * One-shot deep-market snapshot for gold/silver. Fetches futures + COT +
 * spot in PARALLEL with timeouts; missing sources just return null.
 */
export async function fetchMetalsDeepMarket(
  symbolInput: string
): Promise<MetalsDeepMarket | null> {
  const upper = symbolInput.toUpperCase().replace(/[^A-Z]/g, '')
  const isSilver = upper === 'XAG' || upper === 'XAGUSD' || upper === 'SILVER'
  const metal: 'gold' | 'silver' = isSilver ? 'silver' : 'gold'
  const futuresSymbol = isSilver ? 'SI=F' : 'GC=F'

  const [spot, futures, cot] = await Promise.all([
    fetchGoldSpot(metal),
    fetchYahooFuturesQuote(futuresSymbol),
    fetchCOTReport(symbolInput),
  ])

  // If everything failed, signal nothing-to-show.
  if (!spot && !futures && !cot) return null

  const basis =
    futures && spot ? futures.price - spot.pricePerOzUsd : null
  const relativeVolume =
    futures?.volume && futures.avgVolume
      ? futures.volume / futures.avgVolume
      : null

  const notes = buildNotes({ spot, futures, cot, basis, relativeVolume })

  return {
    metal,
    symbol: symbolInput.toUpperCase(),
    spot,
    futures,
    cot,
    futuresSpotBasis: basis,
    relativeVolume,
    notes,
  }
}
