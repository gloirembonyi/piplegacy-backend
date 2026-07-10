import { fetchQuotes, type QuoteResult } from '@/lib/finnhub'
import { fetchEconomicCalendar, getHighImpactEvents } from '@/lib/economic-calendar'
import type { EconomicEvent } from '@/lib/economic-calendar'
import {
  formatOpensIn,
  getMarketLiquidity,
  getMinutesUntilNextSession,
  getTradingSessions,
  isForexMarketOpen,
} from '@/lib/market-sessions'

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type BriefTone = 'risk-on' | 'risk-off' | 'mixed' | 'quiet'

export type BriefSignal = {
  label: string
  symbol: string
  changePercent: number
  price: number
}

export type MarketBrief = {
  tone: BriefTone
  toneLabel: string
  headline: string
  paragraphs: string[]
  topPicks: BriefSignal[]
  riskOff: BriefSignal[]
  forexOpen: boolean
  liquidity: string
  activeSessions: string[]
  nextSession: { name: string; opensIn: string } | null
  nextEvent: { event: string; currency: string; opensIn: string } | null
  generatedAt: string
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const INDEX_PROBES = [
  { label: 'S&P 500', symbol: 'SPY' },
  { label: 'Nasdaq 100', symbol: 'QQQ' },
  { label: 'Dow 30', symbol: 'DIA' },
  { label: 'Russell 2000', symbol: 'IWM' },
  { label: 'VIX', symbol: 'UVXY' }, // VIX often blocked, UVXY as live proxy
]

const FX_PROBES = [
  { label: 'EUR/USD', symbol: 'OANDA:EUR_USD' },
  { label: 'USD/JPY', symbol: 'OANDA:USD_JPY' },
  { label: 'GBP/USD', symbol: 'OANDA:GBP_USD' },
]

const COMMODITY_PROBES = [
  { label: 'Gold', symbol: 'OANDA:XAU_USD' },
  { label: 'Oil', symbol: 'USO' },
]

const CRYPTO_PROBES = [
  { label: 'Bitcoin', symbol: 'BINANCE:BTCUSDT' },
  { label: 'Ethereum', symbol: 'BINANCE:ETHUSDT' },
]

function quoteToSignal(label: string, q: QuoteResult | undefined): BriefSignal | null {
  if (!q || !Number.isFinite(q.price) || !Number.isFinite(q.changePercent)) return null
  return { label, symbol: q.symbol, changePercent: q.changePercent, price: q.price }
}

function classifyTone(equity: BriefSignal[], vol: BriefSignal | null): BriefTone {
  if (equity.length === 0) return 'quiet'
  const avg = equity.reduce((s, q) => s + q.changePercent, 0) / equity.length
  const up = equity.filter((q) => q.changePercent > 0.1).length
  const down = equity.filter((q) => q.changePercent < -0.1).length
  const volSpike = vol ? vol.changePercent > 3 : false

  if (Math.abs(avg) < 0.15 && Math.abs(up - down) <= 1) return 'mixed'
  if (avg > 0.2 && !volSpike) return 'risk-on'
  if (avg < -0.2 || volSpike) return 'risk-off'
  return 'mixed'
}

function describeTone(tone: BriefTone): string {
  switch (tone) {
    case 'risk-on':
      return 'Risk-on'
    case 'risk-off':
      return 'Risk-off'
    case 'mixed':
      return 'Mixed tone'
    default:
      return 'Quiet'
  }
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '-'
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(2)
  return n.toFixed(4)
}

function describeNextEvent(ev: EconomicEvent): string {
  // Returns the time-until string, e.g. "in 2h 14m" / "in 38m"
  if (!ev.event_dt) return ev.time && ev.time !== '-' ? `at ${ev.time}` : 'soon'
  const ms = new Date(ev.event_dt).getTime() - Date.now()
  if (ms <= 0) return 'live'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  const rem = mins % 60
  if (hours < 24) return rem > 0 ? `in ${hours}h ${rem}m` : `in ${hours}h`
  const days = Math.floor(hours / 24)
  return `in ${days}d`
}

// ───────────────────────────────────────────────────────────────────────────
// Brief composer
// ───────────────────────────────────────────────────────────────────────────

export async function buildMarketBrief(): Promise<MarketBrief> {
  const allProbes = [
    ...INDEX_PROBES,
    ...FX_PROBES,
    ...COMMODITY_PROBES,
    ...CRYPTO_PROBES,
  ]

  const today = new Date().toISOString().split('T')[0]
  const end = new Date()
  end.setDate(end.getDate() + 2)
  const to = end.toISOString().split('T')[0]

  const [quotes, calendar] = await Promise.all([
    fetchQuotes(allProbes.map((p) => ({ symbol: p.symbol, label: p.label }))).catch(
      () => [] as QuoteResult[]
    ),
    fetchEconomicCalendar(today, to).catch(() => ({ data: [] as EconomicEvent[] })),
  ])

  const bySym = new Map(quotes.map((q) => [q.symbol, q]))
  const lookup = (sym: string) => bySym.get(sym)

  const indices = INDEX_PROBES.map((p) => quoteToSignal(p.label, lookup(p.symbol))).filter(
    Boolean
  ) as BriefSignal[]
  const equityCore = indices.filter(
    (i) => i.label !== 'VIX' && i.label !== 'UVXY'
  )
  const vix = indices.find((i) => i.label === 'VIX') ?? null

  const fx = FX_PROBES.map((p) => quoteToSignal(p.label, lookup(p.symbol))).filter(
    Boolean
  ) as BriefSignal[]
  const commodities = COMMODITY_PROBES.map((p) =>
    quoteToSignal(p.label, lookup(p.symbol))
  ).filter(Boolean) as BriefSignal[]
  const crypto = CRYPTO_PROBES.map((p) => quoteToSignal(p.label, lookup(p.symbol))).filter(
    Boolean
  ) as BriefSignal[]

  const allLive = [...equityCore, ...fx, ...commodities, ...crypto]
  const topPicks = [...allLive]
    .filter((q) => q.changePercent > 0)
    .sort((a, b) => b.changePercent - a.changePercent)
    .slice(0, 3)
  const riskOff = [...allLive]
    .filter((q) => q.changePercent < 0)
    .sort((a, b) => a.changePercent - b.changePercent)
    .slice(0, 3)

  const tone = classifyTone(equityCore, vix)
  const sessions = getTradingSessions()
  const activeSessions = sessions.filter((s) => s.isActive).map((s) => s.name)
  const forexOpen = isForexMarketOpen()
  const liquidity = getMarketLiquidity()
  const nextSession = getMinutesUntilNextSession()
  const highImpact = getHighImpactEvents(calendar.data || [], 5)
  const nextEvent = highImpact[0]

  // ── Compose paragraphs ────────────────────────────────────────────────
  const sentences: string[][] = [[], [], []]

  // P1 - tone + equities + vol
  const toneOpener =
    tone === 'risk-on'
      ? 'Risk appetite is on this session'
      : tone === 'risk-off'
        ? 'Risk-off across the board this session'
        : tone === 'mixed'
          ? 'A two-way tape this session'
          : 'A quiet drift this session'
  sentences[0].push(toneOpener + '.')
  if (equityCore.length >= 2) {
    const lead = equityCore
      .slice(0, 3)
      .map((q) => `${q.label} ${fmtPct(q.changePercent)}`)
      .join(', ')
    sentences[0].push(`Major equities: ${lead}.`)
  }
  if (vix && Math.abs(vix.changePercent) > 1) {
    sentences[0].push(
      `Volatility ${vix.changePercent > 0 ? 'firmer' : 'easier'} with ${vix.label} ${fmtPct(vix.changePercent)}.`
    )
  }

  // P2 - FX / Gold / Crypto context
  if (fx.length >= 2) {
    const dollarPairs = fx.slice(0, 2).map((q) => `${q.label} ${fmtPct(q.changePercent)}`)
    sentences[1].push(`In FX, ${dollarPairs.join(' and ')}.`)
  }
  const gold = commodities.find((c) => c.label === 'Gold')
  if (gold) {
    sentences[1].push(
      `Gold ${gold.changePercent >= 0 ? 'firms' : 'slides'} to $${fmtPrice(gold.price)} (${fmtPct(gold.changePercent)}).`
    )
  }
  const btc = crypto.find((c) => c.label === 'Bitcoin')
  if (btc) {
    sentences[1].push(
      `Bitcoin trades $${fmtPrice(btc.price)} (${fmtPct(btc.changePercent)}).`
    )
  }

  // P3 - sessions + next event
  if (activeSessions.length > 0) {
    const liqText = String(liquidity).toLowerCase()
    sentences[2].push(
      `${activeSessions.join(' & ')} session${activeSessions.length > 1 ? 's' : ''} active${
        liqText === 'high'
          ? ' with high liquidity'
          : liqText === 'low'
            ? ' on thin liquidity'
            : ''
      }.`
    )
  } else if (!forexOpen) {
    sentences[2].push('FX market is closed for the weekend.')
  }
  if (nextSession) {
    sentences[2].push(
      `${nextSession.name} opens ${formatOpensIn(nextSession.minutes)}.`
    )
  }
  if (nextEvent) {
    const when = describeNextEvent(nextEvent)
    sentences[2].push(
      `Heads-up: ${nextEvent.event} (${nextEvent.currency}) ${when} - keep risk tight around the release.`
    )
  }

  const paragraphs = sentences
    .map((arr) => arr.join(' ').trim())
    .filter((p) => p.length > 0)

  // ── Single-line headline ──────────────────────────────────────────────
  const breadthUp = equityCore.filter((q) => q.changePercent > 0).length
  const breadthDown = equityCore.filter((q) => q.changePercent < 0).length
  const breadthLine =
    equityCore.length > 0
      ? `${breadthUp}/${equityCore.length} indices up`
      : ''
  const headline = [
    describeTone(tone),
    breadthLine,
    activeSessions.length > 0 ? `${activeSessions.join(' + ')} active` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return {
    tone,
    toneLabel: describeTone(tone),
    headline,
    paragraphs,
    topPicks,
    riskOff,
    forexOpen,
    liquidity,
    activeSessions,
    nextSession: nextSession
      ? { name: nextSession.name, opensIn: formatOpensIn(nextSession.minutes) }
      : null,
    nextEvent: nextEvent
      ? {
          event: nextEvent.event,
          currency: nextEvent.currency,
          opensIn: describeNextEvent(nextEvent),
        }
      : null,
    generatedAt: new Date().toISOString(),
  }
}
