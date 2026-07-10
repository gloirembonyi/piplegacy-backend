import { getDeepseekApiKeys, isDeepseekConfigured } from '@/lib/deepseek'
import { getGeminiApiKeys, isGeminiConfigured } from '@/lib/gemini'

export type AiConfigStatus = {
  configured: boolean
  geminiKeyCount: number
  deepseekKeyCount: number
  /** User-facing message when chat cannot run. */
  message: string
  /** Hint for operators (admin / logs). */
  operatorHint: string
}

export function getAiConfigStatus(): AiConfigStatus {
  const geminiKeyCount = getGeminiApiKeys().length
  const deepseekKeyCount = getDeepseekApiKeys().length
  const configured = geminiKeyCount > 0 || deepseekKeyCount > 0
  const onVercel = Boolean(process.env.VERCEL)

  if (!configured) {
    return {
      configured: false,
      geminiKeyCount: 0,
      deepseekKeyCount: 0,
      message: onVercel
        ? 'Market chat is not configured on this deployment. Add GEMINI_API_KEY and/or DEEPSEEK_API_KEY in Vercel → Project → Settings → Environment Variables, then redeploy.'
        : 'Market chat is not configured. Add GEMINI_API_KEY and/or DEEPSEEK_API_KEY to .env.local.',
      operatorHint: 'No AI in environment.',
    }
  }

  if (geminiKeyCount === 0 && deepseekKeyCount > 0) {
    return {
      configured: true,
      geminiKeyCount: 0,
      deepseekKeyCount,
      message: '',
      operatorHint: 'DeepSeek-only mode (no Gemini keys). Image uploads require GEMINI_API_KEY.',
    }
  }

  if (geminiKeyCount > 0 && deepseekKeyCount === 0) {
    return {
      configured: true,
      geminiKeyCount,
      deepseekKeyCount: 0,
      message: '',
      operatorHint:
        'Gemini-only mode. Add DEEPSEEK_API_KEY as fallback when Gemini quota is exhausted.',
    }
  }

  return {
    configured: true,
    geminiKeyCount,
    deepseekKeyCount,
    message: '',
    operatorHint: `Pooled: ${geminiKeyCount} Gemini + ${deepseekKeyCount} DeepSeek keys.`,
  }
}

export function isAiConfigured(): boolean {
  return isGeminiConfigured() || isDeepseekConfigured()
}
