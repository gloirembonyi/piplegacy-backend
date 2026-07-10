/**
 * User-safe evidence summaries - facts only, no scouts, tools, or pipeline internals.
 */

import type { PipelineResult } from '@/lib/agent/pipeline-types'
import { isTradeManagementQuestion } from '@/lib/setup-reply-format'
import type { SubAgentBrief } from './types'

function userCalendarLines(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const c = data as { events?: Array<{ title?: string; date?: string; impact?: string; time?: string }> }
  const events = c.events ?? []
  return events.slice(0, 6).map((e) => {
    const when = [e.date, e.time].filter(Boolean).join(' ')
    const impact = e.impact && e.impact !== '?' ? ` · ${e.impact} impact` : ''
    return `- **${when || 'Upcoming'}:** ${e.title ?? 'Event'}${impact}`
  })
}

function userNewsLines(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const n = data as { results?: Array<{ title?: string; source?: string }> }
  const results = n.results ?? []
  return results.slice(0, 5).map((r) => {
    const src = r.source ? ` (${r.source})` : ''
    return `- ${r.title ?? 'Headline'}${src}`
  })
}

function userWebLines(
  data: unknown,
  ctx: { symbolLabel?: string; userMessage?: string }
): string[] {
  if (!data || typeof data !== 'object') return []
  const w = data as { results?: Array<{ title?: string; snippet?: string }> }
  const results = w.results ?? []
  return results
    .filter((r) =>
      isRelevantWebHit(r.title ?? '', r.snippet ?? '', ctx)
    )
    .slice(0, 4)
    .map((r) => {
      const snippet = (r.snippet ?? '').slice(0, 140).trim()
      return snippet
        ? `- ${r.title ?? 'Source'}: ${snippet}${snippet.length >= 140 ? '…' : ''}`
        : `- ${r.title ?? 'Source'}`
    })
}

function userTechnicalLine(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const t = data as Record<string, unknown>
  if (t.error || t.available === false) return null
  const parts: string[] = []
  if (t.trend) parts.push(String(t.trend))
  if (t.rsi14 != null) parts.push(`RSI ${t.rsi14}`)
  if (t.changePct5 != null) parts.push(`${t.changePct5}% (5d)`)
  return parts.length ? `- Trend context: ${parts.join(' · ')}` : null
}

const DIRECT_LEVELS_RE =
  /\b(where (are|is)|show me|give me|what (are|is)).{0,40}(entry|stop|target|tp|sl|levels?)\b/i

const SETUP_INTENTS = new Set(['setup', 'reversal', 'goal'])

function shouldCompactEvidence(opts: {
  compact?: boolean
  userMessage?: string
  intent?: string
  taskTags?: string[]
}): boolean {
  if (opts.compact) return true
  if (isDirectLevelsQuestion(opts.userMessage)) return true
  if (isTradeManagementQuestion(opts.userMessage)) return true
  if (opts.intent && SETUP_INTENTS.has(opts.intent)) return true
  if (opts.taskTags?.includes('levels') || opts.taskTags?.includes('entry_timing')) return true
  if (opts.taskTags?.includes('smart_money')) return true
  return false
}

/** Drop obvious off-topic web hits (e.g. Maine policy when user trades gold). */
function isRelevantWebHit(
  title: string,
  snippet: string,
  ctx: { symbolLabel?: string; userMessage?: string }
): boolean {
  const text = `${title} ${snippet}`.toLowerCase()
  const junk =
    /\b(maine|cumberland county|paul miller'?s law|cardano|memecoin|ice detain|laptop ban|school board)\b/i
  if (junk.test(text)) return false

  const sym = (ctx.symbolLabel ?? '').toLowerCase()
  const msg = (ctx.userMessage ?? '').toLowerCase()

  if (sym.includes('xau') || sym.includes('gold') || /\bgold\b|\bxau\b/.test(msg)) {
    return /gold|xau|xag|silver|precious|metal|dollar|dxy|fed|usd|inflation|safe.?haven|treasury|yield|cpi|nfp|forex|commodit/i.test(
      text
    )
  }
  if (sym.includes('btc') || sym.includes('eth') || /\bbitcoin\b|\bbtc\b|\bethereum\b/.test(msg)) {
    return /bitcoin|btc|eth|crypto|blockchain|coinbase|binance/i.test(text)
  }
  if (isTradeManagementQuestion(ctx.userMessage)) {
    return /market|trade|price|forex|stock|fed|usd|cpi|nfp|gold|oil|crypto|index|nasdaq|s&p|eur|gbp|jpy/i.test(
      text
    )
  }
  return true
}

export function isDirectLevelsQuestion(message?: string): boolean {
  return Boolean(message?.trim() && DIRECT_LEVELS_RE.test(message))
}

export function wantsNewsInReply(intent?: string, message?: string): boolean {
  return wantsNewsFocus(intent, message)
}

function wantsNewsFocus(intent?: string, message?: string): boolean {
  if (isDirectLevelsQuestion(message)) return false
  if (isTradeManagementQuestion(message)) return false
  if (intent && SETUP_INTENTS.has(intent)) return false
  const m = (message ?? '').toLowerCase()
  if (/news|calendar|tomorrow|event|catalyst|headline|fed|cpi|nfp|why.*moving|what'?s happening/i.test(m)) {
    return true
  }
  return intent === 'macro' || intent === 'research' || intent === 'general'
}

/** Build markdown bullets for emergency / partial replies - never expose internal names. */
export function renderUserEvidenceSummary(opts: {
  briefs?: SubAgentBrief[]
  pipeline?: PipelineResult | null
  intent?: string
  userMessage?: string
  symbolLabel?: string
  taskTags?: string[]
  /** Skip news/calendar dumps - e.g. user only asked for entry/stop/target. */
  compact?: boolean
}): string {
  if (shouldCompactEvidence(opts)) {
    return renderCompactTechnicalEvidence(opts)
  }
  const blocks: string[] = []
  const newsFirst = wantsNewsFocus(opts.intent, opts.userMessage)
  const webCtx = { symbolLabel: opts.symbolLabel, userMessage: opts.userMessage }

  const calendar: string[] = []
  const headlines: string[] = []
  const webHits: string[] = []
  let technical: string | null = null

  for (const brief of opts.briefs ?? []) {
    if (brief.id === 'macro') {
      calendar.push(...userCalendarLines(brief.data.calendar))
      headlines.push(...userNewsLines(brief.data.marketNews))
    }
    if (brief.id === 'research') {
      webHits.push(...userWebLines(brief.data.web, webCtx))
      headlines.push(...userNewsLines(brief.data.news))
      const ta = userTechnicalLine(brief.data.technical)
      if (ta) technical = ta
    }
    if (brief.id === 'setup') {
      const ta = userTechnicalLine(brief.data.technical)
      if (ta) technical = ta
    }
    if (brief.id === 'liquidity') {
      const primary = (brief.data.primary as { analysis?: { verdict?: string; headline?: string; confidence?: number } } | undefined)
        ?.analysis
      if (primary?.headline || primary?.verdict) {
        blocks.push(
          `**Smart money:** ${primary.verdict?.toLowerCase() ?? 'read'}${primary.confidence != null ? ` · ${primary.confidence}%` : ''} - ${primary.headline ?? ''}`.trim()
        )
      }
    }
  }

  if (opts.pipeline) {
    const { setup, reports } = opts.pipeline
    if (!newsFirst) {
      blocks.push(
        `**Outlook:** ${setup.bias} · ${setup.confluenceScore}/100 confidence`
      )
      if (setup.blockers.length) {
        blocks.push(`**Watch:** ${setup.blockers.slice(0, 3).join('; ')}`)
      }
    }
    const signals = reports
      .filter((r) => r.headline)
      .slice(0, 3)
      .map((r) => `- ${r.headline}`)
    if (signals.length && !newsFirst) {
      blocks.push('**Key signals:**', ...signals)
    }
  }

  if (newsFirst) {
    if (calendar.length) {
      blocks.push('**Upcoming events:**', ...calendar)
    }
    if (headlines.length) {
      blocks.push('**Market headlines:**', ...headlines)
    }
    if (webHits.length) {
      blocks.push('**From web research:**', ...webHits)
    }
  } else {
    if (headlines.length) {
      blocks.push('**Headlines:**', ...headlines)
    }
    if (calendar.length) {
      blocks.push('**Calendar:**', ...calendar)
    }
    if (webHits.length) {
      blocks.push('**Research:**', ...webHits)
    }
  }

  if (technical) blocks.push(technical)

  if (blocks.length === 0) {
    const summaries = (opts.briefs ?? [])
      .map((b) => b.summary)
      .filter((s) => s && !/scout|ms\)|tool|prefetch/i.test(s))
      .slice(0, 3)
    if (summaries.length) {
      blocks.push('**Summary:**', ...summaries.map((s) => `- ${s}`))
    }
  }

  return blocks.join('\n')
}

/** Setup / trade-mgmt: technical + smart money only - no random web dumps. */
function renderCompactTechnicalEvidence(opts: {
  briefs?: SubAgentBrief[]
  userMessage?: string
}): string {
  const lines: string[] = []
  let technical: string | null = null

  for (const brief of opts.briefs ?? []) {
    if (brief.id === 'setup' || brief.id === 'research') {
      const ta = userTechnicalLine(brief.data?.technical)
      if (ta) technical = ta
    }
    if (brief.id === 'liquidity') {
      const primary = (
        brief.data?.primary as { analysis?: { verdict?: string; headline?: string } } | undefined
      )?.analysis
      if (primary?.headline) {
        lines.push(`- **Smart money:** ${primary.headline.slice(0, 160)}`)
      }
    }
  }

  if (technical) {
    if (lines.length) lines.push('')
    lines.push(technical.replace(/^- /, ''))
  }

  return lines.length ? `### Context\n\n${lines.map((l) => (l.startsWith('- ') ? l : `- ${l}`)).join('\n')}` : ''
}

export function userFacingEmergencyReason(reason: string): string {
  const r = reason.toLowerCase()
  if (r.includes('busy') || r.includes('rate') || r.includes('429')) {
    return 'Piplegacy was under heavy load'
  }
  if (r.includes('time budget') || r.includes('timeout') || r.includes('deadline')) {
    return 'the analysis ran out of time'
  }
  if (r.includes('no progress') || r.includes('stall')) {
    return 'processing did not finish in time'
  }
  return 'the full pass could not complete'
}
