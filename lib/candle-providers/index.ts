import { fetchAvDailyCandles } from '@/lib/candle-providers/alpha-vantage'
import { fetchFmpDailyCandles, type RawCandle } from '@/lib/candle-providers/fmp'
import { fetchYahooDailyCandles } from '@/lib/candle-providers/yahoo'

export type CandleBar = RawCandle

export type CandleSource = 'fmp' | 'alpha-vantage' | 'yahoo' | 'none'

export type CandleFetchResult = {
  data: CandleBar[]
  source: CandleSource
  resolution: string
}

/**
 * Daily OHLC across providers. Order is chosen for coverage:
 *   1. FMP        - best for US stocks (when API key set)
 *   2. Yahoo      - universal fallback (stocks, forex, metals, crypto, free)
 *   3. Alpha Vantage - backup for stocks
 *
 * Yahoo is what makes XAUUSD / EURUSD / BTCUSD work even when FMP returns
 * empty arrays on the free tier.
 */
export async function fetchMarketCandles(
  symbol: string,
  resolution: string
): Promise<CandleFetchResult> {
  const res = resolution === 'D' ? 'D' : resolution

  if (res !== 'D') {
    return { data: [], source: 'none', resolution: res }
  }

  const fmp = await fetchFmpDailyCandles(symbol, 400)
  if (fmp.length >= 30) {
    return { data: fmp, source: 'fmp', resolution: res }
  }

  const yahoo = await fetchYahooDailyCandles(symbol, 400)
  if (yahoo.length >= 30) {
    return { data: yahoo, source: 'yahoo', resolution: res }
  }

  const av = await fetchAvDailyCandles(symbol, 400)
  if (av.length >= 30) {
    return { data: av, source: 'alpha-vantage', resolution: res }
  }

  // Last-ditch: return whatever any provider gave us, even short series.
  if (fmp.length > 0) return { data: fmp, source: 'fmp', resolution: res }
  if (yahoo.length > 0) return { data: yahoo, source: 'yahoo', resolution: res }
  if (av.length > 0) return { data: av, source: 'alpha-vantage', resolution: res }

  return { data: [], source: 'none', resolution: res }
}
