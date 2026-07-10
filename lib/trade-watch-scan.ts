/**
 * Orchestrates a Trade Watch scan for one user's watchlist.
 */

import { runAiSetupForSymbol } from '@/lib/trade-watch-ai-setup'
import { fetchYahooCandles, fetchYahooQuote } from '@/lib/candle-providers/yahoo'
import { computeTechnicalSummary } from '@/lib/ai-tools/technical-indicators'
import { getMinutesUntilNextSession } from '@/lib/market-sessions'
import { getPlanLimits } from '@/lib/plan-limits'
import { getUserData } from '@/lib/user-store'
import { displaySymbolLabel, normalizeSymbol } from '@/lib/symbols'
import {
  AI_SCAN_COOLDOWN_MS,
  MOVEMENT_AI_THRESHOLD,
  type PairScanState,
  type TradeWatchAlert,
} from '@/lib/trade-watch-types'
import {
  buildPairScanState,
  detectMovementSignal,
  shouldRunAiScan,
  type PulseLevels,
} from '@/lib/trade-watch-engine'
import {
  getTradeWatchBook,
  hasRecentAlert,
  pushTradeWatchAlert,
  savePairStates,
} from '@/lib/trade-watch-store'

export type ScanSymbolResult = {
  symbol: string
  state: PairScanState
  alerts: TradeWatchAlert[]
  aiRan: boolean
}

export type ScanWatchlistResult = {
  scanned: number
  results: ScanSymbolResult[]
  newAlerts: TradeWatchAlert[]
}

async function loadPulseLevels(symbol: string): Promise<{
  price: number | null
  changePercent: number | null
  levels: PulseLevels
}> {
  const [quote, dailyBars] = await Promise.all([
    fetchYahooQuote(symbol),
    fetchYahooCandles(symbol, 'D', 30),
  ])
  const last = dailyBars[dailyBars.length - 1]
  const last20 = dailyBars.slice(-20)
  const recentHigh = last20.length > 0 ? Math.max(...last20.map((b) => b.h)) : null
  const recentLow = last20.length > 0 ? Math.min(...last20.map((b) => b.l)) : null
  const summary = dailyBars.length >= 20 ? computeTechnicalSummary(dailyBars) : null

  const price = quote?.price ?? null
  const changePercent =
    quote && quote.prevClose
      ? ((quote.price - quote.prevClose) / quote.prevClose) * 100
      : null

  return {
    price,
    changePercent,
    levels: {
      todayOpen: last?.o ?? null,
      todayHigh: last?.h ?? null,
      todayLow: last?.l ?? null,
      recentHigh,
      recentLow,
      atr14: summary?.atr14 ?? null,
    },
  }
}

function chartHref(symbol: string): string {
  return `/app?view=chart&symbol=${encodeURIComponent(symbol)}&panel=signals`
}

export async function scanWatchlistForUser(
  email: string,
  opts: {
    symbols?: string[]
    force?: boolean
    runAi?: boolean
  } = {}
): Promise<ScanWatchlistResult> {
  const user = await getUserData(email)
  const watchlist = (opts.symbols ?? user.watchlist ?? [])
    .map((s) => normalizeSymbol(s))
    .slice(0, 20)

  const book = await getTradeWatchBook(email)
  const config = book.config
  const active = opts.force || config.enabled

  if (watchlist.length === 0) {
    return { scanned: 0, results: [], newAlerts: [] }
  }

  const pairStates = { ...config.pairStates }
  const results: ScanSymbolResult[] = []
  const newAlerts: TradeWatchAlert[] = []

  for (const symbol of watchlist) {
    try {
      const pulse = await loadPulseLevels(symbol)
      if (pulse.price == null) continue

      const prev = pairStates[symbol]
      const minutesSincePrev = prev?.lastScanAt
        ? (Date.now() - Date.parse(prev.lastScanAt)) / 60_000
        : undefined

      const movement = detectMovementSignal({
        price: pulse.price,
        changePercent: pulse.changePercent ?? 0,
        levels: pulse.levels,
        prevPrice: prev?.lastPrice,
        minutesSincePrev,
      })

      const state = buildPairScanState(
        symbol,
        pulse.price,
        pulse.changePercent,
        movement
      )

      if (prev?.lastAiScanAt) state.lastAiScanAt = prev.lastAiScanAt
      if (prev?.lastSetupBias) state.lastSetupBias = prev.lastSetupBias
      if (prev?.lastConfluence) state.lastConfluence = prev.lastConfluence

      const symbolAlerts: TradeWatchAlert[] = []
      let aiRan = false
      let signalFired = false

      if (
        movement.signalScore >= 40 &&
        !hasRecentAlert(book.alerts, symbol, 'movement')
      ) {
        const alert = await pushTradeWatchAlert(email, {
          symbol,
          kind: 'movement',
          severity: movement.signalScore >= 65 ? 'critical' : 'warning',
          title: `${displaySymbolLabel(symbol)} - market moving`,
          detail: movement.reasons.slice(0, 2).join(' · ') || 'Momentum detected',
          signalScore: movement.signalScore,
          movementState: movement.movementState,
          href: chartHref(symbol),
        })
        if (alert) {
          signalFired = true
          symbolAlerts.push(alert)
          newAlerts.push(alert)
        }
      }

      if (
        movement.movementState === 'breakout' &&
        !hasRecentAlert(book.alerts, symbol, 'breakout')
      ) {
        const alert = await pushTradeWatchAlert(email, {
          symbol,
          kind: 'breakout',
          severity: 'critical',
          title: `${displaySymbolLabel(symbol)} - breakout zone`,
          detail:
            movement.direction === 'up'
              ? 'Price at/near 20D high - move may accelerate'
              : movement.direction === 'down'
                ? 'Price at/near 20D low - breakdown risk'
                : 'Key level test - watch for direction',
          signalScore: movement.signalScore,
          movementState: movement.movementState,
          href: chartHref(symbol),
        })
        if (alert) {
          signalFired = true
          symbolAlerts.push(alert)
          newAlerts.push(alert)
        }
      }

      const wantAi =
        (opts.runAi ?? (active && config.autoAnalyze)) &&
        getPlanLimits(user.plan).autoTrader &&
        (signalFired ||
          shouldRunAiScan(
            prev,
            movement.signalScore,
            MOVEMENT_AI_THRESHOLD,
            AI_SCAN_COOLDOWN_MS
          ))

      if (wantAi) {
        try {
          const ai = await runAiSetupForSymbol(email, symbol, { force: opts.force })
          aiRan = true
          state.lastAiScanAt = new Date().toISOString()
          if (ai.setup) {
            state.lastSetupBias = ai.setup.bias
            state.lastConfluence = ai.setup.confluenceScore ?? 0
            for (const a of ai.alerts) {
              if (!symbolAlerts.some((s) => s.id === a.id)) {
                symbolAlerts.push(a)
                if (!newAlerts.some((n) => n.id === a.id)) newAlerts.push(a)
              }
            }
          }
        } catch (err) {
          console.error(`trade-watch AI setup failed for ${symbol}:`, err)
        }
      }

      pairStates[symbol] = state
      results.push({ symbol, state, alerts: symbolAlerts, aiRan })
    } catch (err) {
      console.error(`trade-watch pulse failed for ${symbol}:`, err)
    }
  }

  await savePairStates(email, pairStates)

  return { scanned: results.length, results, newAlerts }
}

/** Session-open heads-up for FX/metals watchlist symbols. */
export async function pushSessionAlertsIfNeeded(
  email: string,
  symbols: string[]
): Promise<TradeWatchAlert[]> {
  const next = getMinutesUntilNextSession()
  if (!next || next.minutes <= 0 || next.minutes > 90) return []

  const fxLike = symbols.filter((s) =>
    /^(EUR|GBP|USD|JPY|AUD|NZD|CHF|CAD|XAU|XAG)/i.test(s)
  )
  if (fxLike.length === 0) return []

  const book = await getTradeWatchBook(email)
  const out: TradeWatchAlert[] = []

  for (const symbol of fxLike.slice(0, 4)) {
    if (hasRecentAlert(book.alerts, symbol, 'session', 3 * 60 * 60_000)) continue
    const alert = await pushTradeWatchAlert(email, {
      symbol,
      kind: 'session',
      severity: next.minutes <= 30 ? 'warning' : 'info',
      title: `${next.name} opens soon - ${displaySymbolLabel(symbol)}`,
      detail: `Liquidity returns in ~${next.minutes}m - watch for a move on ${displaySymbolLabel(symbol)}`,
      href: chartHref(symbol),
    })
    if (alert) out.push(alert)
  }
  return out
}
