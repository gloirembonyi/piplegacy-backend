/** Symbols used for Market Insights AI context and quick-pick UI. */

export const INSIGHTS_QUICK_SYMBOLS = [
  { symbol: 'MARKET', label: 'All markets', description: 'Global macro + calendar + news' },
  { symbol: 'OANDA:EUR_USD', label: 'EUR/USD', description: 'Euro / US Dollar' },
  { symbol: 'OANDA:GBP_USD', label: 'GBP/USD', description: 'British Pound / USD' },
  { symbol: 'OANDA:USD_JPY', label: 'USD/JPY', description: 'US Dollar / Yen' },
  { symbol: 'OANDA:AUD_USD', label: 'AUD/USD', description: 'Australian Dollar / USD' },
  { symbol: 'OANDA:USD_CAD', label: 'USD/CAD', description: 'US Dollar / CAD' },
  { symbol: 'OANDA:XAU_USD', label: 'XAU/USD', description: 'Gold / USD' },
  { symbol: 'SPY', label: 'SPY', description: 'S&P 500 ETF' },
  { symbol: 'BINANCE:BTCUSDT', label: 'BTC', description: 'Bitcoin' },
] as const

export const INSIGHTS_CONTEXT_SYMBOLS = [
  'SPY',
  'QQQ',
  'OANDA:EUR_USD',
  'OANDA:GBP_USD',
  'OANDA:USD_JPY',
  'OANDA:AUD_USD',
  'OANDA:USD_CAD',
  'OANDA:XAU_USD',
  'BINANCE:BTCUSDT',
] as const

const PAIR_ALIASES: Record<string, string> = {
  EURUSD: 'OANDA:EUR_USD',
  'EUR/USD': 'OANDA:EUR_USD',
  GBPUSD: 'OANDA:GBP_USD',
  'GBP/USD': 'OANDA:GBP_USD',
  USDJPY: 'OANDA:USD_JPY',
  'USD/JPY': 'OANDA:USD_JPY',
  AUDUSD: 'OANDA:AUD_USD',
  XAUUSD: 'OANDA:XAU_USD',
  GOLD: 'OANDA:XAU_USD',
  BTC: 'BINANCE:BTCUSDT',
  BTCUSD: 'BINANCE:BTCUSDT',
  BITCOIN: 'BINANCE:BTCUSDT',
  SPX: 'SPY',
  SP500: 'SPY',
  NASDAQ: 'QQQ',
}

/** Guess a focus symbol from the user message (optional). */
export function inferSymbolFromMessage(message: string): string | null {
  const upper = message.toUpperCase()
  for (const [alias, symbol] of Object.entries(PAIR_ALIASES)) {
    if (upper.includes(alias.replace('/', '')) || upper.includes(alias)) {
      return symbol
    }
  }
  const stockMatch = upper.match(/\b(AAPL|MSFT|NVDA|TSLA|GOOGL|AMZN|META)\b/)
  if (stockMatch) return stockMatch[1]
  return null
}
