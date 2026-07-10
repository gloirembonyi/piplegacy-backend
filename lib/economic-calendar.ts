/** Economic calendar - Finnhub + Forex Factory + FMP merged. */

import {
  CALENDAR_MAX_EVENTS,
  clampCalendarRange,
} from '@/lib/calendar-range'
import { fetchForexFactoryCalendar } from '@/lib/forex-factory-calendar'
import { fetchFinnhubEconomicCalendar } from '@/lib/finnhub'
import { mergeEconomicEvents } from '@/lib/merge-economic-calendar'

export type CalendarSourceTag = 'finnhub' | 'forexfactory' | 'fmp' | 'sample'

export type EconomicEvent = {
  event_id: string
  event: string
  date: string
  time: string
  country: string
  currency: string
  impact: 'high' | 'medium' | 'low' | 'holiday'
  forecast: string
  previous: string
  actual: string
  event_dt: string
  sources?: CalendarSourceTag[]
}

const COUNTRY_CURRENCY: Record<string, string> = {
  US: 'USD',
  USA: 'USD',
  EU: 'EUR',
  EUR: 'EUR',
  UK: 'GBP',
  GB: 'GBP',
  JP: 'JPY',
  JPN: 'JPY',
  AU: 'AUD',
  CA: 'CAD',
  CH: 'CHF',
  NZ: 'NZD',
  CN: 'CNY',
  DE: 'EUR',
  FR: 'EUR',
}

function mapCountryToCurrency(country: string): string {
  return COUNTRY_CURRENCY[country.toUpperCase()] || ''
}

function normalizeImpact(raw: string | undefined): EconomicEvent['impact'] {
  const v = (raw || 'low').toLowerCase()
  if (v.includes('holiday')) return 'holiday'
  if (v.includes('high')) return 'high'
  if (v.includes('medium') || v.includes('med')) return 'medium'
  return 'low'
}

function formatEventDateTime(date: string, time: string): string {
  if (!date || !time) return ''
  try {
    const [hours, minutes] = time.split(':').map(Number)
    const eventDate = new Date(date + 'T00:00:00')
    if (Number.isNaN(eventDate.getTime()) || Number.isNaN(hours) || Number.isNaN(minutes)) {
      return ''
    }
    eventDate.setHours(hours, minutes, 0, 0)
    return eventDate.toISOString()
  } catch {
    return ''
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '-'
  return String(v)
}

function mockCalendar(fromDate: string, toDate: string): EconomicEvent[] {
  const start = new Date(fromDate || new Date().toISOString().split('T')[0])
  const end = new Date(toDate || fromDate)
  const fmt = (d: Date) => d.toISOString().split('T')[0]

  const templates: Array<Omit<EconomicEvent, 'event_id' | 'date' | 'event_dt' | 'sources'>> = [
    { event: 'Non-Farm Payrolls', time: '08:30', country: 'US', currency: 'USD', impact: 'high', forecast: '+175K', previous: '+142K', actual: '-' },
    { event: 'Unemployment Rate', time: '08:30', country: 'US', currency: 'USD', impact: 'high', forecast: '3.8%', previous: '3.9%', actual: '-' },
    { event: 'ISM Manufacturing PMI', time: '10:00', country: 'US', currency: 'USD', impact: 'medium', forecast: '48.5', previous: '47.9', actual: '-' },
    { event: 'ECB Interest Rate Decision', time: '07:45', country: 'EU', currency: 'EUR', impact: 'high', forecast: '4.25%', previous: '4.25%', actual: '-' },
    { event: 'ECB Press Conference', time: '08:30', country: 'EU', currency: 'EUR', impact: 'high', forecast: '-', previous: '-', actual: '-' },
    { event: 'ADP Non-Farm Employment Change', time: '08:15', country: 'US', currency: 'USD', impact: 'medium', forecast: '+120K', previous: '+98K', actual: '-' },
    { event: 'Initial Jobless Claims', time: '08:30', country: 'US', currency: 'USD', impact: 'medium', forecast: '220K', previous: '215K', actual: '-' },
    { event: 'Core CPI m/m', time: '08:30', country: 'US', currency: 'USD', impact: 'high', forecast: '0.3%', previous: '0.2%', actual: '-' },
    { event: 'Retail Sales m/m', time: '08:30', country: 'US', currency: 'USD', impact: 'medium', forecast: '0.4%', previous: '0.1%', actual: '-' },
    { event: 'BoE Interest Rate Decision', time: '07:00', country: 'UK', currency: 'GBP', impact: 'high', forecast: '5.25%', previous: '5.25%', actual: '-' },
    { event: 'GDP q/q', time: '08:30', country: 'US', currency: 'USD', impact: 'high', forecast: '2.1%', previous: '2.0%', actual: '-' },
    { event: 'FOMC Statement', time: '14:00', country: 'US', currency: 'USD', impact: 'high', forecast: '-', previous: '-', actual: '-' },
    { event: 'German ZEW Economic Sentiment', time: '05:00', country: 'EU', currency: 'EUR', impact: 'medium', forecast: '12.3', previous: '10.4', actual: '-' },
    { event: 'CPI y/y', time: '08:30', country: 'US', currency: 'USD', impact: 'high', forecast: '2.9%', previous: '3.0%', actual: '-' },
    { event: 'BoJ Policy Rate', time: '23:30', country: 'JP', currency: 'JPY', impact: 'high', forecast: '0.10%', previous: '0.10%', actual: '-' },
  ]

  const out: EconomicEvent[] = []
  const cursor = new Date(start)
  let i = 0
  while (cursor <= end) {
    const date = fmt(cursor)
    const t = templates[i % templates.length]!
    out.push({
      ...t,
      event_id: `mock-${date}-${t.currency}-${i}`,
      date,
      event_dt: formatEventDateTime(date, t.time),
      sources: ['sample'],
    })
    cursor.setDate(cursor.getDate() + 1)
    i += 1
  }
  return out
}

async function fetchFmpEconomicCalendar(
  fromDate: string,
  toDate: string,
  apiKey: string
): Promise<EconomicEvent[]> {
  const bases = [
    `https://financialmodelingprep.com/stable/economic-calendar?from=${fromDate}&to=${toDate}&apikey=${apiKey}`,
    `https://financialmodelingprep.com/api/v3/economic_calendar?from=${fromDate}&to=${toDate}&apikey=${apiKey}`,
  ]

  for (const url of bases) {
    try {
      const res = await fetch(url, { next: { revalidate: 300 } })
      if (!res.ok) continue
      const raw = (await res.json()) as Array<Record<string, unknown>>
      if (!Array.isArray(raw) || raw.length === 0) continue

      return raw.map((event, i) => {
        const country = String(event.country || '')
        const date = String(event.date || '').slice(0, 10)
        const time = String(event.time || '')
        return {
          event_id: String(event.id || `fmp-${i}-${date}`),
          event: String(event.event || ''),
          date,
          time,
          country,
          currency: mapCountryToCurrency(country),
          impact: normalizeImpact(String(event.impact || '')),
          forecast: formatValue(event.forecast ?? event.estimate),
          previous: formatValue(event.previous ?? event.prev),
          actual: formatValue(event.actual),
          event_dt: formatEventDateTime(date, time),
          sources: ['fmp'],
        }
      })
    } catch {
      continue
    }
  }
  return []
}

async function fetchFinnhubCalendar(fromDate: string, toDate: string): Promise<EconomicEvent[]> {
  const chunks: Array<{ from: string; to: string }> = []
  let cursor = new Date(fromDate)
  const end = new Date(toDate)
  while (cursor <= end) {
    const chunkEnd = new Date(cursor)
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 27)
    if (chunkEnd > end) chunkEnd.setTime(end.getTime())
    chunks.push({
      from: cursor.toISOString().split('T')[0]!,
      to: chunkEnd.toISOString().split('T')[0]!,
    })
    cursor = new Date(chunkEnd)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  const parts = await Promise.all(
    chunks.map(async ({ from, to }) => {
      const raw = await fetchFinnhubEconomicCalendar(from, to)
      return raw
        .map((event, i) => {
          const country = String(event.country || '')
          const timeRaw = String(event.time || '')
          const dateRaw = String((event as { date?: string }).date || from).slice(0, 10)
          const time = timeRaw.length >= 5 ? timeRaw.slice(0, 5) : timeRaw
          if (dateRaw < fromDate || dateRaw > toDate) return null
          return {
            event_id: `fh-${country}-${dateRaw}-${i}`,
            event: String(event.event || 'Economic release'),
            date: dateRaw,
            time,
            country,
            currency: mapCountryToCurrency(country),
            impact: normalizeImpact(String(event.impact || '')),
            forecast: formatValue(event.estimate),
            previous: formatValue(event.prev),
            actual: formatValue(event.actual),
            event_dt: time ? formatEventDateTime(dateRaw, time) : '',
            sources: ['finnhub'] as CalendarSourceTag[],
          }
        })
        .filter((e): e is EconomicEvent => Boolean(e?.event))
    })
  )

  return mergeEconomicEvents(...parts)
}

function ffToEconomic(ff: Awaited<ReturnType<typeof fetchForexFactoryCalendar>>): EconomicEvent[] {
  return ff.map((e) => ({
    event_id: e.event_id,
    event: e.event,
    date: e.date,
    time: e.time,
    country: e.country,
    currency: e.currency,
    impact: e.impact,
    forecast: e.forecast,
    previous: e.previous,
    actual: e.actual,
    event_dt: e.event_dt,
    sources: ['forexfactory'] as CalendarSourceTag[],
  }))
}

export async function fetchEconomicCalendar(
  fromDate: string,
  toDate: string
): Promise<{ data: EconomicEvent[]; sources: CalendarSourceTag[] }> {
  const { from, to } = clampCalendarRange(fromDate, toDate)
  const tags: CalendarSourceTag[] = []

  const [ff, finnhub, fmp] = await Promise.all([
    fetchForexFactoryCalendar(from, to).catch(() => []),
    (async () => {
      const key = process.env.FINNHUB_API_KEY?.trim()
      if (!key || key === 'demo') return []
      try {
        return await fetchFinnhubCalendar(from, to)
      } catch {
        return []
      }
    })(),
    (async () => {
      const key =
        process.env.FMP_API_KEY?.trim() || process.env.NEXT_PUBLIC_FMP_API_KEY?.trim()
      if (!key) return []
      try {
        return await fetchFmpEconomicCalendar(from, to, key)
      } catch {
        return []
      }
    })(),
  ])

  if (ff.length) tags.push('forexfactory')
  if (finnhub.length) tags.push('finnhub')
  if (fmp.length) tags.push('fmp')

  // Finnhub/FMP first; Forex Factory last so forecast/actual win when released
  let merged = mergeEconomicEvents(finnhub, fmp, ffToEconomic(ff))

  if (merged.length === 0) {
    merged = mockCalendar(from, to).map((e) => ({ ...e, sources: ['sample'] as CalendarSourceTag[] }))
    tags.push('sample')
  }

  return { data: merged.slice(0, CALENDAR_MAX_EVENTS), sources: tags }
}

export function getHighImpactEvents(events: EconomicEvent[], limit = 5): EconomicEvent[] {
  return events
    .filter((e) => e.impact === 'high')
    .sort((a, b) => {
      const ta = a.event_dt ? new Date(a.event_dt).getTime() : 0
      const tb = b.event_dt ? new Date(b.event_dt).getTime() : 0
      return ta - tb
    })
    .slice(0, limit)
}
