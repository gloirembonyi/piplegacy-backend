/** Forex Factory calendar via public weekly JSON feed (community mirror). */

export type ForexFactoryRawEvent = {
  title: string
  country: string
  date: string
  impact: string
  forecast: string
  previous: string
  actual?: string
}

export type ForexFactoryEvent = {
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
}

const FF_THIS_WEEK =
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const FF_NEXT_WEEK =
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json'
const FF_MIRROR_THIS_WEEK =
  'https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json'
const FF_MIRROR_NEXT_WEEK =
  'https://cdn-nfs.faireconomy.media/ff_calendar_nextweek.json'

function normalizeImpact(raw: string): ForexFactoryEvent['impact'] {
  const v = (raw || '').toLowerCase()
  if (v.includes('high')) return 'high'
  if (v.includes('medium') || v.includes('med')) return 'medium'
  if (v.includes('holiday')) return 'holiday'
  return 'low'
}

function parseFfEvent(raw: ForexFactoryRawEvent, index: number): ForexFactoryEvent | null {
  if (!raw.title?.trim() || !raw.date) return null

  const parsed = new Date(raw.date)
  if (Number.isNaN(parsed.getTime())) return null

  const currency = (raw.country || '').trim().toUpperCase()
  const date = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
  const time = parsed.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  return {
    event_id: `ff-${date}-${currency}-${index}`,
    event: raw.title.trim(),
    date,
    time,
    country: currency.length === 3 ? currency : raw.country,
    currency: currency.length === 3 ? currency : '',
    impact: normalizeImpact(raw.impact),
    forecast: raw.forecast?.trim() || '-',
    previous: raw.previous?.trim() || '-',
    actual: raw.actual?.trim() || '-',
    event_dt: parsed.toISOString(),
  }
}

async function fetchFfWeek(url: string): Promise<ForexFactoryRawEvent[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) return []
    const raw = (await res.json()) as ForexFactoryRawEvent[]
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchForexFactoryCalendar(
  fromDate: string,
  toDate: string
): Promise<ForexFactoryEvent[]> {
  try {
    const [thisWeek, nextWeek, mirrorThis, mirrorNext] = await Promise.all([
      fetchFfWeek(FF_THIS_WEEK),
      fetchFfWeek(FF_NEXT_WEEK),
      fetchFfWeek(FF_MIRROR_THIS_WEEK),
      fetchFfWeek(FF_MIRROR_NEXT_WEEK),
    ])
    const raw = [...thisWeek, ...nextWeek, ...mirrorThis, ...mirrorNext]

    const seen = new Set<string>()
    const events: ForexFactoryEvent[] = []
    raw.forEach((item, i) => {
      const ev = parseFfEvent(item, i)
      if (!ev || ev.date < fromDate || ev.date > toDate) return
      const key = `${ev.date}|${ev.time}|${ev.currency}|${ev.event}`
      if (seen.has(key)) return
      seen.add(key)
      events.push(ev)
    })

    return events.sort((a, b) => {
      const ta = new Date(a.event_dt).getTime()
      const tb = new Date(b.event_dt).getTime()
      return ta - tb
    })
  } catch (err) {
    console.warn('[forex-factory] calendar fetch failed:', err)
    return []
  }
}
