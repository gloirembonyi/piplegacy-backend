/**
 * Convert Trade Watch / pipeline setups into chart + UI formats.
 */

import type { TradingSetup } from '@/lib/agent/pipeline-types'
import type { MarketChatLevel, MarketChatSetup } from '@/lib/parse-market-chat-json'
import type { TradeWatchAlert } from '@/lib/trade-watch-types'
import {
  normalizeAndValidateSetup,
  validateSetupGeometry,
} from '@/lib/setup-risk-reward'

export type AlertSetupFields = NonNullable<TradeWatchAlert['setup']>

export function pipelineToAlertSetup(setup: TradingSetup): AlertSetupFields {
  return {
    bias: setup.bias,
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    confluenceScore: setup.confluenceScore,
    reasoning: setup.reasoning,
    timeframe: setup.timeframe,
  }
}

function isPipelineReasoningDump(text: string): boolean {
  return /smc=|momentum=|pattern=|sentiment=|regime=/i.test(text)
}

/** Convert chart-agent MarketChatSetup → Trade Watch alert fields (validated). */
export function chatSetupToAlertSetup(
  setup: MarketChatSetup | null | undefined,
  opts: { symbol: string; reply?: string }
): AlertSetupFields | null {
  const normalized = normalizeAndValidateSetup(setup ?? null, opts.symbol)
  if (!normalized) return null
  if (normalized.bias !== 'BUY' && normalized.bias !== 'SELL') return null
  if (
    normalized.entry == null ||
    normalized.stopLoss == null ||
    normalized.takeProfit == null
  ) {
    return null
  }
  if (validateSetupGeometry(normalized).length > 0) return null

  const confidence = normalized.confidence ?? 0
  if (confidence < 40) return null

  let reasoning =
    [normalized.triggerCondition, normalized.confirmation]
      .filter((s) => s?.trim())
      .join(' · ')
      .trim() || opts.reply?.replace(/\s+/g, ' ').trim().slice(0, 200) || ''

  if (isPipelineReasoningDump(reasoning)) {
    reasoning = `${normalized.bias} setup from chart agent`
  }

  return {
    bias: normalized.bias,
    entry: normalized.entry,
    stopLoss: normalized.stopLoss,
    takeProfit: normalized.takeProfit,
    confluenceScore: Math.round(confidence),
    reasoning: reasoning.slice(0, 240),
    timeframe: normalized.timeframe ?? '1h',
  }
}

export function formatAlertSetupDetail(setup: AlertSetupFields): string {
  const score = setup.confluenceScore ?? 0
  const note = setup.reasoning?.trim()
  if (!note || isPipelineReasoningDump(note)) {
    return `${score}% · ${setup.bias} setup`
  }
  return `${score}% · ${note.slice(0, 120)}`
}

export function alertSetupToMarketChat(
  setup: AlertSetupFields | undefined
): MarketChatSetup | null {
  if (!setup) return null
  const bias =
    setup.bias === 'BUY' || setup.bias === 'SELL'
      ? setup.bias
      : setup.entry != null
        ? 'WAIT'
        : 'WAIT'
  return {
    bias,
    entryType: 'market',
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    confidence: setup.confluenceScore ?? 0,
    timeframe: setup.timeframe ?? '1h',
    confirmation: '',
    risks: [],
    triggerCondition: setup.reasoning?.slice(0, 140) ?? '',
    validUntil: 'Next 24h',
    invalidation: setup.stopLoss,
    triggerZone: null,
  }
}

export function levelsFromAlertSetup(setup: AlertSetupFields): MarketChatLevel[] {
  const levels: MarketChatLevel[] = []
  if (setup.entry != null) {
    levels.push({ price: setup.entry, label: 'Entry', kind: 'entry' })
  }
  if (setup.stopLoss != null) {
    levels.push({ price: setup.stopLoss, label: 'Stop', kind: 'support' })
  }
  if (setup.takeProfit != null) {
    levels.push({ price: setup.takeProfit, label: 'Target', kind: 'target' })
  }
  return levels
}

export function formatSetupLevels(setup: AlertSetupFields, symbol?: string): string {
  const parts: string[] = []
  if (setup.bias) parts.push(setup.bias)
  if (setup.entry != null) parts.push(`E ${formatPrice(setup.entry, symbol)}`)
  if (setup.stopLoss != null) parts.push(`SL ${formatPrice(setup.stopLoss, symbol)}`)
  if (setup.takeProfit != null) parts.push(`TP ${formatPrice(setup.takeProfit, symbol)}`)
  if (setup.confluenceScore != null) parts.push(`${setup.confluenceScore}%`)
  return parts.join(' · ')
}

function formatPrice(n: number, symbol?: string): string {
  if (Math.abs(n) >= 1000) return n.toFixed(2)
  if (Math.abs(n) >= 10) return n.toFixed(2)
  return n.toFixed(4)
}
