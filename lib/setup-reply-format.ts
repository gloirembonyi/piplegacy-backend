/**
 * Rich markdown for setup / trade-management replies - tables, context, risks.
 * Matches Piplegacy UI style (AgentMarkdown + setup card).
 */

import { formatMarketPrice } from '@/lib/format-market-price'
import type { MarketChatLevel, MarketChatSetup } from '@/lib/parse-market-chat-json'

export type SetupReplyFormat = 'narrative' | 'session' | 'compact' | 'management'

const SESSION_REPLY_RE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|tomorrow|next week|when market opens|session open|london|new york|asia open|give setup|setup for|plan for)\b/i

export function detectSetupReplyFormat(userMessage?: string): SetupReplyFormat {
  if (isTradeManagementQuestion(userMessage)) return 'management'
  if (SESSION_REPLY_RE.test(userMessage ?? '')) return 'session'
  if (
    /\b(where (are|is)|show me|give me|what (are|is)).{0,30}(entry|stop|target|tp|sl|levels?)\b/i.test(
      userMessage ?? ''
    )
  ) {
    return 'compact'
  }
  return 'narrative'
}

export function isSessionSetupQuestion(message?: string): boolean {
  return SESSION_REPLY_RE.test(message?.trim() ?? '')
}

const TRADE_MANAGEMENT_RE =
  /\b(hold(ing)?|keep holding|still hold|can i (hold|keep|stay)|should i (hold|close|exit|cut)|break[\s-]?even|take profit|trail(ing)?|move stop|exit|close (the )?trade|manage (the )?position|running (profit|loss)|in profit|in loss)\b/i

export function isTradeManagementQuestion(message?: string): boolean {
  return Boolean(message?.trim() && TRADE_MANAGEMENT_RE.test(message))
}

const SETUP_REQUEST_RE =
  /\b(give|show|need|want|get).{0,20}(setup|plan|trade|levels?)\b|\bsetup for\b|\btrade (idea|plan|setup)\b|\b(entry|stop|target).{0,20}(setup|plan)\b/i

export function isSetupRequestQuestion(message?: string): boolean {
  return Boolean(
    message?.trim() &&
      (SETUP_REQUEST_RE.test(message) ||
        isSessionSetupQuestion(message) ||
        isTradeManagementQuestion(message))
  )
}

const LIQUIDITY_POOL_RE =
  /\b(buy.?side|sell.?side).{0,24}liquidity\b|\bliquidity.{0,24}(pool|pools|zone|level|leval)\b|\b(where|show me|give me|what).{0,40}(liquidity|eqh|eql|equal high|equal low)\b|\b(eqh|eql|equal highs?|equal lows?)\b/i

/** User asks where liquidity pools are - not a full entry/stop/target setup request. */
export function isLiquidityPoolQuestion(message?: string): boolean {
  return Boolean(message?.trim() && LIQUIDITY_POOL_RE.test(message))
}

/** Detect deterministic template prose (not question-tailored AI copy). */
export function isStaticSetupTemplateReply(reply: string | null | undefined): boolean {
  const t = (reply ?? '').trim()
  if (!t || t.length < 40) return true
  if (/- trade read\b/i.test(t)) return true
  if (/Analysis from gathered data/i.test(t)) return true
  if (
    /\*\*(BUY|SELL|WAIT|HOLD)\*\* setup\s·\s\d+% confluence/i.test(t) &&
    /\| Level \| Price \| Note \|/.test(t)
  ) {
    return true
  }
  if (/^#{1,4}\s.+\s-\s(plan for|position check)/im.test(t) && /\| Level \| Price \| Note \|/.test(t)) {
    return true
  }
  if (/write the final answer to match the user question/i.test(t)) return true
  if (/Structured levels are in the setup card/i.test(t) && t.length < 280) return true
  return false
}

export function needsSetupReplyPolish(
  reply: string | null | undefined,
  planIntent?: string,
  userMessage?: string
): boolean {
  if (isStaticSetupTemplateReply(reply)) return true
  if (isLiquidityPoolQuestion(userMessage) && (reply ?? '').trim().length < 100) return true
  if (planIntent === 'setup' || planIntent === 'reversal' || planIntent === 'goal') {
    if (isSetupRequestQuestion(userMessage) && (reply ?? '').trim().length < 120) return true
  }
  return false
}

function riskReward(
  entry: number | null,
  stop: number | null,
  target: number | null
): number | null {
  if (entry == null || stop == null || target == null) return null
  const risk = Math.abs(entry - stop)
  const reward = Math.abs(target - entry)
  if (risk <= 0) return null
  return reward / risk
}

/** Fill missing setup.entry/stopLoss/takeProfit from labeled levels array. */
export function syncSetupFromLevels(
  setup: MarketChatSetup | null,
  levels: MarketChatLevel[]
): MarketChatSetup | null {
  if (!setup) return null

  const byKind = (kind: MarketChatLevel['kind']) =>
    levels.find((l) => l.kind === kind)?.price ?? null
  const byLabel = (re: RegExp) =>
    levels.find((l) => l.label && re.test(l.label))?.price ?? null

  return {
    ...setup,
    entry: setup.entry ?? byKind('entry') ?? null,
    stopLoss:
      setup.stopLoss ??
      byLabel(/\bstop\b/i) ??
      null,
    takeProfit:
      setup.takeProfit ??
      byKind('target') ??
      byLabel(/\btarget\b|\btp\b/i) ??
      null,
  }
}

export type SetupReplyOptions = {
  symbolLabel?: string
  symbol?: string
  userMessage?: string
  priceLine?: string
  smartMoneySection?: string
  /** Extra context bullets (trend, POC, etc.) - shown under ### Context */
  contextBullets?: string[]
  /** When true, skip levels table in prose (card only) */
  proseLevelsOnlyInCard?: boolean
  /** narrative | session | compact | management - auto-detected from userMessage if omitted */
  format?: SetupReplyFormat
  /** Note when chart already has a position overlay */
  activeSetupNote?: string
}

function buildLevelsTable(
  setup: MarketChatSetup,
  levels: MarketChatLevel[],
  symbol?: string
): string[] {
  const synced = syncSetupFromLevels(setup, levels) ?? setup
  const rows: Array<{ role: string; price: number; note: string }> = []

  if (synced.stopLoss != null) {
    rows.push({
      role: 'Stop loss',
      price: synced.stopLoss,
      note: synced.bias === 'SELL' ? 'Above entry / invalidation' : 'Below entry',
    })
  }
  if (synced.entry != null) {
    rows.push({
      role: 'Entry',
      price: synced.entry,
      note: synced.entryType === 'market' ? 'Market' : synced.entryType === 'limit' ? 'Limit pending' : 'Stop pending',
    })
  }
  if (synced.takeProfit != null) {
    rows.push({
      role: 'Target',
      price: synced.takeProfit,
      note: synced.bias === 'SELL' ? 'Downside objective' : 'Upside objective',
    })
  }

  for (const l of levels.slice(0, 4)) {
    const dup = rows.some((r) => Math.abs(r.price - l.price) < Math.max(0.05, r.price * 0.0002))
    if (dup) continue
    if (l.kind === 'entry' || l.kind === 'target') continue
    rows.push({
      role: l.label ?? (l.kind === 'support' ? 'Support' : l.kind === 'resistance' ? 'Resistance' : 'Level'),
      price: l.price,
      note: l.kind ?? 'structure',
    })
  }

  rows.sort((a, b) => b.price - a.price)
  if (rows.length === 0) return []

  const lines = [
    '| Level | Price | Note |',
    '| --- | ---: | --- |',
    ...rows.map(
      (r) =>
        `| ${r.role} | ${formatMarketPrice(r.price, symbol)} | ${r.note} |`
    ),
  ]
  return lines
}

function buildSessionIntro(
  setup: MarketChatSetup,
  userMessage: string,
  symbolLabel?: string,
  symbol?: string,
  groundingSessions?: string[]
): string[] {
  const dayMatch = userMessage.match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|weekend)\b/i
  )
  const day = dayMatch?.[1] ?? 'the next session'
  const title = symbolLabel ? `### ${symbolLabel} - plan for ${day}` : `### Plan for ${day}`
  const lines = [title, '']
  lines.push(
    `- **Window:** ${setup.validUntil || `Valid through ${day} - re-check before London/NY open`}.`
  )
  if (setup.entryType === 'limit') {
    lines.push(
      `- **Entry type:** Limit - wait for price to reach \`${formatMarketPrice(setup.entry, symbol)}\` (do not chase at market if closed).`
    )
  }
  if (groundingSessions?.length) {
    lines.push(`- **Sessions:** ${groundingSessions.join(', ')}`)
  }
  if (setup.bias === 'SELL' || setup.bias === 'BUY') {
    lines.push(
      `- **Direction:** ${setup.bias} - ${setup.triggerCondition || setup.confirmation || 'confirm structure before sizing'}.`
    )
  }
  return lines
}

function buildCompactIntro(setup: MarketChatSetup, symbolLabel?: string): string[] {
  const sym = symbolLabel ?? 'Setup'
  const bias = setup.bias && setup.bias !== 'WAIT' ? setup.bias : 'Levels'
  return [`### ${sym} - ${bias}`, '']
}

function buildWhySection(setup: MarketChatSetup, heading = '### Why this setup'): string[] {
  const lines: string[] = []
  const parts: string[] = []

  if (setup.confirmation?.trim() && !/smc=|momentum=/i.test(setup.confirmation)) {
    parts.push(setup.confirmation.trim())
  }
  if (
    setup.triggerCondition?.trim() &&
    setup.triggerCondition !== setup.confirmation
  ) {
    parts.push(setup.triggerCondition.trim())
  }

  if (parts.length === 0) return lines

  lines.push(heading, '')
  for (const p of parts) {
    if (p.includes('\n')) {
      lines.push(...p.split('\n').filter(Boolean).map((l) => (l.startsWith('- ') ? l : `- ${l}`)))
    } else {
      lines.push(`- ${p}`)
    }
  }
  return lines
}

function buildRisksSection(setup: MarketChatSetup, symbol?: string): string[] {
  if (!setup.risks?.length && setup.invalidation == null) return []
  const lines = ['### Risks', '']
  for (const r of setup.risks.slice(0, 4)) {
    lines.push(`- ${r}`)
  }
  if (
    setup.invalidation != null &&
    setup.stopLoss != null &&
    Math.abs(setup.invalidation - setup.stopLoss) > Math.max(0.05, setup.invalidation * 0.0002)
  ) {
    lines.push(
      `- Thesis invalidates on a sustained close through \`${formatMarketPrice(setup.invalidation, symbol)}\`.`
    )
  }
  return lines
}

function buildTradeManagementIntro(
  setup: MarketChatSetup,
  userMessage: string,
  symbolLabel?: string,
  symbol?: string
): string[] {
  const sym = symbolLabel ?? symbol?.replace(/^[^:]+:/, '') ?? 'this position'
  const synced = setup
  const lines: string[] = [`### ${sym} - position check`, '']

  const holdingShort =
    /\b(short|sell)\b/i.test(userMessage) || setup.bias === 'SELL'
  const holdingLong = /\b(long|buy)\b/i.test(userMessage) || setup.bias === 'BUY'

  if (holdingShort || setup.bias === 'SELL') {
    lines.push(
      `- **Bias:** Still aligned for **shorts** while price holds below key resistance and the target at \`${formatMarketPrice(synced.takeProfit, symbol)}\` remains open.`
    )
    if (synced.stopLoss != null) {
      lines.push(
        `- **Stop:** Keep stop at \`${formatMarketPrice(synced.stopLoss, symbol)}\` - a sustained break above invalidates the bearish thesis.`
      )
    }
    lines.push(
      `- **Action:** Trail stop toward breakeven only after a fresh lower high forms; do not widen the stop into the liquidity pool.`
    )
  } else if (holdingLong || setup.bias === 'BUY') {
    lines.push(
      `- **Bias:** **Long** thesis intact while price holds above support and target at \`${formatMarketPrice(synced.takeProfit, symbol)}\` is still valid.`
    )
    if (synced.stopLoss != null) {
      lines.push(
        `- **Stop:** Maintain \`${formatMarketPrice(synced.stopLoss, symbol)}\` - exit on a close below if structure breaks.`
      )
    }
  } else {
    lines.push(
      `- Review the levels below - adjust only if structure confirms your original thesis.`
    )
  }

  return lines
}

/** User-facing markdown for setup + optional trade-management questions. */
export function formatSetupReplyMarkdown(
  setup: MarketChatSetup,
  levels: MarketChatLevel[] = [],
  opts: SetupReplyOptions = {}
): string {
  const synced = syncSetupFromLevels(setup, levels) ?? setup
  const symbol = opts.symbol
  const format = opts.format ?? detectSetupReplyFormat(opts.userMessage)
  const lines: string[] = []

  if (opts.activeSetupNote?.trim()) {
    lines.push(`> ${opts.activeSetupNote.trim()}`, '')
  }

  if (format === 'management') {
    lines.push(...buildTradeManagementIntro(synced, opts.userMessage ?? '', opts.symbolLabel, symbol))
  } else if (format === 'session') {
    if (opts.priceLine?.trim()) {
      lines.push(opts.priceLine.trim(), '')
    }
    lines.push(
      ...buildSessionIntro(synced, opts.userMessage ?? '', opts.symbolLabel, symbol)
    )
  } else if (format === 'compact') {
    lines.push(...buildCompactIntro(synced, opts.symbolLabel))
    if (opts.priceLine?.trim()) lines.push(opts.priceLine.trim(), '')
  } else {
    const title = opts.symbolLabel
      ? `### ${opts.symbolLabel} - trade read`
      : '### Trade read'
    lines.push(title, '')
    if (opts.priceLine?.trim()) {
      lines.push(opts.priceLine.trim(), '')
    }
    if (synced.bias && synced.bias !== 'HOLD') {
      const rr = riskReward(synced.entry, synced.stopLoss, synced.takeProfit)
      const rrText = rr != null ? ` · R:R **${rr.toFixed(1)}**` : ''
      lines.push(
        `**${synced.bias}** setup${synced.confidence ? ` · ${synced.confidence}% confluence` : ''}${rrText}${synced.timeframe ? ` · ${synced.timeframe}` : ''}.`
      )
      lines.push('')
    }
  }

  if (opts.smartMoneySection?.trim() && format !== 'compact') {
    lines.push(opts.smartMoneySection.trim(), '')
  }

  if (opts.contextBullets?.length && format !== 'compact') {
    lines.push('### Context', '')
    for (const b of opts.contextBullets.slice(0, 5)) {
      lines.push(b.startsWith('- ') ? b : `- ${b}`)
    }
    lines.push('')
  }

  if (!opts.proseLevelsOnlyInCard) {
    const table = buildLevelsTable(synced, levels, symbol)
    if (table.length) {
      if (lines.length && lines.at(-1) !== '') lines.push('')
      const tableHeading = format === 'session' ? '### Key levels' : '### Levels'
      lines.push(tableHeading, '', ...table, '')
    }
  }

  if (format !== 'management' && format !== 'compact') {
    lines.push(...buildWhySection(synced, format === 'session' ? '### Execution plan' : '### Why this setup'))
    if (lines.at(-1) !== '') lines.push('')
  }

  lines.push(...buildRisksSection(synced, symbol))

  if (lines.length <= 2) {
    lines.push('', 'Levels are in the setup card and on the chart.')
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** @deprecated Use formatSetupReplyMarkdown - kept for callers. */
export function synthesizeSetupReply(
  setup: MarketChatSetup,
  levels: MarketChatLevel[] = [],
  symbolLabel?: string,
  opts?: Omit<SetupReplyOptions, 'symbolLabel'>
): string {
  return formatSetupReplyMarkdown(setup, levels, { ...opts, symbolLabel })
}
