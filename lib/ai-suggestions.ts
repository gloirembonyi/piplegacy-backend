import { createHash } from 'crypto'
import { callSpecialistModel } from '@/lib/agent/specialists/helpers'
import { fetchMarketNewsFeed, fetchQuotes, sentimentFromHeadline } from '@/lib/finnhub'
import { displaySymbolLabel } from '@/lib/symbols'
import { getRedis } from '@/lib/redis'
import { buildMarketBrief } from '@/lib/market-brief'

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type AiTradeIdea = {
  symbol: string
  symbolLabel: string
  bias: 'BUY' | 'SELL' | 'WATCH'
  headline: string
  reasoning: string
  /** 1–5 scale, conviction. */
  confidence: number
  /** "intraday" | "swing" | "position" - optional planning hint. */
  horizon?: 'intraday' | 'swing' | 'position'
}

export type AiInsight = {
  topic: string
  takeaway: string
  /** "macro" | "sector" | "flow" | "calendar" */
  category: 'macro' | 'sector' | 'flow' | 'calendar' | 'risk'
}

export type AiRiskNote = {
  level: 'low' | 'medium' | 'high'
  note: string
}

export type AiSuggestions = {
  greeting: string
  tradeIdeas: AiTradeIdea[]
  insights: AiInsight[]
  risk: AiRiskNote | null
  model: string
  generatedAt: string
  /** Echo of the user's watchlist used as context - UI shows it for transparency. */
  context: { watchlist: string[]; tone: string }
  cached: boolean
}

// ───────────────────────────────────────────────────────────────────────────
// Cache (Redis if available, in-memory fallback)
// ───────────────────────────────────────────────────────────────────────────

const TTL_SECONDS = 30 * 60 // 30 minutes
const memCache = new Map<string, { value: AiSuggestions; expiresAt: number }>()

function cacheKey(email: string, watchlist: string[]): string {
  // Bucket by watchlist hash so changing the watchlist forces a regen, but
  // small refresh cycles (a user opening the page repeatedly with the same
  // watchlist) hit the cache.
  const hash = createHash('sha256')
    .update(`${email.toLowerCase()}|${[...watchlist].sort().join(',')}`)
    .digest('hex')
    .slice(0, 16)
  return `ai-suggestions:${hash}`
}

async function readCache(key: string): Promise<AiSuggestions | null> {
  const redis = getRedis()
  if (redis) {
    try {
      const raw = await redis.get(key)
      if (raw) {
        const parsed =
          typeof raw === 'string' ? (JSON.parse(raw) as AiSuggestions) : (raw as AiSuggestions)
        return { ...parsed, cached: true }
      }
    } catch {
      /* fall through to memory */
    }
  }
  const hit = memCache.get(key)
  if (hit && hit.expiresAt > Date.now()) {
    return { ...hit.value, cached: true }
  }
  return null
}

async function writeCache(key: string, value: AiSuggestions): Promise<void> {
  const redis = getRedis()
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(value), { ex: TTL_SECONDS })
      return
    } catch {
      /* fall through */
    }
  }
  memCache.set(key, { value, expiresAt: Date.now() + TTL_SECONDS * 1000 })
}

// ───────────────────────────────────────────────────────────────────────────
// Prompt building
// ───────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return [
    'You are PIPLEGACY AI - an experienced multi-asset desk strategist.',
    'Your job: given a trader\'s watchlist and the live market context, output a SHORT, ACTIONABLE briefing as STRICT JSON.',
    '',
    'RULES:',
    '- Be objective and data-driven. Do NOT make up numbers - only reference numbers that were given to you.',
    '- Never recommend leverage or specific position sizes. Frame ideas as "watch", "lean", "above/below this level".',
    '- Each trade idea MUST reference a symbol from the supplied watchlist.',
    '- Confidence is 1 (low) to 5 (high). Use 4–5 only when both price action AND macro context align.',
    '- Insights should be macro / cross-asset color - NOT a repeat of trade ideas.',
    '- Risk note should call out the single most important thing to be careful about.',
    '- Output ONLY valid JSON, no preamble, no markdown fences.',
  ].join('\n')
}

function buildUserPrompt(args: {
  watchlist: { symbol: string; label: string; price: number; changePercent: number }[]
  toneHeadline: string
  toneParagraphs: string[]
  topNews: { title: string; sentiment: string }[]
  nextEvent: string | null
}): string {
  const watchlistBlock = args.watchlist.length
    ? args.watchlist
        .map(
          (w) =>
            `- ${w.label} (${w.symbol}): $${
              w.price >= 1 ? w.price.toFixed(2) : w.price.toFixed(4)
            } (${w.changePercent >= 0 ? '+' : ''}${w.changePercent.toFixed(2)}%)`
        )
        .join('\n')
    : '(empty)'
  const newsBlock = args.topNews.length
    ? args.topNews.map((n) => `- [${n.sentiment}] ${n.title}`).join('\n')
    : '(no fresh headlines)'

  return [
    '=== USER WATCHLIST ===',
    watchlistBlock,
    '',
    '=== MARKET TONE ===',
    args.toneHeadline,
    args.toneParagraphs.join(' '),
    '',
    '=== TOP HEADLINES ===',
    newsBlock,
    '',
    '=== NEXT HIGH-IMPACT EVENT ===',
    args.nextEvent ?? 'No upcoming high-impact event in the next session.',
    '',
    '=== OUTPUT (STRICT JSON ONLY) ===',
    'Return an object with this exact shape (no extra keys):',
    '{',
    '  "greeting": "1 sentence personalised opener mentioning watchlist tone",',
    '  "tradeIdeas": [',
    '    {',
    '      "symbol": "<exact symbol from watchlist>",',
    '      "bias": "BUY" | "SELL" | "WATCH",',
    '      "headline": "<= 60 chars, action-first phrasing",',
    '      "reasoning": "2 short sentences referencing price + macro",',
    '      "confidence": 1-5,',
    '      "horizon": "intraday" | "swing" | "position"',
    '    }',
    '  ],            // 2-3 items, must be from the watchlist',
    '  "insights": [',
    '    {',
    '      "topic": "<= 40 chars, e.g. \'Dollar / risk regime\'",',
    '      "takeaway": "1-2 sentences",',
    '      "category": "macro" | "sector" | "flow" | "calendar" | "risk"',
    '    }',
    '  ],            // exactly 2 items, NOT trade ideas',
    '  "risk": {',
    '    "level": "low" | "medium" | "high",',
    '    "note": "1 short sentence about the biggest risk to the above ideas"',
    '  }',
    '}',
  ].join('\n')
}

// ───────────────────────────────────────────────────────────────────────────
// Validation / coercion
// ───────────────────────────────────────────────────────────────────────────

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' ? Math.round(n) : Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, v))
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function coerceBias(v: unknown): AiTradeIdea['bias'] {
  const s = String(v ?? '').toUpperCase()
  if (s === 'BUY' || s === 'LONG') return 'BUY'
  if (s === 'SELL' || s === 'SHORT') return 'SELL'
  return 'WATCH'
}

function coerceHorizon(v: unknown): AiTradeIdea['horizon'] | undefined {
  const s = String(v ?? '').toLowerCase()
  if (s === 'intraday' || s === 'swing' || s === 'position') return s
  return undefined
}

function coerceInsightCategory(v: unknown): AiInsight['category'] {
  const s = String(v ?? '').toLowerCase()
  if (s === 'macro' || s === 'sector' || s === 'flow' || s === 'calendar' || s === 'risk') {
    return s
  }
  return 'macro'
}

function coerceRiskLevel(v: unknown): AiRiskNote['level'] {
  const s = String(v ?? '').toLowerCase()
  if (s === 'low' || s === 'high') return s
  return 'medium'
}

function parseModelJson(text: string): unknown {
  if (!text) return null
  // Strip any accidental code fence the model might emit despite our prompt.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // Last-ditch: find the first {...} block.
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

export type BuildSuggestionsInput = {
  userEmail: string
  watchlist: string[]
  forceRefresh?: boolean
}

export async function buildAiSuggestions(
  input: BuildSuggestionsInput
): Promise<AiSuggestions> {
  const watchlist = (input.watchlist ?? []).slice(0, 16)
  const key = cacheKey(input.userEmail, watchlist)

  if (!input.forceRefresh) {
    const cached = await readCache(key)
    if (cached) return cached
  }

  // Gather REAL data - we never let the model invent prices.
  const [quotes, brief, news] = await Promise.all([
    watchlist.length
      ? fetchQuotes(watchlist.map((s) => ({ symbol: s }))).catch(() => [])
      : Promise.resolve([]),
    buildMarketBrief().catch(() => null),
    fetchMarketNewsFeed(8).catch(() => []),
  ])

  const watchlistRows = quotes
    .filter((q) => Number.isFinite(q.price) && q.price > 0)
    .map((q) => ({
      symbol: q.symbol,
      label: displaySymbolLabel(q.symbol),
      price: q.price,
      changePercent: q.changePercent,
    }))

  const topNews = news.slice(0, 5).map((n) => ({
    title: n.headline,
    sentiment: sentimentFromHeadline(n.headline),
  }))

  const nextEvent = brief?.nextEvent
    ? `${brief.nextEvent.event} (${brief.nextEvent.currency}) ${brief.nextEvent.opensIn}`
    : null

  const systemPrompt = buildSystemPrompt()
  const userPrompt = buildUserPrompt({
    watchlist: watchlistRows,
    toneHeadline: brief?.headline ?? 'Mixed tone session',
    toneParagraphs: brief?.paragraphs ?? [],
    topNews,
    nextEvent,
  })

  const modelResult = await callSpecialistModel({
    systemPrompt,
    userPrompt,
    maxTokens: 900,
    temperature: 0.2,
    source: 'suggestion',
  })

  if (!modelResult.ok) {
    // Build a deterministic fallback so the panel never goes blank.
    const fallback = buildDeterministicFallback({
      watchlistRows,
      brief,
      reason: modelResult.error,
    })
    // Don't cache failures - we want to retry sooner.
    return fallback
  }

  const parsed = parseModelJson(modelResult.text) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== 'object') {
    return buildDeterministicFallback({
      watchlistRows,
      brief,
      reason: 'Could not parse AI response',
    })
  }

  const watchlistSymbols = new Set(watchlistRows.map((w) => w.symbol.toUpperCase()))

  const rawIdeas = Array.isArray(parsed.tradeIdeas) ? parsed.tradeIdeas : []
  const tradeIdeas: AiTradeIdea[] = rawIdeas
    .slice(0, 3)
    .map((it: unknown) => {
      const item = (it as Record<string, unknown>) ?? {}
      const symRaw = String(item.symbol ?? '').toUpperCase()
      // Only accept symbols actually in the user's watchlist.
      if (!watchlistSymbols.has(symRaw)) return null
      const idea: AiTradeIdea = {
        symbol: symRaw,
        symbolLabel: displaySymbolLabel(symRaw),
        bias: coerceBias(item.bias),
        headline: asString(item.headline, '').slice(0, 100),
        reasoning: asString(item.reasoning, '').slice(0, 400),
        confidence: clampInt(item.confidence, 1, 5, 3),
        horizon: coerceHorizon(item.horizon),
      }
      if (!idea.headline) return null
      return idea
    })
    .filter((x): x is AiTradeIdea => x !== null)

  const rawInsights = Array.isArray(parsed.insights) ? parsed.insights : []
  const insights: AiInsight[] = rawInsights
    .slice(0, 3)
    .map((it: unknown) => {
      const item = (it as Record<string, unknown>) ?? {}
      const topic = asString(item.topic, '').slice(0, 80)
      const takeaway = asString(item.takeaway, '').slice(0, 320)
      if (!topic || !takeaway) return null
      return {
        topic,
        takeaway,
        category: coerceInsightCategory(item.category),
      }
    })
    .filter((x): x is AiInsight => x !== null)

  const rawRisk = (parsed.risk as Record<string, unknown> | undefined) ?? undefined
  const risk: AiRiskNote | null = rawRisk
    ? {
        level: coerceRiskLevel(rawRisk.level),
        note: asString(rawRisk.note, '').slice(0, 240),
      }
    : null

  const result: AiSuggestions = {
    greeting: asString(parsed.greeting, '').slice(0, 200) || 'Here is what your tape is saying right now.',
    tradeIdeas,
    insights,
    risk: risk && risk.note ? risk : null,
    model: modelResult.model,
    generatedAt: new Date().toISOString(),
    context: {
      watchlist: watchlistRows.map((w) => w.symbol),
      tone: brief?.toneLabel ?? 'Mixed',
    },
    cached: false,
  }

  // Only cache when the model gave us at least one usable idea - otherwise we'd
  // keep serving an empty briefing for 30 minutes.
  if (result.tradeIdeas.length > 0 || result.insights.length > 0) {
    await writeCache(key, result)
  }

  return result
}

// ───────────────────────────────────────────────────────────────────────────
// Deterministic fallback (no LLM) - keeps the UI useful when AI is offline
// ───────────────────────────────────────────────────────────────────────────

function buildDeterministicFallback(args: {
  watchlistRows: {
    symbol: string
    label: string
    price: number
    changePercent: number
  }[]
  brief: Awaited<ReturnType<typeof buildMarketBrief>> | null
  reason?: string
}): AiSuggestions {
  void args.reason
  const sorted = [...args.watchlistRows].sort(
    (a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)
  )
  const tradeIdeas: AiTradeIdea[] = sorted.slice(0, 3).map((w) => {
    const up = w.changePercent > 0
    return {
      symbol: w.symbol,
      symbolLabel: w.label,
      bias: Math.abs(w.changePercent) >= 0.5 ? (up ? 'BUY' : 'SELL') : 'WATCH',
      headline: up
        ? `${w.label} pressing higher (+${w.changePercent.toFixed(2)}%)`
        : `${w.label} under pressure (${w.changePercent.toFixed(2)}%)`,
      reasoning: up
        ? `Buyers are in control with a session move of ${w.changePercent.toFixed(2)}%. Watch the next pullback for continuation; manage risk below the breakout pivot.`
        : `Sellers in control with a session move of ${w.changePercent.toFixed(2)}%. Watch any bounce into resistance for continuation short; manage risk above the breakdown pivot.`,
      confidence: Math.min(4, Math.max(2, Math.round(Math.abs(w.changePercent)))),
      horizon: 'intraday' as const,
    }
  })

  const insights: AiInsight[] = []
  if (args.brief?.toneLabel) {
    insights.push({
      topic: 'Risk regime',
      takeaway: args.brief.headline || `Tone is ${args.brief.toneLabel.toLowerCase()} this session.`,
      category: 'macro',
    })
  }
  if (args.brief?.nextEvent) {
    insights.push({
      topic: 'Calendar',
      takeaway: `${args.brief.nextEvent.event} (${args.brief.nextEvent.currency}) is up ${args.brief.nextEvent.opensIn} - expect volatility around the print.`,
      category: 'calendar',
    })
  }
  while (insights.length < 2) {
    insights.push({
      topic: 'Sessions',
      takeaway:
        args.brief?.activeSessions.length
          ? `${args.brief.activeSessions.join(' & ')} session active - adjust expectations to current liquidity.`
          : 'FX sessions overlap drives volatility - plan entries around session opens.',
      category: 'flow',
    })
  }

  return {
    greeting:
      args.watchlistRows.length > 0
        ? 'Here is a personalised read of your watchlist based on live tape.'
        : 'Add a few symbols to your watchlist and we will tailor ideas to you.',
    tradeIdeas,
    insights: insights.slice(0, 2),
    risk: args.brief
      ? {
          level: args.brief.tone === 'risk-off' ? 'high' : args.brief.tone === 'mixed' ? 'medium' : 'low',
          note:
            args.brief.tone === 'risk-off'
              ? 'Wide ranges and headline-driven gaps - keep stops generous and size conservatively.'
              : 'Standard session conditions - size to plan and respect invalidation levels.',
        }
      : null,
    model: 'fallback:deterministic',
    generatedAt: new Date().toISOString(),
    context: {
      watchlist: args.watchlistRows.map((w) => w.symbol),
      tone: args.brief?.toneLabel ?? 'Mixed',
    },
    cached: false,
  }
}
