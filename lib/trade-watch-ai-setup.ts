/**

 * Run the chart-page Market Agent for a Trade Watch symbol (not the 8-specialist pipeline).

 */



import { runAgent } from '@/lib/agent/run'

import { getGeminiApiKeys } from '@/lib/gemini'

import { isAiConfigured } from '@/lib/ai-config'

import { timeframeToResolution } from '@/lib/agent/specialists/helpers'

import { normalizeMarketChatResponse } from '@/lib/parse-market-chat-json'

import { consumePlanUsage, getPlanUsage, recordPlanTokens } from '@/lib/plan-usage'

import { getPlanLimits } from '@/lib/plan-limits'

import { getUserData } from '@/lib/user-store'

import { displaySymbolLabel, normalizeSymbol } from '@/lib/symbols'

import { appendTradeLog } from '@/lib/trade-log-store'

import { TRADE_WATCH_AGENT_SETUP_MESSAGE } from '@/lib/trade-watch-agent-message'

import type { TradeWatchAlert, TradeWatchConfig } from '@/lib/trade-watch-types'

import {

  chatSetupToAlertSetup,

  formatAlertSetupDetail,

} from '@/lib/trade-watch-setup'

import {

  attachSetupToSymbolAlerts,

  getTradeWatchBook,

  hasRecentAlert,

  pushTradeWatchAlert,

  savePairStates,

} from '@/lib/trade-watch-store'



function tfToPipeline(tf: TradeWatchConfig['defaultTimeframe']): string {

  switch (tf) {

    case '15m':

      return '15m'

    case '4h':

      return '4h'

    case '1d':

      return '1d'

    default:

      return '1h'

  }

}



function chartHref(symbol: string): string {

  return `/app?view=chart&symbol=${encodeURIComponent(symbol)}&panel=signals`

}



export type AiSetupResult = {

  symbol: string

  setup: NonNullable<TradeWatchAlert['setup']> | null

  alerts: TradeWatchAlert[]

  pipelineBias: string

  confluenceScore: number

  reply?: string

  drawIntent?: boolean

}



export async function runAiSetupForSymbol(

  email: string,

  symbolInput: string,

  opts: { force?: boolean } = {}

): Promise<AiSetupResult> {

  const symbol = normalizeSymbol(symbolInput)

  const user = await getUserData(email)

  const limits = getPlanLimits(user.plan)



  if (!limits.autoTrader) {

    throw new Error('PLAN_UPGRADE_REQUIRED')

  }



  if (!isAiConfigured()) {

    throw new Error('AI not configured')

  }



  const hourPeek = await getPlanUsage(email, user.plan, 'marketChatHour')

  if (!hourPeek.ok) {

    throw new Error(hourPeek.message ?? 'Chat limit reached')

  }

  const dayPeek = await getPlanUsage(email, user.plan, 'marketChatDay')

  if (!dayPeek.ok) {

    throw new Error(dayPeek.message ?? 'Daily chat limit reached')

  }



  const book = await getTradeWatchBook(email)

  const prev = book.config.pairStates[symbol]



  if (

    !opts.force &&

    prev?.lastAiScanAt &&

    Date.now() - Date.parse(prev.lastAiScanAt) < 30 * 60_000

  ) {

    const existing = book.alerts.find(

      (a) => a.symbol === symbol && a.setup && !a.read

    )

    if (existing?.setup) {

      return {

        symbol,

        setup: existing.setup,

        alerts: book.alerts.filter((a) => a.symbol === symbol && !a.read),

        pipelineBias: existing.setup.bias ?? 'HOLD',

        confluenceScore: existing.setup.confluenceScore ?? 0,

      }

    }

  }



  await consumePlanUsage(email, user.plan, 'marketChatHour')

  await consumePlanUsage(email, user.plan, 'marketChatDay')



  const timeframe = tfToPipeline(book.config.defaultTimeframe)

  const resolution = timeframeToResolution(timeframe)



  const agentResult = await runAgent({

    apiKeys: getGeminiApiKeys(),

    mode: 'chart',

    symbol,

    symbolLabel: displaySymbolLabel(symbol),

    resolution,

    message: TRADE_WATCH_AGENT_SETUP_MESSAGE,

    history: [],

    chartState: null,

    user: {
      email,
      plan: user.plan,
      preferences: user.preferences,
      watchlist: user.watchlist,
      favorites: user.favorites,
    },

  })



  if (!agentResult.ok) {

    throw new Error(agentResult.error || 'Chart agent failed')

  }



  if (agentResult.tokensUsed > 0) {

    await recordPlanTokens(email, agentResult.tokensUsed)

  }



  const normalized = normalizeMarketChatResponse(agentResult.response)

  const alertSetup = chatSetupToAlertSetup(normalized.setup, {

    symbol,

    reply: normalized.reply,

  })



  const pairStates = { ...book.config.pairStates }

  const state = pairStates[symbol] ?? {

    symbol,

    lastScanAt: new Date().toISOString(),

    lastPrice: null,

    changePercent: null,

    signalScore: 0,

    movementState: 'calm' as const,

    direction: 'neutral' as const,

    reasons: [],

  }

  state.lastAiScanAt = new Date().toISOString()

  state.lastSetupBias = alertSetup?.bias ?? normalized.setup?.bias ?? 'HOLD'

  state.lastConfluence = alertSetup?.confluenceScore ?? normalized.setup?.confidence ?? 0

  pairStates[symbol] = state

  await savePairStates(email, pairStates)



  await appendTradeLog(email, {

    kind: 'scan',

    strategyId: 'trade-watch',

    symbol,

    timeframe,

    confluenceScore: state.lastConfluence,

    bias: state.lastSetupBias,

    durationMs: 0,

  })



  let alerts: TradeWatchAlert[] = []



  if (alertSetup) {

    await appendTradeLog(email, {

      kind: 'proposed',

      strategyId: 'trade-watch',

      symbol,

      timeframe: alertSetup.timeframe ?? timeframe,

      bias: alertSetup.bias,

      entry: alertSetup.entry,

      stopLoss: alertSetup.stopLoss,

      takeProfit: alertSetup.takeProfit,

      confluenceScore: alertSetup.confluenceScore,

      reasoning: alertSetup.reasoning,

    })



    const attached = await attachSetupToSymbolAlerts(email, symbol, alertSetup)

    alerts = attached



    if (!hasRecentAlert(book.alerts, symbol, 'setup')) {

      const created = await pushTradeWatchAlert(email, {

        symbol,

        kind: 'setup',

        severity: (alertSetup.confluenceScore ?? 0) >= 70 ? 'critical' : 'warning',

        title: `${displaySymbolLabel(symbol)} - ${alertSetup.bias} setup`,

        detail: formatAlertSetupDetail(alertSetup),

        setup: alertSetup,

        href: chartHref(symbol),

      })

      if (created) alerts = [created, ...alerts]

    }

  }



  return {

    symbol,

    setup: alertSetup,

    alerts,

    pipelineBias: alertSetup?.bias ?? normalized.setup?.bias ?? 'HOLD',

    confluenceScore: alertSetup?.confluenceScore ?? normalized.setup?.confidence ?? 0,

    reply: normalized.reply,

    drawIntent: normalized.drawIntent ?? Boolean(alertSetup),

  }

}


