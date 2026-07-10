/** Same prompt as the chart agent suggestion chip. */
export const TRADE_WATCH_AGENT_SETUP_MESSAGE = 'Where are entry, stop & target?'

export const CHART_AGENT_PROMPT_EVENT = 'ms:chart-agent-prompt'
export const TRADE_WATCH_RELOAD_EVENT = 'ms:trade-watch-reload'

export function dispatchChartAgentSetupPrompt() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CHART_AGENT_PROMPT_EVENT))
}

export function dispatchTradeWatchReload() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(TRADE_WATCH_RELOAD_EVENT))
}
