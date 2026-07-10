import { formatMarketChatReplySync } from '@/lib/agent/format-reply-agent'
import { sanitizePublicReply } from '@/lib/agent/orchestrator/defense'
import { formatSetupReplyMarkdown, syncSetupFromLevels } from '@/lib/setup-reply-format'
import { normalizeAndValidateSetup } from '@/lib/setup-risk-reward'
import { stripLeakedMarketJson, unescapeReplyText } from '@/lib/reply-text-cleanup'
import type { AgentArtifact } from '@/lib/agent/artifacts'
import { roundMarketPrice } from '@/lib/format-market-price'

/**
 * How the entry should trigger.
 * - `market`: enter now at current price (price already at the level + confirmed).
 * - `limit`:  WAIT for price to PULL BACK to a better level (favorable retest).
 * - `stop`:   WAIT for price to BREAK OUT through a level (momentum confirmation).
 */
export type MarketEntryType = 'market' | 'limit' | 'stop'

export type MarketChatSetup = {
  bias: 'BUY' | 'SELL' | 'HOLD' | 'WAIT'
  /** Defaults to 'market' when omitted. */
  entryType: MarketEntryType
  entry: number | null
  /**
   * Trigger band for pending entries (limit / stop). When set, the chart
   * renders a yellow "wait here" zone - price must enter this band before the
   * trade activates.
   */
  triggerZone: { top: number; bottom: number } | null
  /**
   * Human description of what must happen before the trade activates.
   * E.g. "Wait for 4H bullish engulfing in 410–412 demand zone".
   */
  triggerCondition: string
  /**
   * How long the setup is valid. Past this window, cancel.
   * E.g. "Until London close", "Next 24h", "Until next FOMC".
   */
  validUntil: string
  /**
   * Hard invalidation price - DIFFERENT from stop. If price closes through
   * this level, the THESIS is wrong and the setup is cancelled entirely
   * (don't even attempt the entry). Stop loss only fires after entry.
   */
  invalidation: number | null
  stopLoss: number | null
  takeProfit: number | null
  confidence: number
  timeframe: string
  confirmation: string
  risks: string[]
}

/** Price band the agent wants rendered on the chart (FVG / OB / supply / demand). */
export type MarketChatZone = {
  top: number
  bottom: number
  kind: 'fvg' | 'orderBlock' | 'supply' | 'demand' | 'range' | 'liquidity'
  label?: string
}

/** Labeled level - either a bare number (legacy) or { price, label?, kind? } object. */
export type MarketChatLevel = {
  price: number
  label?: string
  kind?: 'support' | 'resistance' | 'pivot' | 'entry' | 'target' | 'liquidity'
}

export type MarketChatResponse = {
  reply: string
  setup: MarketChatSetup | null
  /** Price levels - accepts legacy bare numbers + new labeled objects. */
  levels: MarketChatLevel[]
  /** Optional FVG / OB / supply / demand boxes. */
  zones: MarketChatZone[]
  /**
   * Whether the agent wants drawings rendered on the chart for THIS reply.
   * - true  → render setup + levels + zones (chart-mode only)
   * - false → skip drawings even if setup/levels present (analytical reply)
   * - null  → infer from setup.bias and levels (default behavior)
   */
  drawIntent: boolean | null
  /** When agent_ask_user was invoked - surface in UI for follow-up. */
  clarifyingQuestion?: string | null
  clarifyingOptions?: string[]
  /** Rich capability outputs (charts, scans, clarifications, visuals). */
  artifacts?: AgentArtifact[]
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return roundMarketPrice(v)
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, ''))
    if (Number.isFinite(n) && n > 0) return roundMarketPrice(n)
  }
  return null
}

function coerceEntryType(v: unknown): MarketEntryType {
  if (v === 'limit' || v === 'stop' || v === 'market') return v
  return 'market'
}

function coerceTriggerZone(
  v: unknown
): { top: number; bottom: number } | null {
  if (!v || typeof v !== 'object') return null
  const obj = v as Record<string, unknown>
  const top = num(obj.top)
  const bottom = num(obj.bottom)
  if (top == null || bottom == null) return null
  const hi = Math.max(top, bottom)
  const lo = Math.min(top, bottom)
  if (hi === lo) return null
  return { top: roundMarketPrice(hi), bottom: roundMarketPrice(lo) }
}

function coerceSetup(raw: unknown): MarketChatSetup | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const bias = s.bias
  if (bias !== 'BUY' && bias !== 'SELL' && bias !== 'HOLD' && bias !== 'WAIT') {
    return null
  }
  const entryType = coerceEntryType(s.entryType)
  // Trigger zone only makes sense for pending entries.
  const triggerZone =
    entryType === 'market' ? null : coerceTriggerZone(s.triggerZone)
  return {
    bias,
    entryType,
    entry: num(s.entry),
    triggerZone,
    triggerCondition:
      typeof s.triggerCondition === 'string'
        ? s.triggerCondition.trim().slice(0, 240)
        : '',
    validUntil:
      typeof s.validUntil === 'string' ? s.validUntil.trim().slice(0, 80) : '',
    invalidation: num(s.invalidation),
    stopLoss: num(s.stopLoss),
    takeProfit: num(s.takeProfit),
    confidence: Math.min(100, Math.max(0, Number(s.confidence) || 0)),
    timeframe: typeof s.timeframe === 'string' ? s.timeframe : '',
    confirmation: typeof s.confirmation === 'string' ? s.confirmation : '',
    risks: Array.isArray(s.risks)
      ? s.risks.filter((r): r is string => typeof r === 'string').slice(0, 4)
      : [],
  }
}

const LEVEL_KINDS = new Set([
  'support',
  'resistance',
  'pivot',
  'entry',
  'target',
  'liquidity',
])
const ZONE_KINDS = new Set([
  'fvg',
  'orderBlock',
  'supply',
  'demand',
  'range',
  'liquidity',
])

function coerceLevels(raw: unknown): MarketChatLevel[] {
  if (!Array.isArray(raw)) return []
  const out: MarketChatLevel[] = []
  for (const item of raw.slice(0, 8)) {
    if (typeof item === 'number' || typeof item === 'string') {
      const p = num(item)
      if (p != null) out.push({ price: p })
      continue
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const p = num(obj.price)
      if (p == null) continue
      const lvl: MarketChatLevel = { price: p }
      if (typeof obj.label === 'string' && obj.label.trim()) {
        lvl.label = obj.label.trim().slice(0, 40)
      }
      const kind = typeof obj.kind === 'string' ? obj.kind : ''
      if (LEVEL_KINDS.has(kind)) {
        lvl.kind = kind as MarketChatLevel['kind']
      }
      out.push(lvl)
    }
  }
  return out
}

function coerceZones(raw: unknown): MarketChatZone[] {
  if (!Array.isArray(raw)) return []
  const out: MarketChatZone[] = []
  for (const item of raw.slice(0, 6)) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const top = num(obj.top)
    const bottom = num(obj.bottom)
    if (top == null || bottom == null) continue
    const hi = Math.max(top, bottom)
    const lo = Math.min(top, bottom)
    if (hi === lo) continue
    const kind = typeof obj.kind === 'string' ? obj.kind : ''
    if (!ZONE_KINDS.has(kind)) continue
    const zone: MarketChatZone = {
      top: hi,
      bottom: lo,
      kind: kind as MarketChatZone['kind'],
    }
    if (typeof obj.label === 'string' && obj.label.trim()) {
      zone.label = obj.label.trim().slice(0, 40)
    }
    out.push(zone)
  }
  return out
}

function coerceDrawIntent(v: unknown): boolean | null {
  if (v === true || v === false) return v
  return null
}

/** Strip markdown code fences and a leading `json` label some models emit. */
function stripJsonFences(text: string): string {
  let t = text.trim()
  if (/^```(?:json)?\s*/i.test(t)) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  }
  if (/^json\s*\{/i.test(t)) {
    t = t.replace(/^json\s*/i, '').trim()
  }
  return t
}

function repairTruncatedJson(raw: string): string {
  let json = stripJsonFences(raw)
  const start = json.indexOf('{')
  if (start >= 0) json = json.slice(start)
  json = json.replace(/,\s*([}\]])/g, '$1')
  json = json.replace(/,\s*$/, '')

  const openBraces = (json.match(/\{/g) || []).length
  const closeBraces = (json.match(/\}/g) || []).length
  const openBrackets = (json.match(/\[/g) || []).length
  const closeBrackets = (json.match(/\]/g) || []).length

  for (let i = 0; i < openBrackets - closeBrackets; i++) json += ']'
  for (let i = 0; i < openBraces - closeBraces; i++) json += '}'

  return json
}

const GENERIC_EMPTY_REPLY =
  'I could not generate a response. Please try again.'

function isGenericEmptyReply(reply: string): boolean {
  const t = reply.trim()
  if (!t) return true
  return (
    t === GENERIC_EMPTY_REPLY ||
    t === 'I could not parse the response. Please try again.' ||
    t === 'Empty response.'
  )
}

function hasActionableLevels(
  setup: MarketChatSetup | null,
  levels: MarketChatLevel[]
): boolean {
  if (levels.length > 0) return true
  if (!setup) return false
  return (
    setup.entry != null ||
    setup.stopLoss != null ||
    setup.takeProfit != null
  )
}

/** Build user-facing prose when the model returned setup JSON but left reply blank. */
export function synthesizeReplyFromSetup(
  setup: MarketChatSetup,
  levels: MarketChatLevel[] = [],
  symbolLabel?: string,
  opts?: {
    userMessage?: string
    symbol?: string
    priceLine?: string
    smartMoneySection?: string
    contextBullets?: string[]
    activeSetupNote?: string
    proseLevelsOnlyInCard?: boolean
  }
): string {
  return formatSetupReplyMarkdown(setup, levels, {
    symbolLabel,
    symbol: opts?.symbol,
    userMessage: opts?.userMessage,
    priceLine: opts?.priceLine,
    smartMoneySection: opts?.smartMoneySection,
    contextBullets: opts?.contextBullets,
    activeSetupNote: opts?.activeSetupNote,
    proseLevelsOnlyInCard: opts?.proseLevelsOnlyInCard,
  })
}

/** Repair responses where structured setup/levels exist but reply is missing or generic. */
export function repairEmptyMarketChatReply(
  response: MarketChatResponse,
  symbolLabel?: string,
  userMessage?: string
): MarketChatResponse {
  if (!isGenericEmptyReply(response.reply) && response.reply.trim()) {
    return response
  }
  const setup = response.setup
  if (!hasActionableLevels(setup, response.levels)) {
    return response
  }
  const effectiveSetup = syncSetupFromLevels(
    setup ??
      ({
        bias: 'WAIT',
        entryType: 'limit',
        entry: response.levels.find((l) => l.kind === 'entry')?.price ?? null,
        stopLoss:
          response.levels.find((l) => l.label?.toLowerCase().includes('stop'))?.price ?? null,
        takeProfit: response.levels.find((l) => l.kind === 'target')?.price ?? null,
        triggerZone: null,
        triggerCondition: '',
        validUntil: 'Next 24h',
        invalidation: null,
        confidence: 0,
        timeframe: '15m',
        confirmation: '',
        risks: [],
      } satisfies MarketChatSetup),
    response.levels
  )!

  return {
    ...response,
    reply: synthesizeReplyFromSetup(effectiveSetup, response.levels, symbolLabel, {
      userMessage,
      symbol: symbolLabel,
    }),
    drawIntent: response.drawIntent ?? true,
  }
}

function extractReplyFieldFallback(text: string): string | null {
  const m = /"reply"\s*:\s*"((?:\\.|[^"\\])*)"/s.exec(text)
  if (!m) return null
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t')
  }
}

function finalizeParsedResponse(r: MarketChatResponse): MarketChatResponse {
  const stripped = stripLeakedMarketJson(r.reply)
  const sanitized = sanitizePublicReply(stripped)
  const base = sanitized !== r.reply ? { ...r, reply: sanitized } : { ...r, reply: stripped }
  const repaired = repairEmptyMarketChatReply(base)
  return formatMarketChatReplySync(repaired, {
    setup: repaired.setup,
    hasSetupCard: Boolean(repaired.setup),
  })
}

function hasSetupFields(parsed: Record<string, unknown>): boolean {
  if (parsed.setup && typeof parsed.setup === 'object') return true
  const bias = parsed.bias
  return bias === 'BUY' || bias === 'SELL' || bias === 'HOLD' || bias === 'WAIT'
}

function isBareSetupRecord(parsed: Record<string, unknown>): boolean {
  if (typeof parsed.reply === 'string') return false
  return hasSetupFields(parsed)
}

function bareSetupToResponse(parsed: Record<string, unknown>): MarketChatResponse {
  const setupSource = parsed.setup ?? parsed
  const confirmation =
    typeof parsed.confirmation === 'string'
      ? parsed.confirmation.trim()
      : typeof (setupSource as Record<string, unknown>).confirmation === 'string'
        ? String((setupSource as Record<string, unknown>).confirmation).trim()
        : ''
  const reply =
    confirmation ||
    (typeof parsed.summary === 'string' ? parsed.summary.trim() : '') ||
    'Trade setup is in the card below - entry, stop, and target are plotted for the chart.'

  return finalizeParsedResponse({
    reply,
    setup: coerceSetup(setupSource),
    levels: coerceLevels(parsed.levels),
    zones: coerceZones(parsed.zones),
    drawIntent: coerceDrawIntent(parsed.drawIntent),
  })
}

function extractEmbeddedSetupFromReply(reply: string): {
  prose: string
  setup: MarketChatSetup | null
  levels: MarketChatLevel[]
  zones: MarketChatZone[]
  drawIntent: boolean | null
} | null {
  const jsonMatch = reply.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    const embedded = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    if (!hasSetupFields(embedded)) return null
    const setup = coerceSetup(embedded.setup ?? embedded)
    if (!setup) return null
    return {
      prose: stripLeakedMarketJson(reply),
      setup,
      levels: coerceLevels(embedded.levels),
      zones: coerceZones(embedded.zones),
      drawIntent: coerceDrawIntent(embedded.drawIntent),
    }
  } catch {
    return null
  }
}

function recordToResponse(parsed: Record<string, unknown>): MarketChatResponse {
  let reply =
    typeof parsed.reply === 'string' && parsed.reply.trim()
      ? parsed.reply.trim()
      : ''

  reply = unescapeReplyText(reply)

  // Model sometimes nests the full JSON object inside `reply`.
  if (reply.trim().startsWith('{') && reply.includes('"reply"')) {
    const inner = parseMarketChatJson(reply)
    if (inner.reply && !looksLikeRawMarketJson(inner.reply)) {
      return finalizeParsedResponse({
        reply: inner.reply,
        setup: inner.setup ?? coerceSetup(parsed.setup),
        levels: inner.levels.length ? inner.levels : coerceLevels(parsed.levels),
        zones: inner.zones.length ? inner.zones : coerceZones(parsed.zones),
        drawIntent: inner.drawIntent ?? coerceDrawIntent(parsed.drawIntent),
      })
    }
  }

  const topSetup = coerceSetup(parsed.setup)
  if (!topSetup) {
    const embedded = extractEmbeddedSetupFromReply(reply)
    if (embedded) {
      return finalizeParsedResponse({
        reply: embedded.prose || embedded.setup.confirmation || reply,
        setup: embedded.setup,
        levels: embedded.levels.length ? embedded.levels : coerceLevels(parsed.levels),
        zones: embedded.zones.length ? embedded.zones : coerceZones(parsed.zones),
        drawIntent: embedded.drawIntent ?? coerceDrawIntent(parsed.drawIntent),
      })
    }
  }

  return finalizeParsedResponse({
    reply,
    setup: topSetup,
    levels: coerceLevels(parsed.levels),
    zones: coerceZones(parsed.zones),
    drawIntent: coerceDrawIntent(parsed.drawIntent),
  })
}

export function looksLikeRawMarketJson(text: string): boolean {
  const t = stripJsonFences(text.trim())
  if (/^```(?:json)?/i.test(text.trim())) return true
  if (t.startsWith('{') && /"reply"\s*:/.test(t)) return true
  if (t.startsWith('{') && /"(?:bias|setup|levels|zones|drawIntent)"\s*:/.test(t)) return true
  if (t.startsWith('[') && /"(?:kind|top|bottom|price)"\s*:/.test(t)) return true
  return false
}

export function parseMarketChatJson(text: string): MarketChatResponse {
  const trimmed = stripJsonFences(text.trim())
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  const candidates = [
    trimmed,
    jsonMatch ? jsonMatch[0] : trimmed,
    repairTruncatedJson(trimmed),
  ].filter((c, i, arr) => c && arr.indexOf(c) === i)

  for (const jsonStr of candidates) {
    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>
      if (isBareSetupRecord(parsed)) {
        return bareSetupToResponse(parsed)
      }
      return recordToResponse(parsed)
    } catch {
      /* try next candidate */
    }
  }

  const fallbackReply = extractReplyFieldFallback(trimmed)
  if (fallbackReply) {
    return finalizeParsedResponse({
      reply: unescapeReplyText(fallbackReply),
      setup: null,
      levels: [],
      zones: [],
      drawIntent: null,
    })
  }

  if (looksLikeRawMarketJson(trimmed)) {
    return {
      reply: 'I could not parse the response. Please try again.',
      setup: null,
      levels: [],
      zones: [],
      drawIntent: null,
    }
  }

  return finalizeParsedResponse({
    reply: unescapeReplyText(trimmed) || 'I could not parse the response. Please try again.',
    setup: null,
    levels: [],
    zones: [],
    drawIntent: null,
  })
}

export type MarketChatResponseInput = {
  reply?: string | null
  setup?: unknown
  levels?: unknown
  zones?: unknown
  drawIntent?: boolean | null
  clarifyingQuestion?: string | null
  clarifyingOptions?: string[]
  artifacts?: AgentArtifact[]
}

/** Pull labeled levels from markdown tables when the model omitted levels[] in JSON. */
export function extractLevelsFromMarkdownTable(text: string): MarketChatLevel[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: MarketChatLevel[] = []
  const seen = new Set<number>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.includes('|')) continue
    if (i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
      // skip header row; data starts i+2
      for (let j = i + 2; j < lines.length; j++) {
        const row = lines[j].trim()
        if (!row.includes('|')) break
        if (/^\|?\s*:?-{3,}/.test(row)) continue
        const cells = row
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim())
        if (cells.length < 2) continue
        const label = cells[0]?.replace(/`/g, '').trim() || undefined
        const priceRaw = cells[1]?.replace(/,/g, '').replace(/[^\d.-]/g, '')
        const price = priceRaw ? parseFloat(priceRaw) : NaN
        if (!Number.isFinite(price) || price <= 0) continue
        const key = Math.round(price * 100000)
        if (seen.has(key)) continue
        seen.add(key)
        const lvl: MarketChatLevel = { price }
        if (label) lvl.label = label.slice(0, 40)
        const ctx = (cells[2] ?? '').toLowerCase()
        if (ctx.includes('support')) lvl.kind = 'support'
        else if (ctx.includes('resist')) lvl.kind = 'resistance'
        else if (ctx.includes('poc') || ctx.includes('pivot')) lvl.kind = 'pivot'
        else if (ctx.includes('target')) lvl.kind = 'target'
        else if (ctx.includes('entry')) lvl.kind = 'entry'
        out.push(lvl)
      }
      break
    }
  }

  return out.slice(0, 8)
}

function enrichResponse(r: MarketChatResponse): MarketChatResponse {
  let levels = r.levels
  if (!levels.length && r.reply) {
    levels = extractLevelsFromMarkdownTable(r.reply)
  }
  const setup = r.setup
    ? normalizeAndValidateSetup(syncSetupFromLevels(r.setup, levels))
    : r.setup
  let drawIntent = r.drawIntent
  if (drawIntent == null && (levels.length > 0 || r.zones.length > 0)) {
    drawIntent = true
  }
  return formatMarketChatReplySync(
    { ...r, setup, levels, drawIntent, artifacts: r.artifacts, clarifyingQuestion: r.clarifyingQuestion, clarifyingOptions: r.clarifyingOptions },
    { setup, hasSetupCard: Boolean(setup) }
  )
}

/** Merge streamed fields with a JSON blob in `reply` (fixes raw-JSON chat bubbles). */
export function normalizeMarketChatResponse(
  input: MarketChatResponseInput
): MarketChatResponse {
  const replyStr = typeof input.reply === 'string' ? input.reply : ''
  const hasStructured =
    (input.setup && typeof input.setup === 'object') ||
    (Array.isArray(input.levels) && input.levels.length > 0) ||
    (Array.isArray(input.zones) && input.zones.length > 0)

  if (looksLikeRawMarketJson(replyStr) || (!replyStr.trim() && hasStructured)) {
    const blob =
      replyStr.trim() ||
      JSON.stringify({
        reply: '',
        setup: input.setup ?? null,
        levels: input.levels ?? [],
        zones: input.zones ?? [],
        drawIntent: input.drawIntent ?? null,
      })
    const parsed = parseMarketChatJson(blob)
    return mergeCapabilityFields(
      enrichResponse({
        reply: parsed.reply,
        setup: parsed.setup ?? coerceSetup(input.setup),
        levels: parsed.levels.length ? parsed.levels : coerceLevels(input.levels),
        zones: parsed.zones.length ? parsed.zones : coerceZones(input.zones),
        drawIntent:
          parsed.drawIntent ?? coerceDrawIntent(input.drawIntent),
      }),
      input
    )
  }

  const setup = coerceSetup(input.setup)
  const levels = coerceLevels(input.levels)
  const zones = coerceZones(input.zones)
  let reply = replyStr.trim() ? unescapeReplyText(replyStr.trim()) : ''

  if (reply.trim().startsWith('{') && reply.includes('"reply"')) {
    const inner = parseMarketChatJson(reply)
    reply = inner.reply
    return mergeCapabilityFields(
      enrichResponse({
        reply,
        setup: inner.setup ?? setup,
        levels: inner.levels.length ? inner.levels : levels,
        zones: inner.zones.length ? inner.zones : zones,
        drawIntent: inner.drawIntent ?? coerceDrawIntent(input.drawIntent),
      }),
      input
    )
  }

  return mergeCapabilityFields(
    repairEmptyMarketChatReply(
      enrichResponse({
        reply: reply || GENERIC_EMPTY_REPLY,
        setup,
        levels,
        zones,
        drawIntent: coerceDrawIntent(input.drawIntent),
      })
    ),
    input
  )
}

function mergeCapabilityFields(
  r: MarketChatResponse,
  input: MarketChatResponseInput
): MarketChatResponse {
  return {
    ...r,
    artifacts: input.artifacts ?? r.artifacts,
    clarifyingQuestion: input.clarifyingQuestion ?? r.clarifyingQuestion,
    clarifyingOptions: input.clarifyingOptions ?? r.clarifyingOptions,
  }
}

/**
 * Resolve whether the chart should auto-render drawings for this response.
 *
 *   1. If `drawIntent` is explicitly true/false → honor it.
 *   2. Else infer:
 *        - setup.bias is BUY/SELL → draw
 *        - levels.length > 0      → draw (S/R chart)
 *        - zones.length > 0       → draw
 *        - otherwise              → no drawings
 */
export function shouldRenderDrawings(r: MarketChatResponse): boolean {
  if (r.drawIntent === true) return true
  if (r.drawIntent === false) return false
  if (r.setup && (r.setup.bias === 'BUY' || r.setup.bias === 'SELL')) return true
  if (
    r.setup &&
    (r.setup.entry != null ||
      r.setup.stopLoss != null ||
      r.setup.takeProfit != null ||
      r.setup.triggerZone != null)
  ) {
    return true
  }
  if (r.levels.length > 0) return true
  if (r.zones.length > 0) return true
  return false
}

/** Flatten labeled levels to bare numbers for legacy callers. */
export function levelsToNumbers(levels: MarketChatLevel[]): number[] {
  return levels.map((l) => l.price)
}
