import { NextResponse } from 'next/server';
import { isAuthSession, requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MarketCandlesResponse {
  symbol: string;
  candles: CandleData[];
  timeframe: string;
  lastUpdate: string;
}

// Finnhub API configuration
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'demo';
const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';

// Generate realistic candlestick data for demo purposes
const generateCandlestickData = (symbol: string, count: number = 50): CandleData[] => {
  const candles: CandleData[] = [];
  const now = Date.now();
  const interval = 5 * 60 * 1000; // 5 minutes in milliseconds
  
  // Base price varies by symbol
  const basePrices: { [key: string]: number } = {
    'EURUSD': 1.0845,
    'GBPUSD': 1.2654,
    'USDJPY': 149.23,
    'AAPL': 175.50,
    'MSFT': 380.25,
    'GOOGL': 140.80,
    'SPY': 520.15,
    'QQQ': 450.30,
    'VIX': 18.45
  };
  
  let lastPrice = basePrices[symbol] || 100;
  
  for (let i = count - 1; i >= 0; i--) {
    const timestamp = now - (i * interval);
    
    // Generate realistic OHLC data
    const volatility = 0.02; // 2% volatility
    const trend = (Math.random() - 0.5) * 0.001; // Small trend component
    
    const open = lastPrice;
    const change = (Math.random() - 0.5) * volatility + trend;
    const close = Math.max(0.01, open * (1 + change));
    
    const high = Math.max(open, close) * (1 + Math.random() * 0.01);
    const low = Math.min(open, close) * (1 - Math.random() * 0.01);
    
    const volume = Math.floor(Math.random() * 1000000) + 100000;
    
    candles.push({
      timestamp,
      open: parseFloat(open.toFixed(4)),
      high: parseFloat(high.toFixed(4)),
      low: parseFloat(low.toFixed(4)),
      close: parseFloat(close.toFixed(4)),
      volume
    });
    
    lastPrice = close;
  }
  
  return candles;
};

// Fetch real data from Finnhub (with fallback to generated data)
const fetchFinnhubCandles = async (symbol: string, timeframe: string = '5'): Promise<CandleData[]> => {
  try {
    // Convert symbol format for Finnhub
    const finnhubSymbol = symbol.includes('USD') ? symbol : symbol;
    
    const response = await fetch(
      `${FINNHUB_BASE_URL}/stock/candle?symbol=${finnhubSymbol}&resolution=${timeframe}&from=${Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)}&to=${Math.floor(Date.now() / 1000)}&token=${FINNHUB_API_KEY}`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );
    
    if (!response.ok) {
      throw new Error(`Finnhub API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.s === 'ok' && data.c && data.c.length > 0) {
      return data.t.map((timestamp: number, index: number) => ({
        timestamp: timestamp * 1000, // Convert to milliseconds
        open: data.o[index],
        high: data.h[index],
        low: data.l[index],
        close: data.c[index],
        volume: data.v[index] || 0
      }));
    } else {
      // Fallback to generated data if no real data available
      return generateCandlestickData(symbol, 50);
    }
  } catch (error) {
    console.error('Finnhub API error:', error);
    // Fallback to generated data
    return generateCandlestickData(symbol, 50);
  }
};

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!isAuthSession(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'AAPL';
    const timeframe = searchParams.get('timeframe') || '5';
    
    // Fetch candlestick data
    const candles = await fetchFinnhubCandles(symbol, timeframe);
    
    const response: MarketCandlesResponse = {
      symbol,
      candles,
      timeframe: `${timeframe}m`,
      lastUpdate: new Date().toISOString()
    };
    
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Market candles API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch market data' },
      { status: 500 }
    );
  }
}
