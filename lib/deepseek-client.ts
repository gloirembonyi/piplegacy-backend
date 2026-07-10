/**
 * DeepSeek client that mirrors the Gemini call shape used by the agent loop.
 *
 * Accepts a Gemini-native request body (systemInstruction + contents + tools
 * + generationConfig), translates it to OpenAI chat-completions format,
 * calls DeepSeek, and translates the response back to Gemini's shape.
 *
 * The agent loop in `lib/agent/run.ts` treats this as a drop-in replacement
 * for the Gemini call when all Gemini keys are cooling.
 */

import { getDeepseekChatUrl } from '@/lib/deepseek'
import {
  geminiToOpenAiMessages,
  geminiToolsToOpenAi,
  openAiResponseToGemini,
  type GeminiContent,
  type GeminiResponse,
  type OpenAiChatRequest,
  type OpenAiChatResponse,
} from '@/lib/ai-translate'

/** Subset of the Gemini request body fields we actually translate. */
type GeminiNativeBody = {
  systemInstruction?: { role?: string; parts?: Array<{ text?: string }> }
  contents?: GeminiContent[]
  tools?: unknown
  generationConfig?: {
    temperature?: number
    maxOutputTokens?: number
    responseMimeType?: string
  }
}

export type DeepseekCallResult =
  | { ok: true; data: GeminiResponse }
  | {
      ok: false
      status: number
      body: string
      retryAfter: string | null
    }

export async function callDeepseek(
  apiKey: string,
  model: string,
  geminiBody: GeminiNativeBody
): Promise<DeepseekCallResult> {
  const systemText = geminiBody.systemInstruction?.parts
    ?.map((p) => p.text ?? '')
    .join('\n')
    .trim() ?? ''

  const messages = geminiToOpenAiMessages(systemText, geminiBody.contents ?? [])
  const tools = geminiToolsToOpenAi(geminiBody.tools)

  // DeepSeek requires at least one user message - if our conversation
  // somehow collapsed to system-only, append a no-op user prompt so the
  // API doesn't 400.
  const hasUser = messages.some((m) => m.role === 'user')
  if (!hasUser) {
    messages.push({
      role: 'user',
      content: 'Continue the analysis using the live grounding above.',
    })
  }

  const request: OpenAiChatRequest = {
    model,
    messages,
    temperature: geminiBody.generationConfig?.temperature ?? 0.25,
    max_tokens: Math.min(
      geminiBody.generationConfig?.maxOutputTokens ?? 2048,
      4096
    ),
  }

  if (tools.length > 0) {
    request.tools = tools
    request.tool_choice = 'auto'
  }

  if (geminiBody.generationConfig?.responseMimeType === 'application/json') {
    request.response_format = { type: 'json_object' }
  }

  let res: Response
  try {
    res = await fetch(getDeepseekChatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
    })
  } catch (err) {
    return {
      ok: false,
      status: 502,
      body:
        err instanceof Error
          ? `DeepSeek network error: ${err.message}`
          : 'DeepSeek network error',
      retryAfter: null,
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      body: await res.text().catch(() => ''),
      retryAfter: res.headers.get('retry-after'),
    }
  }

  let json: OpenAiChatResponse
  try {
    json = (await res.json()) as OpenAiChatResponse
  } catch {
    return {
      ok: false,
      status: 502,
      body: 'DeepSeek returned non-JSON response',
      retryAfter: null,
    }
  }

  return { ok: true, data: openAiResponseToGemini(json) }
}
