import type { EconomicEvent } from '@/lib/economic-calendar'

export type EventTimingStatus = 'upcoming' | 'live' | 'released' | 'past' | 'unknown'

const LIVE_BEFORE_MS = 2 * 60 * 1000
const LIVE_AFTER_MS = 30 * 60 * 1000

export function parseEventTimestamp(event: EconomicEvent): number | null {
  if (event.event_dt) {
    const t = new Date(event.event_dt).getTime()
    if (!Number.isNaN(t)) return t
  }
  if (event.date && event.time && event.time !== '-') {
    const t = new Date(`${event.date}T${event.time}:00`).getTime()
    if (!Number.isNaN(t)) return t
  }
  return null
}

export function formatCountdown(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < 60_000) {
    const s = Math.max(0, Math.floor(abs / 1000))
    return `${s}s`
  }
  if (abs < 3_600_000) {
    const m = Math.floor(abs / 60_000)
    const s = Math.floor((abs % 60_000) / 1000)
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  if (abs < 86_400_000) {
    const h = Math.floor(abs / 3_600_000)
    const m = Math.floor((abs % 3_600_000) / 60_000)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(abs / 86_400_000)
  const h = Math.floor((abs % 86_400_000) / 3_600_000)
  return h > 0 ? `${d}d ${h}h` : `${d}d`
}

export function getEventTiming(
  event: EconomicEvent,
  now: Date = new Date()
): { status: EventTimingStatus; label: string; msUntil: number } {
  const ts = parseEventTimestamp(event)
  if (ts == null) {
    return { status: 'unknown', label: '-', msUntil: 0 }
  }

  const nowMs = now.getTime()
  const msUntil = ts - nowMs
  const hasActual = Boolean(event.actual && event.actual !== '-')

  if (hasActual) {
    return { status: 'released', label: 'Released', msUntil }
  }

  const inLiveWindow =
    msUntil <= LIVE_BEFORE_MS && msUntil >= -LIVE_AFTER_MS && event.impact !== 'holiday'

  if (inLiveWindow) {
    if (msUntil > 0) {
      return { status: 'live', label: formatCountdown(msUntil), msUntil }
    }
    const elapsed = Math.abs(msUntil)
    return {
      status: 'live',
      label: elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s ago` : formatCountdown(elapsed),
      msUntil,
    }
  }

  if (msUntil > 0) {
    return { status: 'upcoming', label: formatCountdown(msUntil), msUntil }
  }

  return { status: 'past', label: '-', msUntil }
}

export function hasLiveCalendarEvents(events: EconomicEvent[], now = new Date()): boolean {
  return events.some((e) => {
    const t = getEventTiming(e, now)
    return t.status === 'live' || (t.status === 'upcoming' && t.msUntil < 5 * 60_000)
  })
}
