import { getDeepseekBaseUrl } from '@/lib/deepseek'

export type DeepseekBalanceInfo = {
  currency: string
  totalBalance: number
  grantedBalance: number
  toppedUpBalance: number
}

export type DeepseekBalanceResult = {
  keySuffix: string
  ok: boolean
  isAvailable: boolean
  balances: DeepseekBalanceInfo[]
  primaryDisplay: string | null
  error?: string
}

type ApiBalanceResponse = {
  is_available?: boolean
  balance_infos?: Array<{
    currency?: string
    total_balance?: string
    granted_balance?: string
    topped_up_balance?: string
  }>
}

function parseAmount(raw: string | undefined): number {
  if (!raw) return 0
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : 0
}

/** Live account balance from DeepSeek (USD preferred, else first currency). */
export async function fetchDeepseekBalance(apiKey: string): Promise<DeepseekBalanceResult> {
  const keySuffix = apiKey.slice(-4)
  const url = `${getDeepseekBaseUrl()}/user/balance`

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        keySuffix,
        ok: false,
        isAvailable: false,
        balances: [],
        primaryDisplay: null,
        error: body.slice(0, 120) || `HTTP ${res.status}`,
      }
    }

    const json = (await res.json()) as ApiBalanceResponse
    const balances: DeepseekBalanceInfo[] = (json.balance_infos ?? []).map((b) => ({
      currency: b.currency ?? 'USD',
      totalBalance: parseAmount(b.total_balance),
      grantedBalance: parseAmount(b.granted_balance),
      toppedUpBalance: parseAmount(b.topped_up_balance),
    }))

    const preferred =
      balances.find((b) => b.currency === 'USD') ??
      balances.find((b) => b.currency === 'CNY') ??
      balances[0]

    const primaryDisplay = preferred
      ? `${preferred.totalBalance.toFixed(2)} ${preferred.currency}`
      : null

    return {
      keySuffix,
      ok: true,
      isAvailable: json.is_available !== false,
      balances,
      primaryDisplay,
    }
  } catch (err) {
    return {
      keySuffix,
      ok: false,
      isAvailable: false,
      balances: [],
      primaryDisplay: null,
      error: err instanceof Error ? err.message.slice(0, 120) : 'Balance fetch failed',
    }
  }
}

export async function fetchAllDeepseekBalances(
  apiKeys: string[]
): Promise<DeepseekBalanceResult[]> {
  return Promise.all(apiKeys.map((k) => fetchDeepseekBalance(k)))
}

/** Daily token budget per Gemini key (env). Used to estimate remaining quota. */
export function getGeminiDailyTokenBudget(): number {
  const raw = process.env.GEMINI_DAILY_TOKEN_BUDGET?.trim()
  const n = raw ? Number.parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n > 0) return n
  return 1_000_000
}
