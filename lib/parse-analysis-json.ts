export type SignalConfirmation = {
  strength: number
  volumeConfirmation: string
  patternConfirmation: string
  indicatorAlignment: string
  timeframeAlignment: string
  status: string
  requiredConfirmation: string
}

export type ChartAnalysis = {
  signal: 'BUY' | 'SELL' | 'HOLD'
  probability: number
  prediction: string
  keyLevels: { support: number[]; resistance: number[] }
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'
  timeframe: string
  analysis: string
  recommendations: string[]
  entryPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  riskRewardRatio: number | null
  symbol?: string | null
  trend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  trendStrength?: string
  pattern?: string
  secondaryPatterns?: string[]
  signalStatus?: 'immediate' | 'pending confirmation'
  confirmationNeeded?: string
  signalConfirmation?: SignalConfirmation
  aiInsights?: string[]
}

function extractStringField(text: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = text.match(re)
  return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : null
}

function extractNumberField(text: string, key: string): number | null {
  const re = new RegExp(`"${key}"\\s*:\\s*(-?[\\d.]+)`)
  const m = text.match(re)
  return m ? Number(m[1]) : null
}

function extractSignal(text: string): ChartAnalysis['signal'] {
  const m = text.match(/"signal"\s*:\s*"(BUY|SELL|HOLD)"/i)
  return (m?.[1]?.toUpperCase() as ChartAnalysis['signal']) || 'HOLD'
}

function extractLevels(text: string, key: 'support' | 'resistance'): number[] {
  const block = text.match(new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)`))
  if (!block) return []
  return [...block[1].matchAll(/[\d.]+/g)].map((m) => Number(m[0])).filter((n) => !Number.isNaN(n))
}

function extractRecommendations(text: string): string[] {
  const block = text.match(/"recommendations"\s*:\s*\[([\s\S]*?)(?:\]|$)/)
  if (!block) return []
  return [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"')
  )
}

function extractStringArray(text: string, key: string): string[] {
  const block = text.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`))
  if (!block) return []
  return [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"')
  )
}

function repairTruncatedJson(raw: string): string {
  let json = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '')
  const start = json.indexOf('{')
  if (start >= 0) json = json.slice(start)
  json = json.replace(/,\s*([}\]])/g, '$1')
  json = json.replace(/,\s*$/, '')

  const openBraces = (json.match(/\{/g) || []).length
  const closeBraces = (json.match(/\}/g) || []).length
  const openBrackets = (json.match(/\[/g) || []).length
  const closeBrackets = (json.match(/\]/g) || []).length

  for (let i = 0; i < openBrackets - closeBrackets; i++) json += ']'
  for (let i = 0; i < openBraces - closeBraces; i++) json += '}'

  return json
}

function parseSignalConfirmation(raw: unknown): SignalConfirmation | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  return {
    strength: Math.min(100, Math.max(0, Number(o.strength) || 0)),
    volumeConfirmation: String(o.volumeConfirmation || '-'),
    patternConfirmation: String(o.patternConfirmation || '-'),
    indicatorAlignment: String(o.indicatorAlignment || '-'),
    timeframeAlignment: String(o.timeframeAlignment || '-'),
    status: String(o.status || '-'),
    requiredConfirmation: String(o.requiredConfirmation || '-'),
  }
}

export function parseAnalysisJson(text: string): ChartAnalysis {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '')

  for (const candidate of [cleaned, repairTruncatedJson(cleaned)]) {
    try {
      const parsed = JSON.parse(candidate)
      return normalizeAnalysis(parsed)
    } catch {
      /* try repair / fallback */
    }
  }

  return {
    signal: extractSignal(cleaned),
    probability: extractNumberField(cleaned, 'probability') ?? 50,
    prediction: extractStringField(cleaned, 'prediction') ?? 'Analysis recovered from partial response',
    keyLevels: {
      support: extractLevels(cleaned, 'support'),
      resistance: extractLevels(cleaned, 'resistance'),
    },
    riskLevel:
      (extractStringField(cleaned, 'riskLevel')?.toUpperCase() as ChartAnalysis['riskLevel']) || 'MEDIUM',
    timeframe: extractStringField(cleaned, 'timeframe') ?? '-',
    analysis: extractStringField(cleaned, 'analysis') ?? extractStringField(cleaned, 'prediction') ?? '',
    recommendations: extractRecommendations(cleaned),
    entryPrice: extractNumberField(cleaned, 'entryPrice'),
    stopLoss: extractNumberField(cleaned, 'stopLoss'),
    takeProfit: extractNumberField(cleaned, 'takeProfit'),
    riskRewardRatio: extractNumberField(cleaned, 'riskRewardRatio'),
    trend: (extractStringField(cleaned, 'trend')?.toUpperCase() as ChartAnalysis['trend']) || undefined,
    pattern: extractStringField(cleaned, 'pattern') ?? undefined,
    signalStatus:
      (extractStringField(cleaned, 'signalStatus')?.toLowerCase() as ChartAnalysis['signalStatus']) ||
      undefined,
    confirmationNeeded: extractStringField(cleaned, 'confirmationNeeded') ?? undefined,
    aiInsights: extractStringArray(cleaned, 'aiInsights'),
  }
}

function normalizeAnalysis(raw: Record<string, unknown>): ChartAnalysis {
  const signal = String(raw.signal || 'HOLD').toUpperCase()
  const validSignal = signal === 'BUY' || signal === 'SELL' || signal === 'HOLD' ? signal : 'HOLD'

  const kl = raw.keyLevels as { support?: unknown; resistance?: unknown } | undefined

  const trendRaw = String(raw.trend || '').toUpperCase()
  const trend =
    trendRaw === 'BULLISH' || trendRaw === 'BEARISH' || trendRaw === 'NEUTRAL'
      ? (trendRaw as ChartAnalysis['trend'])
      : undefined

  const statusRaw = String(raw.signalStatus || '').toLowerCase()
  const signalStatus =
    statusRaw === 'immediate' || statusRaw === 'pending confirmation'
      ? (statusRaw as ChartAnalysis['signalStatus'])
      : undefined

  return {
    signal: validSignal,
    probability: Math.min(100, Math.max(0, Number(raw.probability) || 50)),
    prediction: String(raw.prediction || 'Analysis complete'),
    keyLevels: {
      support: Array.isArray(kl?.support) ? kl.support.map(Number).filter((n) => !Number.isNaN(n)) : [],
      resistance: Array.isArray(kl?.resistance)
        ? kl.resistance.map(Number).filter((n) => !Number.isNaN(n))
        : [],
    },
    riskLevel: (['LOW', 'MEDIUM', 'HIGH'].includes(String(raw.riskLevel).toUpperCase())
      ? String(raw.riskLevel).toUpperCase()
      : 'MEDIUM') as ChartAnalysis['riskLevel'],
    timeframe: String(raw.timeframe || '-'),
    analysis: String(raw.analysis || raw.prediction || ''),
    recommendations: Array.isArray(raw.recommendations)
      ? raw.recommendations.map(String)
      : ['Monitor price action'],
    entryPrice: raw.entryPrice != null ? Number(raw.entryPrice) : null,
    stopLoss: raw.stopLoss != null ? Number(raw.stopLoss) : null,
    takeProfit: raw.takeProfit != null ? Number(raw.takeProfit) : null,
    riskRewardRatio: raw.riskRewardRatio != null ? Number(raw.riskRewardRatio) : null,
    symbol: raw.symbol != null ? String(raw.symbol) : null,
    trend,
    trendStrength: raw.trendStrength != null ? String(raw.trendStrength) : undefined,
    pattern: raw.pattern != null ? String(raw.pattern) : undefined,
    secondaryPatterns: Array.isArray(raw.secondaryPatterns)
      ? raw.secondaryPatterns.map(String)
      : undefined,
    signalStatus,
    confirmationNeeded: raw.confirmationNeeded != null ? String(raw.confirmationNeeded) : undefined,
    signalConfirmation: parseSignalConfirmation(raw.signalConfirmation),
    aiInsights: Array.isArray(raw.aiInsights) ? raw.aiInsights.map(String) : undefined,
  }
}
