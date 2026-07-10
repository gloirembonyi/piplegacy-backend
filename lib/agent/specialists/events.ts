/**
 * Events specialist - high-impact economic calendar items + active sessions.
 * No model call needed: this is rule-based + cheap, fast, deterministic.
 *
 * The orchestrator treats `AVOID` from this specialist as a hard veto on new
 * entries (news blackout window) - sentiment / TA can be bullish but the
 * decision orchestrator will downgrade the setup to HOLD.
 */

import { fetchEconomicCalendar } from '@/lib/economic-calendar'
import {
  getActiveSessionNames,
  getMarketLiquidity,
  getMinutesUntilNextSession,
  formatOpensIn,
} from '@/lib/market-sessions'
import type { SpecialistReport } from '@/lib/agent/pipeline-types'
import type { SpecialistContext } from '@/lib/agent/specialists/helpers'

const BLACKOUT_BEFORE_MIN = 15
const BLACKOUT_AFTER_MIN = 30
const CALENDAR_LOOKAHEAD_HOURS = 36

function relevantCurrencies(symbol: string): string[] {
  const s = symbol.toUpperCase()
  const fx = s.match(/([A-Z]{3})[_./]?([A-Z]{3})/)
  if (fx) return [fx[1], fx[2]]
  if (s.startsWith('XAU') || s.startsWith('XAG')) return ['USD']
  return ['USD']
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function parseEventTimestamp(event_dt?: string, date?: string, time?: string): number | null {
  if (event_dt) {
    const ts = Date.parse(event_dt)
    if (Number.isFinite(ts)) return ts
  }
  if (!date || !time) return null
  const ts = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`)
  return Number.isFinite(ts) ? ts : null
}

export async function runEventsSpecialist(
  ctx: SpecialistContext
): Promise<SpecialistReport> {
  const start = Date.now()
  const { symbol, symbolLabel } = ctx
  try {
    const now = Date.now()
    const from = isoDate(now - 6 * 60 * 60 * 1000)
    const to = isoDate(now + CALENDAR_LOOKAHEAD_HOURS * 60 * 60 * 1000)
    const calendar = await fetchEconomicCalendar(from, to)
    const ccys = relevantCurrencies(symbol)

    const activeSessions = getActiveSessionNames()
    const liquidity = getMarketLiquidity()
    const nextSessionInfo = getMinutesUntilNextSession()
    const nextSessionMins = nextSessionInfo?.minutes ?? null
    const opensIn = nextSessionMins != null ? formatOpensIn(nextSessionMins) : null

    type ImpactRow = { event: string; currency: string; impact: string; ts: number }
    const highImpact: ImpactRow[] = (calendar.data ?? [])
      .filter((e) => e.impact?.toLowerCase() === 'high')
      .filter((e) => ccys.includes(e.currency?.toUpperCase()))
      .map((e) => {
        const ts = parseEventTimestamp(e.event_dt, e.date, e.time)
        return ts == null
          ? null
          : ({ event: e.event, currency: e.currency, impact: e.impact, ts } as ImpactRow)
      })
      .filter((e): e is ImpactRow => e !== null)
      .sort((a, b) => a.ts - b.ts)

    const inBlackout = highImpact.find(
      (e) =>
        e.ts >= now - BLACKOUT_AFTER_MIN * 60_000 &&
        e.ts <= now + BLACKOUT_BEFORE_MIN * 60_000
    )
    const upcoming = highImpact.find((e) => e.ts > now)

    let verdict: SpecialistReport['verdict'] = 'NEUTRAL'
    let confidence = 60
    let headline = `Liquidity ${liquidity}; ${activeSessions.length ? activeSessions.join(', ') : 'no session'} active`
    let situation = `${activeSessions.length ? activeSessions.join(' + ') : 'No major session'} active, ${liquidity.toLowerCase()} liquidity${opensIn ? ` · next session ${opensIn}` : ''}. No high-impact ${ccys.join('/')} release in the next ${CALENDAR_LOOKAHEAD_HOURS}h.`
    const blockers: string[] = []

    if (inBlackout) {
      verdict = 'AVOID'
      confidence = 92
      headline = `News blackout - ${inBlackout.event} (${inBlackout.currency}) ±${BLACKOUT_BEFORE_MIN}m`
      situation = `Inside the news-blackout window for ${inBlackout.event} (${inBlackout.currency}) - new entries should stand aside until ${BLACKOUT_BEFORE_MIN}m after release.`
      blockers.push(`Blackout window around ${inBlackout.event}`)
    } else if (upcoming) {
      const minutesUntil = Math.round((upcoming.ts - now) / 60_000)
      if (minutesUntil < 60) {
        verdict = 'NEUTRAL'
        confidence = 70
        headline = `${upcoming.event} (${upcoming.currency}) in ${minutesUntil}m - size down`
        situation = `${upcoming.event} (${upcoming.currency}) lands in ${minutesUntil}m - expect volatility, size down or wait for the print.`
        blockers.push(`High-impact ${upcoming.event} within 1h`)
      } else {
        headline = `Next high-impact: ${upcoming.event} (${upcoming.currency}) in ${minutesUntil}m`
        situation = `Clear for now - next high-impact ${upcoming.event} (${upcoming.currency}) is ${minutesUntil}m away, still outside the immediate risk window.`
      }
    } else if (liquidity === 'Low') {
      verdict = 'NEUTRAL'
      confidence = 50
      headline = `Low liquidity (${opensIn ? `next session ${opensIn}` : 'between sessions'})`
      situation = `Thin liquidity between sessions${opensIn ? ` - next session opens ${opensIn}` : ''}; expect choppier fills and wider spreads.`
    }

    return {
      id: 'events',
      verdict,
      confidence,
      headline,
      situation,
      durationMs: Date.now() - start,
      blockers: blockers.length > 0 ? blockers : undefined,
      data: {
        symbol,
        symbolLabel,
        activeSessions,
        liquidity,
        opensIn,
        nextSessionMins,
        nextHighImpact: upcoming
          ? { ...upcoming, isoTime: new Date(upcoming.ts).toISOString() }
          : null,
        inBlackoutEvent: inBlackout
          ? { ...inBlackout, isoTime: new Date(inBlackout.ts).toISOString() }
          : null,
        currencies: ccys,
      },
    }
  } catch (err) {
    return {
      id: 'events',
      verdict: 'NEUTRAL',
      confidence: 30,
      headline: 'Calendar unavailable',
      durationMs: Date.now() - start,
      degraded: true,
      error: err instanceof Error ? err.message : 'unknown error',
    }
  }
}
