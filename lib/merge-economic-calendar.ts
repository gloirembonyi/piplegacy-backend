import type { EconomicEvent } from '@/lib/economic-calendar'

function normTitle(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 48)
}

export function eventMergeKey(e: Pick<EconomicEvent, 'event' | 'date' | 'time' | 'currency'>) {
  return `${e.date}|${e.time}|${e.currency}|${normTitle(e.event)}`
}

export function mergeEconomicEvents(...lists: EconomicEvent[][]): EconomicEvent[] {
  const map = new Map<string, EconomicEvent>()

  for (const list of lists) {
    for (const item of list) {
      const key = eventMergeKey(item)
      const existing = map.get(key)
      if (!existing) {
        map.set(key, { ...item, sources: [...(item.sources || [])] })
        continue
      }

      const sources = new Set([...(existing.sources || []), ...(item.sources || [])])
      map.set(key, {
        ...existing,
        ...item,
        event: item.event?.length >= existing.event?.length ? item.event : existing.event,
        forecast: pickValue(item.forecast, existing.forecast),
        previous: pickValue(item.previous, existing.previous),
        actual: pickValue(item.actual, existing.actual),
        impact: pickHigherImpact(existing.impact, item.impact),
        event_dt: pickValueDt(item.event_dt, existing.event_dt),
        time: item.time && item.time !== '-' ? item.time : existing.time,
        sources: [...sources],
      })
    }
  }

  return [...map.values()].sort((a, b) => {
    const ta = a.event_dt ? new Date(a.event_dt).getTime() : 0
    const tb = b.event_dt ? new Date(b.event_dt).getTime() : 0
    return ta - tb
  })
}

function pickValue(next: string, prev: string) {
  if (next && next !== '-') return next
  return prev || '-'
}

function pickValueDt(next: string, prev: string) {
  if (next) return next
  return prev || ''
}

const IMPACT_RANK: Record<EconomicEvent['impact'], number> = {
  high: 3,
  medium: 2,
  low: 1,
  holiday: 0,
}

function pickHigherImpact(a: EconomicEvent['impact'], b: EconomicEvent['impact']) {
  return IMPACT_RANK[a] >= IMPACT_RANK[b] ? a : b
}
