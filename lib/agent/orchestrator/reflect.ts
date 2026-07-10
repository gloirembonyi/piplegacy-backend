/**
 * Self-reflection - validates draft answers before returning to the user.
 * Rule-based checks first; repair iterations via the main loop when issues found.
 */

import type { LiveGrounding } from '@/lib/agent/live-grounding'
import type { MarketChatResponse } from '@/lib/parse-market-chat-json'
import { detectProviderIdentityLeaks, detectReplyLeaks } from './defense'
import type { AgentPlan, ReflectionResult } from './types'
import { isLiquidityPoolQuestion } from '@/lib/setup-reply-format'
import { isDirectLevelsQuestion } from '@/lib/agent/orchestrator/user-evidence'
import { computeRiskRewardRatio, minRiskRewardForTimeframe } from '@/lib/setup-risk-reward'

/** Aligned with REASONING_LOOP prompt (±5%). */
const PRICE_DRIFT_PCT = 0.05
const LEVELS_REQUEST_RE =
  /\b(where (are|is)|entry|stop|target|tp|sl|levels?)\b/i
const CANDLE_TRIGGER_RE =
  /\b(what candle|candle (should|can|to|do)|wait for|trigger|confirmation|confirm|signal candle|entry candle|which candle|when (to|should i) enter)\b/i
const GOAL_REFUSAL_RE =
  /\b(cannot help|can't help|out of scope|not (able|equipped) to|personal purchase|buy a car for you)\b/i
const MARKET_ONLY_REFUSAL_RE =
  /\b(don'?t have access|do not have access|I only (analyze|focus on)|as a market analysis agent|not equipped to (?:help|answer)|I(?:'m| am) (?:a |here as a )?market|outside my (?:scope|expertise)|I (?:can'?t|cannot) (?:help|answer).{0,30}(?:music|song|artist|sport|movie|general))\b/i
const ROUND_NUMBER_RE = /\.(00|50)\b/

function stopLooksLikeRoundNumberTrap(price: number): boolean {
  const frac = price % 1
  return frac < 0.001 || Math.abs(frac - 0.5) < 0.001 || ROUND_NUMBER_RE.test(price.toFixed(2))
}

function riskRewardRatio(setup: NonNullable<MarketChatResponse['setup']>): number | null {
  return computeRiskRewardRatio(setup.entry, setup.stopLoss, setup.takeProfit)
}

export function reflectOnResponse(
  draft: MarketChatResponse,
  opts: {
    plan: AgentPlan
    grounding: LiveGrounding
    userMessage: string
    mode?: 'chart' | 'insights'
    hadWebEvidence?: boolean
    hadDeepMarketEvidence?: boolean
    /** Specialist pipeline already ran deep-market style analysis. */
    pipelineEvidence?: boolean
    /** Result from analyze_multi_timeframe when called this turn. */
    mtfAnalysis?: { alignment?: string; recommendation?: string }
    /** Result from assess_trade_context when called this turn. */
    tradeContext?: { action?: string; blockers?: string[] }
    /** Pipeline already produced entry/stop/target merged into the draft. */
    pipelineLevelsComplete?: boolean
  }
): ReflectionResult {
  const issues: string[] = []
  const suggestions: string[] = []
  const {
    grounding,
    plan,
    userMessage,
    mode,
    hadWebEvidence,
    hadDeepMarketEvidence,
    pipelineEvidence,
    pipelineLevelsComplete,
    mtfAnalysis,
    tradeContext,
  } = opts
  const deepMarketSatisfied = Boolean(hadDeepMarketEvidence || pipelineEvidence)
  const response = draft
  const quote = grounding.quote?.price

  if (plan.responseMode === 'conversational' || plan.intent === 'conversational') {
    if (!response.reply?.trim()) {
      return { passed: false, issues: ['Empty reply text.'], suggestions: [] }
    }
    const leakIssues = detectReplyLeaks(response.reply)
    if (detectProviderIdentityLeaks(response.reply)) {
      leakIssues.push(
        'Leaked external AI provider identity - reply as Piplegacy only; never Google/Gemini/ChatGPT/Claude/DeepSeek/LLM.'
      )
    }
    if (leakIssues.length > 0) {
      return { passed: false, issues: leakIssues, suggestions: [] }
    }
    return { passed: true, issues: [], suggestions: [] }
  }

  if (plan.intent === 'undercover' || plan.undercoverMode) {
    if (!response.reply?.trim()) {
      return { passed: false, issues: ['Empty reply text.'], suggestions: [] }
    }
    const leakIssues = detectReplyLeaks(response.reply)
    if (detectProviderIdentityLeaks(response.reply)) {
      leakIssues.push(
        'Leaked external AI provider identity - reply as Piplegacy only; never Google/Gemini/ChatGPT/Claude/DeepSeek/LLM.'
      )
    }
    if (response.setup || (response.levels && response.levels.length > 0)) {
      leakIssues.push('Undercover mode - no setup/levels; product explanation only.')
    }
    if (leakIssues.length > 0) {
      return { passed: false, issues: leakIssues, suggestions: [] }
    }
    return { passed: true, issues: [], suggestions: [] }
  }

  const needsLevels =
    plan.taskTags.includes('levels') ||
    plan.intent === 'setup' ||
    plan.intent === 'reversal' ||
    plan.intent === 'goal'

  if (
    needsLevels &&
    LEVELS_REQUEST_RE.test(userMessage) &&
    !response.setup &&
    (!response.levels || response.levels.length === 0)
  ) {
    issues.push('User asked for entry/stop/target but response has no setup or levels.')
  }

  if (plan.taskTags.includes('candle_trigger') || CANDLE_TRIGGER_RE.test(userMessage)) {
    const mentionsCandle =
      /\b(candle|engulf|pin bar|hammer|doji|retest|close above|close below|BOS|FVG|order block|trigger)\b/i.test(
        response.reply
      )
    if (!mentionsCandle) {
      issues.push(
        'User asked what candle to wait for - name the exact pattern, level, and session timing in the reply.'
      )
    }
    if (response.setup?.bias === 'BUY' || response.setup?.bias === 'SELL') {
      if (!response.setup.triggerZone) {
        suggestions.push('Add triggerZone (top/bottom) so the user knows where to watch for the candle.')
      }
    }
  }

  if (plan.intent === 'general' || plan.taskTags.includes('web_research')) {
    if (MARKET_ONLY_REFUSAL_RE.test(response.reply)) {
      issues.push(
        'Refused a general question - call search_internet/search_web and answer from results; never claim market-only scope.'
      )
    }
    const usedWeb =
      hadWebEvidence ||
      /\b(according to|search results|found that|released|announced|reported)\b/i.test(response.reply)
    if (!usedWeb && response.reply.length > 80 && plan.intent === 'general') {
      issues.push('General question - search the web first (search_internet / search_web) before answering.')
    }
  }

  if (plan.intent === 'goal') {
    if (GOAL_REFUSAL_RE.test(response.reply)) {
      issues.push('Refused a personal goal question - reframe with a trading plan instead.')
    }
    if (!response.setup && LEVELS_REQUEST_RE.test(userMessage)) {
      issues.push('Goal intent: provide setup or WAIT with levels tied to the stated goal.')
    }
  }

  if (plan.intent === 'research' || plan.taskTags.includes('web_research')) {
    const hasCitation =
      /\b(because|due to|according|report|data|headline|catalyst|source|shows|indicates)\b/i.test(
        response.reply
      )
    if (response.reply.length < 100 && !hasCitation) {
      if (hadWebEvidence) {
        issues.push('Research answer is thin - cite 2–3 specific facts from web/news briefs.')
      } else {
        suggestions.push('Research answer is thin - cite facts from sub-agent web/news briefs.')
      }
    }
  }

  if (needsLevels) {
    if (
      tradeContext?.action === 'WAIT' &&
      response.setup?.bias &&
      ['BUY', 'SELL'].includes(response.setup.bias) &&
      response.setup.entryType === 'market'
    ) {
      issues.push(
        'assess_trade_context says WAIT — use WAIT bias or limit/stop with triggerZone; do not issue market entry against context.'
      )
    }
    if (
      (response.setup?.bias === 'BUY' || response.setup?.bias === 'SELL') &&
      !/\b(session|London|New York|NY|Asia|Sydney|Tokyo|killzone|liquidity|sweep|inducement|event|ECB|FOMC|NFP)\b/i.test(
        response.reply
      )
    ) {
      suggestions.push(
        'Cite session timing + at least one of: liquidity pool, sweep/inducement, or upcoming event in the reply.'
      )
    }

    if (
      mtfAnalysis?.alignment === 'conflicting' &&
      response.setup?.bias &&
      ['BUY', 'SELL'].includes(response.setup.bias)
    ) {
      issues.push(
        'Multi-timeframe alignment is conflicting — bias must be WAIT with trigger conditions, not a directional market entry.'
      )
    }
    if (
      mtfAnalysis?.recommendation === 'WAIT' &&
      response.setup?.bias &&
      ['BUY', 'SELL'].includes(response.setup.bias) &&
      response.setup.entryType === 'market'
    ) {
      issues.push(
        'MTF analysis recommends WAIT — use WAIT or limit/stop with triggerZone; do not issue market BUY/SELL against higher-TF structure.'
      )
    }

    if (
      grounding.marketStatusForSymbol &&
      !grounding.marketStatusForSymbol.isOpen &&
      response.setup?.bias &&
      response.setup.bias !== 'WAIT' &&
      response.setup.entryType === 'market'
    ) {
      const asksFuture =
        /\b(monday|tuesday|wednesday|thursday|friday|tomorrow|next session|when market opens|open)\b/i.test(
          userMessage
        )
      if (asksFuture) {
        issues.push(
          'Market closed but user asked about a future entry - use LIMIT/WAIT with triggerZone, not market entry.'
        )
      } else if (!response.setup) {
        issues.push('Market closed and no WAIT/limit setup provided.')
      }
    }

    if (quote && response.setup) {
      const levels = [
        response.setup.entry,
        response.setup.stopLoss,
        response.setup.takeProfit,
        response.setup.invalidation,
      ].filter((n): n is number => typeof n === 'number' && n > 0)

      for (const lvl of levels) {
        const drift = Math.abs(lvl - quote) / quote
        if (drift > PRICE_DRIFT_PCT) {
          issues.push(
            `Level ${lvl.toFixed(2)} drifts ${(drift * 100).toFixed(0)}% from live quote ${quote.toFixed(2)} - re-anchor.`
          )
          break
        }
      }

      if (response.setup.bias === 'BUY' && response.setup.stopLoss && response.setup.stopLoss >= quote) {
        issues.push('BUY setup: stop loss must be below current price.')
      }
      if (response.setup.bias === 'SELL' && response.setup.stopLoss && response.setup.stopLoss <= quote) {
        issues.push('SELL setup: stop loss must be above current price.')
      }

      if (response.setup.stopLoss && stopLooksLikeRoundNumberTrap(response.setup.stopLoss)) {
        suggestions.push(
          'Stop sits on a round number (.00/.50) - retail trap zone; place beyond invalidation instead.'
        )
      }

      const rr = riskRewardRatio(response.setup)
      const minR = minRiskRewardForTimeframe(response.setup.timeframe ?? '')
      if (rr != null && rr < 1 && response.setup.bias !== 'WAIT') {
        issues.push(`R:R is ${rr.toFixed(1)} - reward must be at least equal to risk (≥ 1:1).`)
      } else if (rr != null && rr < minR && response.setup.bias !== 'WAIT') {
        suggestions.push(
          `R:R is ${rr.toFixed(1)} - aim for ≥ ${minR.toFixed(1)} on ${response.setup.timeframe || 'this timeframe'}.`
        )
      }
    }

    if (
      (response.setup?.bias === 'BUY' || response.setup?.bias === 'SELL') &&
      (!response.setup.entry || !response.setup.stopLoss || !response.setup.takeProfit)
    ) {
      issues.push('Active BUY/SELL setup missing entry, stop, or target.')
    }

    if (
      mode === 'chart' &&
      LEVELS_REQUEST_RE.test(userMessage) &&
      response.setup &&
      response.drawIntent !== true &&
      !pipelineLevelsComplete
    ) {
      issues.push('Chart mode + levels request - set drawIntent:true and call chart_mcp_draw_setup.')
    }

    if (
      (response.setup?.bias === 'BUY' || response.setup?.bias === 'SELL') &&
      !deepMarketSatisfied
    ) {
      issues.push(
        'Active setup without deep market check - call get_deep_market_data(symbol, targetPrice=entry) and cite volume/L2/timing in reply.'
      )
    }

    const hadTraderContext = Boolean(tradeContext?.action || mtfAnalysis?.alignment)
    if (
      (response.setup?.bias === 'BUY' || response.setup?.bias === 'SELL') &&
      !hadTraderContext &&
      !pipelineEvidence
    ) {
      issues.push(
        'Directional setup without trader context — call assess_trade_context (session + MTF + liquidity/inducement) before finalizing.'
      )
    }
  }

  if (plan.taskTags.includes('smart_money') || isLiquidityPoolQuestion(userMessage)) {
    const mentionsLiquidity =
      /\b(liquidity|pool|eqh|eql|equal high|equal low|buy.?side|sell.?side|sweep|stop cluster)\b/i.test(
        response.reply
      )
    if (!mentionsLiquidity && !response.levels?.some((l) => l.kind === 'liquidity')) {
      issues.push(
        'User asked about liquidity pools - name buy-side/sell-side levels with prices in the reply.'
      )
    }
    if (
      isLiquidityPoolQuestion(userMessage) &&
      !isDirectLevelsQuestion(userMessage) &&
      response.setup &&
      (response.setup.bias === 'BUY' || response.setup.bias === 'SELL')
    ) {
      issues.push(
        'Liquidity-only question - do not return a full trade setup card; answer liquidity pools only (setup:null).'
      )
    }
  }

  if (plan.taskTags.includes('reversal')) {
    const warnsTrap =
      /\b(trap|fakeout|sweep|liquidity|choch|inducement|judas|breakout.?fail)\b/i.test(response.reply)
    if (!warnsTrap && (response.setup?.bias === 'BUY' || response.setup?.bias === 'SELL')) {
      suggestions.push('Reversal question - mention liquidity sweep / trap risk before calling direction.')
    }
  }

  if (grounding.newsBlackout && response.setup?.bias && ['BUY', 'SELL'].includes(response.setup.bias)) {
    if (response.setup.entryType === 'market') {
      issues.push('News blackout - avoid market entries; use WAIT or limit after event.')
    }
  }

  if (!response.reply?.trim()) {
    issues.push('Empty reply text.')
  }

  if (response.reply.includes('**') || /^\s*[*•]\s/m.test(response.reply) || /\*[^*\n]+\*:/.test(response.reply) || /[\u{1F300}-\u{1FAFF}]/u.test(response.reply)) {
    suggestions.push('Use "- item" bullets and ### headings - no * asterisks, bold, or emojis in reply.')
  }

  issues.push(...detectReplyLeaks(response.reply))
  if (response.reply && detectProviderIdentityLeaks(response.reply)) {
    issues.push(
      'Leaked external AI provider identity - reply as Piplegacy only; never Google/Gemini/ChatGPT/Claude/DeepSeek/LLM.'
    )
  }

  // Promote critical suggestions to issues on second pass (handled by caller via attempt count)
  return {
    passed: issues.length === 0,
    issues,
    suggestions,
  }
}

export function renderReflectionPrompt(reflection: ReflectionResult, attempt: number): string {
  if (reflection.passed) return ''
  const lines = [
    'SELF-REFLECTION FAILED - revise your FINAL JSON before returning:',
    ...reflection.issues.map((i) => `- ISSUE: ${i}`),
    ...reflection.suggestions.map((s) => `- FIX: ${s}`),
  ]
  if (attempt >= 1) {
    lines.push(
      '',
      'VERIFICATION (mandatory): Re-read sub-agent briefs. Confirm SL beyond invalidation, not on round numbers.',
      'If user asked for a candle trigger, name the exact pattern. If chart mode, drawIntent:true + chart_mcp_draw_setup.',
      'Reply must start with ### or direct answer — zero Self-questions, Plan, Reflection, or "The user is asking" text.'
    )
  }
  lines.push('Re-check sub-agent briefs and grounding. Output corrected JSON only.')
  return lines.join('\n')
}
