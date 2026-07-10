/** Compact number formatting for admin dashboards. */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export function formatPercent(used: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

export function providerDisplayName(provider: 'gemini' | 'deepseek'): string {
  return provider === 'gemini' ? 'Primary AI' : 'Fallback AI'
}

export function providerSubLabel(provider: 'gemini' | 'deepseek'): string {
  return provider === 'gemini' ? 'Gemini' : 'DeepSeek'
}
