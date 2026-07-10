/** Forex session hours (UTC) and timeline helpers for market-hours UI. */

export type ForexSessionKey = 'Sydney' | 'Tokyo' | 'London' | 'New York'

export type ForexSessionConfig = {
  key: ForexSessionKey
  name: string
  city: string
  currency: string
  /** Emoji fallback */
  flag: string
  /** ISO 3166-1 alpha-2 for flagcdn.com */
  flagCode: string
  /** IANA timezone for local session clock */
  sessionTimeZone: string
  color: string
  barColor: string
  stripeColor: string
  utcStart: { hour: number; minute: number }
  utcEnd: { hour: number; minute: number }
}

export const FOREX_SESSIONS: ForexSessionConfig[] = [
  {
    key: 'Sydney',
    name: 'Sydney',
    city: 'Sydney',
    currency: 'AUD',
    flag: '🇦🇺',
    flagCode: 'au',
    sessionTimeZone: 'Australia/Sydney',
    color: '#1A3D63',
    barColor: 'rgba(96, 165, 250, 0.55)',
    stripeColor: 'rgba(26, 61, 99, 0.35)',
    utcStart: { hour: 20, minute: 0 },
    utcEnd: { hour: 5, minute: 0 },
  },
  {
    key: 'Tokyo',
    name: 'Tokyo',
    city: 'Tokyo',
    currency: 'JPY',
    flag: '🇯🇵',
    flagCode: 'jp',
    sessionTimeZone: 'Asia/Tokyo',
    color: '#db2777',
    barColor: 'rgba(244, 114, 182, 0.55)',
    stripeColor: 'rgba(190, 24, 93, 0.3)',
    utcStart: { hour: 23, minute: 0 },
    utcEnd: { hour: 8, minute: 0 },
  },
  {
    key: 'London',
    name: 'London',
    city: 'London',
    currency: 'GBP',
    flag: '🇬🇧',
    flagCode: 'gb',
    sessionTimeZone: 'Europe/London',
    color: '#2563eb',
    barColor: 'rgba(96, 165, 250, 0.5)',
    stripeColor: 'rgba(37, 99, 235, 0.32)',
    utcStart: { hour: 8, minute: 0 },
    utcEnd: { hour: 17, minute: 0 },
  },
  {
    key: 'New York',
    name: 'New York',
    city: 'New York',
    currency: 'USD',
    flag: '🇺🇸',
    flagCode: 'us',
    sessionTimeZone: 'America/New_York',
    color: '#059669',
    barColor: 'rgba(74, 222, 128, 0.55)',
    stripeColor: 'rgba(5, 150, 105, 0.32)',
    utcStart: { hour: 13, minute: 0 },
    utcEnd: { hour: 22, minute: 0 },
  },
]

export type TimelineSegment = {
  startPct: number
  widthPct: number
}

export type SessionTimelineRow = ForexSessionConfig & {
  segments: TimelineSegment[]
  localTimeLabel: string
  localDateLabel: string
  cityLocalTime: string
  isOpen: boolean
}

export function formatCityLocalTime(sessionTimeZone: string, date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: sessionTimeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date)
}

function isUtcSessionOpen(
  utcHour: number,
  utcMinute: number,
  start: { hour: number; minute: number },
  end: { hour: number; minute: number }
): boolean {
  const afterStart =
    utcHour > start.hour || (utcHour === start.hour && utcMinute >= start.minute)
  const beforeEnd = utcHour < end.hour || (utcHour === end.hour && utcMinute <= end.minute)
  if (start.hour > end.hour) return afterStart || beforeEnd
  return afterStart && beforeEnd
}

/** Offset in ms: local wall clock minus UTC for `date` in `timeZone`. */
export function getTimezoneOffsetMs(timeZone: string, date = new Date()): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value])
  ) as Record<string, string>
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  )
  return asUtc - date.getTime()
}

function localDayStartUtc(timeZone: string, date = new Date()): Date {
  const offset = getTimezoneOffsetMs(timeZone, date)
  const local = new Date(date.getTime() + offset)
  local.setUTCHours(0, 0, 0, 0)
  return new Date(local.getTime() - offset)
}

export function isForexWeekendClosed(now = new Date()): boolean {
  const day = now.getUTCDay()
  if (day === 6) return true
  if (day === 0 && now.getUTCHours() < 22) return true
  return false
}

/** Build open segments on a 0–100% local-day timeline. */
export function getSessionSegmentsForTimezone(
  session: ForexSessionConfig,
  timeZone: string,
  date = new Date()
): TimelineSegment[] {
  const dayStart = localDayStartUtc(timeZone, date).getTime()
  const step = 15
  const ranges: { start: number; end: number }[] = []
  let current: { start: number; end: number } | null = null

  for (let m = 0; m < 24 * 60; m += step) {
    const instant = new Date(dayStart + m * 60 * 1000)
    const utcH = instant.getUTCHours()
    const utcM = instant.getUTCMinutes()
    const open = isUtcSessionOpen(utcH, utcM, session.utcStart, session.utcEnd)

    if (open) {
      if (!current) current = { start: m, end: m + step }
      else current.end = m + step
    } else if (current) {
      ranges.push(current)
      current = null
    }
  }
  if (current) ranges.push(current)

  return ranges.map((r) => ({
    startPct: (r.start / (24 * 60)) * 100,
    widthPct: ((r.end - r.start) / (24 * 60)) * 100,
  }))
}

export function formatSessionLocalLabels(timeZone: string, date = new Date()) {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date)
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date)
  const offset =
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''

  return { time, day, offset }
}

export function getCurrentTimePercent(timeZone: string, date = new Date()): number {
  const offset = getTimezoneOffsetMs(timeZone, date)
  const local = new Date(date.getTime() + offset)
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes()
  return (mins / (24 * 60)) * 100
}

export function buildSessionTimelines(
  timeZone: string,
  date = new Date()
): SessionTimelineRow[] {
  const labels = formatSessionLocalLabels(timeZone, date)
  const nowUtcH = date.getUTCHours()
  const nowUtcM = date.getUTCMinutes()

  return FOREX_SESSIONS.map((session) => ({
    ...session,
    segments: getSessionSegmentsForTimezone(session, timeZone, date),
    localTimeLabel: labels.time,
    localDateLabel: labels.day,
    cityLocalTime: formatCityLocalTime(session.sessionTimeZone, date),
    isOpen: isUtcSessionOpen(nowUtcH, nowUtcM, session.utcStart, session.utcEnd),
  }))
}

/** Diagonal stripes overlay for BabyPips-style session bars */
export function sessionBarBackground(barColor: string, stripeColor: string): string {
  return `repeating-linear-gradient(
    -52deg,
    ${barColor},
    ${barColor} 5px,
    ${stripeColor} 5px,
    ${stripeColor} 10px
  )`
}

/** Relative volume weight per session (London/NY overlap drives peaks). */
const SESSION_VOLUME_WEIGHT: Record<ForexSessionKey, number> = {
  Sydney: 0.38,
  Tokyo: 0.62,
  London: 1,
  'New York': 0.92,
}

const VOLUME_CURVE_MAX =
  SESSION_VOLUME_WEIGHT.Sydney +
  SESSION_VOLUME_WEIGHT.Tokyo +
  SESSION_VOLUME_WEIGHT.London +
  SESSION_VOLUME_WEIGHT['New York']

function smoothCurve(values: number[], window = 5): number[] {
  const half = Math.floor(window / 2)
  return values.map((_, i) => {
    let sum = 0
    let count = 0
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < values.length) {
        sum += values[j]
        count++
      }
    }
    return sum / count
  })
}

export type VolumeLevel = 'low' | 'medium' | 'high'

export function getVolumeLevel(value: number): VolumeLevel {
  if (value < 0.38) return 'low'
  if (value < 0.68) return 'medium'
  return 'high'
}

/** Classify a point against the shape of this curve (better red/amber/green spread). */
export function getVolumeLevelForCurve(value: number, curve: number[]): VolumeLevel {
  if (!curve.length) return getVolumeLevel(value)
  const sorted = [...curve].sort((a, b) => a - b)
  const p25 = sorted[Math.floor(sorted.length * 0.25)] ?? 0
  const p65 = sorted[Math.floor(sorted.length * 0.65)] ?? 0.5
  if (value <= p25) return 'low'
  if (value <= p65) return 'medium'
  return 'high'
}

/** Session bar segment - flat striped fill, no side accent bars. */
export function sessionSegmentStyle(
  barColor: string,
  stripeColor: string,
  seg: { startPct: number; widthPct: number }
): { left: string; width: string; background: string; borderRadius: string } {
  return {
    left: `${seg.startPct}%`,
    width: `${seg.widthPct}%`,
    background: sessionBarBackground(barColor, stripeColor),
    borderRadius: '4px',
  }
}

export const VOLUME_LEVEL_META: Record<
  VolumeLevel,
  { label: string; color: string; fill: string; dot: string }
> = {
  low: {
    label: 'Low',
    color: '#dc2626',
    fill: 'rgba(220, 38, 38, 0.12)',
    dot: 'bg-red-500',
  },
  medium: {
    label: 'Medium',
    color: '#d97706',
    fill: 'rgba(217, 119, 6, 0.14)',
    dot: 'bg-amber-500',
  },
  high: {
    label: 'High',
    color: '#059669',
    fill: 'rgba(5, 150, 105, 0.16)',
    dot: 'bg-emerald-500',
  },
}

/** Synthetic trading-volume curve (0–1) by local 15-min slots, BabyPips-style overlap weighting. */
export function getLiquidityCurve(timeZone: string, date = new Date()): number[] {
  const points = 96
  const raw: number[] = []
  const dayStart = localDayStartUtc(timeZone, date).getTime()

  for (let i = 0; i < points; i++) {
    const instant = new Date(dayStart + i * 15 * 60 * 1000)
    const utcH = instant.getUTCHours()
    const utcM = instant.getUTCMinutes()
    let volume = 0
    for (const s of FOREX_SESSIONS) {
      if (isUtcSessionOpen(utcH, utcM, s.utcStart, s.utcEnd)) {
        volume += SESSION_VOLUME_WEIGHT[s.key]
      }
    }
    raw.push(Math.min(1, volume / (VOLUME_CURVE_MAX * 0.72)))
  }

  return smoothCurve(raw, 7)
}

/** Volume at the current local time (0–1). */
export function getVolumeAtNow(timeZone: string, date = new Date()): number {
  const curve = getLiquidityCurve(timeZone, date)
  const idx = Math.min(
    curve.length - 1,
    Math.max(0, Math.round((getCurrentTimePercent(timeZone, date) / 100) * (curve.length - 1)))
  )
  return curve[idx] ?? 0
}

export const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
] as const

export function formatTimezoneLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date())
    const offset = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
    const name = tz.replace(/_/g, ' ')
    return offset ? `${name} (${offset})` : name
  } catch {
    return tz.replace(/_/g, ' ')
  }
}

/** Preset list plus the user's zone when it is not in the preset list. */
export function getTimezoneOptions(includeTz?: string): string[] {
  const set = new Set<string>(COMMON_TIMEZONES)
  if (includeTz) set.add(includeTz)
  return Array.from(set).sort((a, b) => a.localeCompare(b))
}
