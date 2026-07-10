/**
 * Optimal candle resolutions for structure / SMC analysis vs the user's chart TF.
 * Scalp TFs are too noisy alone - we step up one level for liquidity pools.
 */

export type SmcResolutionPlan = {
  primary: string
  htf: string
  primaryLabel: string
  htfLabel: string
  minBars: number
  note: string
}

const RES_LABELS: Record<string, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '60': '1H',
  '240': '4H',
  '4h': '4H',
  D: 'Daily',
  '1D': 'Daily',
  W: 'Weekly',
}

function label(res: string): string {
  return RES_LABELS[res] ?? RES_LABELS[res.toUpperCase()] ?? res
}

/** Primary + HTF resolutions for Smart Money / liquidity scouts. */
export function optimalSmcResolutions(chartResolution?: string): SmcResolutionPlan {
  const r = (chartResolution ?? '60').trim().toUpperCase()
  const n = parseInt(r, 10)

  if (r === 'D' || r === '1D') {
    return {
      primary: 'D',
      htf: '240',
      primaryLabel: 'Daily',
      htfLabel: '4H',
      minBars: 30,
      note: 'Swing: daily liquidity pools with 4H execution context',
    }
  }
  if (r === 'W' || r === '1W') {
    return {
      primary: 'D',
      htf: 'W',
      primaryLabel: 'Daily',
      htfLabel: 'Weekly',
      minBars: 30,
      note: 'Position: weekly + daily institutional levels',
    }
  }
  if (!Number.isNaN(n) && n <= 5) {
    return {
      primary: '15',
      htf: '60',
      primaryLabel: '15m',
      htfLabel: '1H',
      minBars: 40,
      note: 'Scalp: 15m structure (5m too noisy for EQH/EQL); 1H bias for sweeps',
    }
  }
  if (!Number.isNaN(n) && n <= 15) {
    return {
      primary: '15',
      htf: '60',
      primaryLabel: '15m',
      htfLabel: '1H',
      minBars: 35,
      note: 'Intraday: 15m liquidity map aligned to 1H swing pools',
    }
  }
  if (!Number.isNaN(n) && n <= 60) {
    return {
      primary: '60',
      htf: '240',
      primaryLabel: '1H',
      htfLabel: '4H',
      minBars: 30,
      note: 'Intraday/swing: 1H sweeps with 4H institutional bias',
    }
  }
  if (!Number.isNaN(n) && n <= 240) {
    return {
      primary: '240',
      htf: 'D',
      primaryLabel: '4H',
      htfLabel: 'Daily',
      minBars: 30,
      note: 'Swing: 4H order blocks with daily liquidity above/below',
    }
  }

  return {
    primary: '60',
    htf: '240',
    primaryLabel: label('60'),
    htfLabel: label('240'),
    minBars: 30,
    note: 'Default: 1H primary with 4H higher-timeframe bias',
  }
}

/** Human label for chart resolution codes (for setup.timeframe field). */
export function resolutionDisplayLabel(resolution?: string): string {
  const plan = optimalSmcResolutions(resolution)
  return plan.primaryLabel
}
