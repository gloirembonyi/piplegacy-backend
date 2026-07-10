/**
 * Decision orchestrator - final step of the multi-agent pipeline.
 *
 * Philosophy: this desk's PnL comes from PULLING THE TRIGGER. The model is
 * encouraged to call BUY/SELL whenever ANY meaningful confluence shows up,
 * and to fall back to the rule-engine bias when it can't make up its mind.
 * HOLD is the exception (news blackout, conflicting strong signals, or
 * truly no edge), not the default.
 *
 * SL/TP are anchored to ATR on the user's working timeframe. Scalp setups
 * (5m / 15m) default to 1:1 R:R with tight stops; swing setups (1h+) target
 * 2:1 R:R.
 */

import type { LiveGrounding } from '@/lib/agent/live-grounding'
import {
  callSpecialistModel,
  clamp,
  parseJsonish,
} from '@/lib/agent/specialists/helpers'
import type {
  SpecialistReport,
  TradingSetup,
} from '@/lib/agent/pipeline-types'

const WEIGHTS: Record<SpecialistReport['id'], number> = {
  technical: 0.18,
  momentum: 0.20,
  regime: 0.12,
  smc: 0.18,
  mtf: 0.14,
  pattern: 0.08,
  events: 0.06,
  sentiment: 0.04,
}

const SYSTEM = `You are the head of trading at a quant desk. You make money by TAKING TRADES when the edge is there. Combine your specialists' verdicts and the live market context into ONE strict JSON object:
{"bias":"BUY|SELL|HOLD","entry":number|null,"stopLoss":number|null,"takeProfit":number|null,"reasoning":"<=320 chars why this setup makes sense","blockers":["short reason if you HOLD"]}

Decision priority:
1. **Events VETO** - if the events specialist returned AVOID (news blackout), return HOLD. No exceptions.
2. **Momentum bias** - if the momentum specialist is BULLISH or BEARISH with conf ≥ 55, take that side unless TWO other specialists strongly disagree (conf ≥ 60 each, opposite direction).
3. **Default to the majority** - if 2+ specialists lean the same direction, take that side.
4. **HOLD is rare** - only when momentum is NEUTRAL AND no other specialist has conf ≥ 55.

Levels (use the live price + ATR provided):
- Default entry = current price (market order).
- For SCALP timeframes (5m, 15m): stop ≈ 0.6×ATR, target ≈ 0.6–1.2×ATR (R:R 1:1 to 2:1 is fine - small moves, big size).
- For SWING timeframes (30m, 1h, 4h): stop ≈ 1.0×ATR, target ≈ 2.0–2.5×ATR.
- For DAILY: stop ≈ 1.2×ATR, target ≈ 2.5–3.0×ATR.

entry/stopLoss/takeProfit MUST be present and finite when bias is BUY or SELL.
Reasoning should sound like a confident trader, naming the specialists that aligned.`

/** Chat synthesis: the user is asking a question, not asking us to place a
 * trade for them. WAIT/HOLD is a normal, common, fully valid answer - do not
 * force a direction to make the reply feel more decisive than the evidence
 * actually supports. */
const SYSTEM_CHAT = `You are a senior trading analyst answering a trader's question. Combine your specialists' verdicts and the live market context into ONE strict JSON object:
{"bias":"BUY|SELL|HOLD","entry":number|null,"stopLoss":number|null,"takeProfit":number|null,"reasoning":"<=320 chars why this read makes sense","blockers":["short reason if you HOLD"]}

Decision priority:
1. **Events VETO** - if the events specialist returned AVOID (news blackout), return HOLD. No exceptions.
2. **Only call BUY/SELL when the evidence genuinely supports it** - momentum + structure (SMC) + regime should agree, or at least not contradict each other. A single specialist leaning one way is NOT enough.
3. **HOLD/WAIT is a normal, common outcome** - it is not a failure state. If specialists disagree, if the move already looks extended, or if there's no clean structure, say so honestly instead of picking a side.
4. Never force a trade just to give the user a more "complete-looking" answer.

Levels (only when bias is BUY or SELL, use the live price + ATR provided):
- Default entry = current price (market order).
- For SCALP timeframes (5m, 15m): stop ≈ 0.6×ATR, target ≈ 0.6–1.2×ATR.
- For SWING timeframes (30m, 1h, 4h): stop ≈ 1.0×ATR, target ≈ 2.0–2.5×ATR.
- For DAILY: stop ≈ 1.2×ATR, target ≈ 2.5–3.0×ATR.

entry/stopLoss/takeProfit MUST be present and finite when bias is BUY or SELL; all null when bias is HOLD.
Reasoning should read like an honest analyst, naming the specialists that aligned - or naming why you're not confident enough to call a direction.`

/** Weighted confluence score 0-100 from the specialist reports.
 *
 * IMPORTANT: `degraded` reports are NOT skipped - when the AI provider is rate
 * limited (e.g. "All AI providers exhausted for specialist call"), specialists
 * still produce a rule-based verdict with real confidence. Ignoring them would
 * mean the bot can't trade whenever the LLM quota runs out, which is exactly
 * when you want it to keep working. Only fully-failed reports (confidence < 25)
 * are dropped.
 */
export function computeConfluenceScore(reports: SpecialistReport[]): {
  score: number
  bias: 'BUY' | 'SELL' | 'HOLD'
  avoid: boolean
  bull: number
  bear: number
  ruleBasedOnly: boolean
} {
  let bull = 0
  let bear = 0
  let weightSum = 0
  let avoid = false
  let degradedCount = 0
  let counted = 0

  for (const r of reports) {
    const w = WEIGHTS[r.id] ?? 0
    // Drop only fully-failed reports (confidence < 25). Degraded rule-based
    // verdicts at 60% are MORE reliable than nothing.
    if (r.confidence < 25) continue
    if (r.degraded) degradedCount += 1
    if (r.verdict === 'AVOID' && r.id === 'events') avoid = true
    const conf = r.confidence / 100
    if (r.verdict === 'BULLISH') bull += w * conf
    else if (r.verdict === 'BEARISH') bear += w * conf
    weightSum += w
    counted += 1
  }

  const ruleBasedOnly = counted > 0 && degradedCount === counted

  if (weightSum === 0) {
    return { score: 0, bias: 'HOLD', avoid, bull: 0, bear: 0, ruleBasedOnly }
  }

  const dominant = Math.max(bull, bear)
  const score = Math.round((dominant / weightSum) * 100)
  let bias: 'BUY' | 'SELL' | 'HOLD' = 'HOLD'
  // Aggressive trigger: even a thin edge (8%) counts when one side has any
  // weight at all. The risk-guard still gates on confluenceThreshold.
  const margin = Math.abs(bull - bear) / weightSum
  if (margin >= 0.08) {
    bias = bull > bear ? 'BUY' : 'SELL'
  }
  if (avoid) bias = 'HOLD'

  return { score, bias, avoid, bull, bear, ruleBasedOnly }
}

export type OrchestratorInput = {
  symbol: string
  symbolLabel: string
  timeframe: string
  grounding: LiveGrounding
  reports: SpecialistReport[]
  /** Hard ceiling on risk per trade in % of equity (UI knob, default 1%). */
  riskBudgetPct: number
  /** 'bot' (default) keeps the auto-trade desk's aggressive trigger
   *  philosophy; 'chat' answers a question honestly and treats WAIT/HOLD
   *  as a normal outcome instead of forcing a direction. */
  mode?: 'bot' | 'chat'
}

/** Returns ATR multipliers for stop and target, based on the trade timeframe. */
function levelMultipliers(timeframe: string): { stop: number; target: number } {
  const tf = timeframe.toLowerCase()
  if (tf === '5m') return { stop: 0.6, target: 0.8 } // 1:1.3 R:R scalp
  if (tf === '15m') return { stop: 0.8, target: 1.2 } // 1:1.5 R:R
  if (tf === '30m') return { stop: 1.0, target: 1.8 }
  if (tf === '1h') return { stop: 1.0, target: 2.0 } // 1:2 R:R
  if (tf === '4h') return { stop: 1.2, target: 2.4 }
  return { stop: 1.2, target: 2.8 } // 1d default
}

/**
 * Pull a price anchor from the most recent specialist (momentum > technical
 * > grounding). Momentum runs on the user's timeframe so its `lastClose` is
 * the most relevant price.
 */
function extractAnchor(reports: SpecialistReport[], grounding: LiveGrounding): {
  price: number | null
  atr: number | null
} {
  const mom = reports.find((r) => r.id === 'momentum')?.data as
    | { lastClose?: number; ind?: { range20High?: number | null; range20Low?: number | null } }
    | undefined
  const tech = reports.find((r) => r.id === 'technical')?.data as
    | { summary?: { last?: { c: number }; atr14?: number | null } }
    | undefined

  const price =
    mom?.lastClose ?? tech?.summary?.last?.c ?? grounding.quote?.price ?? null
  let atr = tech?.summary?.atr14 ?? null

  // If the technical agent ran on a different TF than momentum, the ATR may
  // be off-scale. Derive a quick ATR estimate from the momentum agent's 20-bar
  // range if we have it.
  if ((atr == null || atr <= 0) && mom?.ind?.range20High != null && mom?.ind?.range20Low != null) {
    const r = mom.ind.range20High - mom.ind.range20Low
    if (r > 0) atr = r / 20
  }
  return { price, atr }
}

export async function runDecisionOrchestrator(
  input: OrchestratorInput
): Promise<TradingSetup> {
  const { symbol, symbolLabel, timeframe, grounding, reports, riskBudgetPct, mode = 'bot' } = input
  const isChat = mode === 'chat'
  const {
    score,
    bias: ruleBias,
    avoid,
    bull,
    bear,
    ruleBasedOnly,
  } = computeConfluenceScore(reports)
  const allBlockers = reports.flatMap((r) => r.blockers ?? [])

  const { price: anchorPrice, atr } = extractAnchor(reports, grounding)
  const mult = levelMultipliers(timeframe)

  // ── Strong individual signals - surface them to the prompt ───────────
  const momentum = reports.find((r) => r.id === 'momentum')
  const smcRep = reports.find((r) => r.id === 'smc')
  const regimeRep = reports.find((r) => r.id === 'regime')
  const regimeState = (regimeRep?.data as { state?: string } | undefined)?.state

  const strongMomentum =
    momentum && momentum.confidence >= 55 && momentum.verdict !== 'NEUTRAL'
      ? momentum.verdict
      : null
  const strongSmc =
    smcRep && smcRep.confidence >= 60 && smcRep.verdict !== 'NEUTRAL'
      ? smcRep.verdict
      : null

  const reportLines = reports
    .map(
      (r) =>
        `- ${r.id.padEnd(10)} ${r.situation ?? r.headline}${r.degraded ? ' (degraded)' : ''} · conf=${r.confidence}% · ${r.verdict}`
    )
    .join('\n')

  const userPrompt = `Symbol: ${symbolLabel} (${symbol})  Timeframe: ${timeframe}
Live price: ${anchorPrice ?? 'unknown'}  ATR estimate: ${atr ?? 'unknown'}
Suggested stop=${mult.stop}×ATR target=${mult.target}×ATR (R:R ${(mult.target / mult.stop).toFixed(2)}:1)
Active sessions: ${grounding.activeSessions.join(', ') || 'none'}  Liquidity: ${grounding.liquidity}
News blackout: ${grounding.newsBlackout ? `YES - ${grounding.newsBlackoutReason ?? ''}` : 'no'}
Rule confluence: score=${score}/100  rule-bias=${ruleBias}  bull=${bull.toFixed(2)} bear=${bear.toFixed(2)}${avoid ? '  events VETO' : ''}
Momentum signal: ${strongMomentum ?? '(weak)'}
SMC signal: ${strongSmc ?? '(none)'}
Regime: ${regimeState ?? 'unknown'}

Specialist reports:
${reportLines}

Return ONLY the strict JSON object the system prompt specified. ${
    isChat
      ? 'Default to HOLD when in doubt - do not force BUY/SELL for a thin or contradictory edge.'
      : `Default bias = ${ruleBias} when in doubt.`
  }`

  // Only call the model if at least one specialist actually has a non-degraded
  // verdict. If every specialist already fell back to rule-based (which means
  // the AI providers are exhausted), going to the LLM again will just timeout
  // and waste 9s - go straight to the rule-engine synthesis.
  const shouldCallModel = !ruleBasedOnly

  const r = shouldCallModel
    ? await callSpecialistModel({
        systemPrompt: isChat ? SYSTEM_CHAT : SYSTEM,
        userPrompt,
        maxTokens: 768,
        temperature: 0.2,
      })
    : ({ ok: false as const, error: 'rule-based-only mode' })

  type ParsedDecision = {
    bias?: string
    entry?: number | null
    stopLoss?: number | null
    takeProfit?: number | null
    reasoning?: string
    blockers?: string[]
  }
  const parsed = r.ok ? parseJsonish<ParsedDecision>(r.text, {}) : ({} as ParsedDecision)

  let bias: 'BUY' | 'SELL' | 'HOLD' = 'HOLD'
  const rawBias = String(parsed.bias ?? '').toUpperCase()
  if (rawBias === 'BUY' || rawBias === 'SELL' || rawBias === 'HOLD') bias = rawBias

  // ── Override chain (most → least aggressive) ─────────────────────────
  // 1. Events veto always wins.
  if (avoid) bias = 'HOLD'

  // 2. SMC liquidity sweep / BOS - enter at move START, not after extension.
  // Bot only: chat mode does not force a direction off a single specialist.
  if (!isChat && bias === 'HOLD' && !avoid && strongSmc) {
    bias = strongSmc === 'BULLISH' ? 'BUY' : 'SELL'
  }

  // 3. Momentum confirms direction when model is unsure. Bot only.
  if (
    !isChat &&
    bias === 'HOLD' &&
    !avoid &&
    strongMomentum
  ) {
    bias = strongMomentum === 'BULLISH' ? 'BUY' : 'SELL'
  }

  // 4. Rule confluence edge. Chat requires a much stronger edge before
  // overriding an honest HOLD - the auto-trade desk accepts a thin edge,
  // chat should not fabricate conviction that isn't there.
  const ruleMinScore = isChat ? 55 : ruleBasedOnly ? 15 : 25
  if (bias === 'HOLD' && !avoid && ruleBias !== 'HOLD' && score >= ruleMinScore) {
    bias = ruleBias
  }

  // 5. Majority vote - 3+ specialists agree. Bot only.
  if (!isChat && bias === 'HOLD' && !avoid) {
    const bullCount = reports.filter(
      (rep) => rep.verdict === 'BULLISH' && rep.confidence >= 45
    ).length
    const bearCount = reports.filter(
      (rep) => rep.verdict === 'BEARISH' && rep.confidence >= 45
    ).length
    if (bullCount >= 3 && bullCount > bearCount) bias = 'BUY'
    else if (bearCount >= 3 && bearCount > bullCount) bias = 'SELL'
  }

  // 6. Regime guard - don't chase extended moves (user: enter at start, not end).
  if (!avoid && bias !== 'HOLD') {
    if (regimeState === 'extension_up' && bias === 'BUY') {
      bias = 'HOLD'
    } else if (regimeState === 'extension_down' && bias === 'SELL') {
      bias = 'HOLD'
    }
  }

  let entry = bias !== 'HOLD' ? toFiniteOrNull(parsed.entry) ?? anchorPrice : null
  let stop = bias !== 'HOLD' ? toFiniteOrNull(parsed.stopLoss) : null
  let tp = bias !== 'HOLD' ? toFiniteOrNull(parsed.takeProfit) : null

  // Auto-synthesise levels if model omitted them.
  if (bias !== 'HOLD' && entry != null && atr != null && atr > 0) {
    const stopDist = atr * mult.stop
    const targetDist = atr * mult.target
    if (stop == null) {
      stop = bias === 'BUY' ? entry - stopDist : entry + stopDist
    }
    if (tp == null) {
      tp = bias === 'BUY' ? entry + targetDist : entry - targetDist
    }
  } else if (bias !== 'HOLD' && entry != null && stop == null) {
    // No ATR - fall back to % move scaled to timeframe.
    const pct = timeframe === '5m' ? 0.0015 : timeframe === '15m' ? 0.0025 : 0.004
    const targetMult = mult.target / mult.stop
    const stopDist = entry * pct
    const targetDist = stopDist * targetMult
    stop = bias === 'BUY' ? entry - stopDist : entry + stopDist
    if (tp == null) {
      tp = bias === 'BUY' ? entry + targetDist : entry - targetDist
    }
  }

  // Validate stop is on the right side of entry - if not, flip it.
  if (bias === 'BUY' && entry != null && stop != null && stop >= entry) {
    const dist = (atr ?? entry * 0.005) * mult.stop
    stop = entry - dist
    if (tp != null && tp <= entry) tp = entry + dist * (mult.target / mult.stop)
  }
  if (bias === 'SELL' && entry != null && stop != null && stop <= entry) {
    const dist = (atr ?? entry * 0.005) * mult.stop
    stop = entry + dist
    if (tp != null && tp >= entry) tp = entry - dist * (mult.target / mult.stop)
  }

  let rr: number | null = null
  if (entry != null && stop != null && tp != null && entry !== stop) {
    rr = Math.abs(tp - entry) / Math.abs(entry - stop)
  }

  // Combine blockers from specialists + model output.
  const blockers = Array.from(
    new Set(
      [...allBlockers, ...(parsed.blockers ?? [])]
        .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
        .map((b) => b.trim())
    )
  ).slice(0, 6)

  // Build a rule-based reasoning sentence so we never show a blank/placeholder
  // explanation - especially important when the LLM call failed.
  const rules: string[] = []
  for (const rep of reports) {
    if (rep.confidence >= 50 && rep.verdict !== 'NEUTRAL' && rep.verdict !== 'AVOID') {
      rules.push(`${rep.id}=${rep.verdict.toLowerCase()} (${rep.confidence}%)`)
    }
  }
  const ruleSentence = rules.length
    ? `${bias} on ${timeframe}: ${rules.slice(0, 4).join(' · ')}.`
    : `${bias} on ${timeframe}.`

  const reasoning =
    parsed.reasoning?.trim() ||
    (avoid
      ? 'Events specialist flagged a news blackout - standing aside until the window passes.'
      : bias === 'HOLD'
        ? 'No specialist showed enough conviction - waiting for a cleaner edge.'
        : ruleBasedOnly
          ? `${ruleSentence} (Model exhausted - rule-based synthesis.)`
          : ruleSentence)

  return {
    symbol,
    symbolLabel,
    timeframe,
    bias,
    confluenceScore: clamp(score, 0, 100),
    entry,
    stopLoss: stop,
    takeProfit: tp,
    riskRewardRatio: rr,
    suggestedRiskPct: clamp(riskBudgetPct, 0.1, 5),
    atr,
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    reasoning,
    blockers,
  }
}

function toFiniteOrNull(n: unknown): number | null {
  const v = Number(n)
  return Number.isFinite(v) ? v : null
}
