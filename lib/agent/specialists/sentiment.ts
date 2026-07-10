/**
 * Sentiment specialist - recent news headlines + (crypto only) Fear & Greed.
 * Uses the existing `searchNews` tool from the agent registry for free
 * coverage across stocks / forex / metals / crypto.
 */

import { searchNews } from '@/lib/ai-tools/web-search'
import { fetchCryptoFearGreed } from '@/lib/ai-tools/crypto-providers'
import {
  callSpecialistModel,
  clamp,
  degradedReport,
  normalizeVerdict,
  parseJsonish,
} from '@/lib/agent/specialists/helpers'
import type { SpecialistReport } from '@/lib/agent/pipeline-types'
import type { SpecialistContext } from '@/lib/agent/specialists/helpers'

const SYSTEM = `You are a market sentiment desk. Given recent headlines (and optional crypto Fear&Greed), return ONE strict JSON object:
{"verdict":"BULLISH|BEARISH|NEUTRAL|AVOID","confidence":0..100,"headline":"<=120 chars","tilt":"risk_on|risk_off|neutral","topThemes":["<=3 short themes"],"blockers":["short reason if any"]}`

function isCrypto(symbol: string): boolean {
  const s = symbol.toUpperCase()
  return (
    s.startsWith('BTC') ||
    s.startsWith('ETH') ||
    s.startsWith('SOL') ||
    s.startsWith('XRP') ||
    s.startsWith('DOGE') ||
    s.startsWith('BINANCE:') ||
    s.startsWith('COINBASE:')
  )
}

export async function runSentimentSpecialist(
  ctx: SpecialistContext
): Promise<SpecialistReport> {
  const start = Date.now()
  const { symbol, symbolLabel } = ctx
  try {
    const [newsList, fg] = await Promise.all([
      searchNews(`${symbolLabel} ${symbol} market`, 6).catch(() => []),
      isCrypto(symbol)
        ? fetchCryptoFearGreed().catch(() => null)
        : Promise.resolve(null),
    ])
    const headlines = (newsList ?? []).slice(0, 6)
    if (headlines.length === 0 && !fg) {
      return degradedReport('sentiment', start, 'No fresh sentiment data')
    }

    const fgText = fg ? `Crypto Fear & Greed Index: ${fg.value} (${fg.label})` : ''
    const userPrompt = `Symbol: ${symbolLabel} (${symbol})
${fgText}
Recent headlines:
${headlines.map((h, i) => `${i + 1}. ${h.title}${h.source ? ` - ${h.source}` : ''}`).join('\n')}

Return ONLY the strict JSON object the system prompt specified.`

    const r = await callSpecialistModel({
      systemPrompt: SYSTEM,
      userPrompt,
      maxTokens: 512,
    })

    if (!r.ok) {
      const bearish = headlines.filter((h) =>
        /fall|drop|decline|bear|sell|weak|cut|downgrade|slump|loss/i.test(h.title)
      ).length
      const bullish = headlines.filter((h) =>
        /rise|gain|rally|bull|buy|strong|upgrade|surge|record high/i.test(h.title)
      ).length
      const ruleVerdict =
        bearish > bullish + 1 ? 'BEARISH' : bullish > bearish + 1 ? 'BULLISH' : 'NEUTRAL'
      return {
        id: 'sentiment',
        verdict: ruleVerdict,
        confidence: Math.min(55, 35 + Math.abs(bearish - bullish) * 8),
        headline: `Rule-based sentiment from ${headlines.length} headlines`,
        durationMs: Date.now() - start,
        degraded: true,
        error: r.error,
        data: { headlines: headlines.map((h) => h.title), fearGreed: fg },
      }
    }

    type ParsedSentiment = {
      verdict?: string
      confidence?: number
      headline?: string
      tilt?: string
      topThemes?: string[]
      blockers?: string[]
    }
    const parsed = parseJsonish<ParsedSentiment>(r.text, {})
    return {
      id: 'sentiment',
      verdict: normalizeVerdict(parsed.verdict),
      confidence: clamp(Number(parsed.confidence ?? 40), 0, 100),
      headline: String(parsed.headline ?? 'Sentiment analysis complete'),
      durationMs: Date.now() - start,
      blockers: Array.isArray(parsed.blockers)
        ? parsed.blockers.filter((b) => typeof b === 'string').slice(0, 3)
        : undefined,
      data: {
        tilt: parsed.tilt ?? null,
        topThemes: parsed.topThemes ?? [],
        fearGreed: fg,
        headlines: headlines.map((h) => h.title),
      },
    }
  } catch (err) {
    return degradedReport(
      'sentiment',
      start,
      err instanceof Error ? err.message : 'unknown error'
    )
  }
}
