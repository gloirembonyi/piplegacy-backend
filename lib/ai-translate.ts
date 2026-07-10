/**
 * Translation layer: Gemini wire format ↔ OpenAI/DeepSeek wire format.
 *
 * The agent loop in `lib/agent/run.ts` is built around Gemini's native types
 * (Content[] / Part / functionCall / functionResponse). When the Gemini key
 * pool exhausts and we fall back to DeepSeek, this module converts the
 * conversation to OpenAI chat-completions format (which DeepSeek accepts),
 * then converts the response back to Gemini's shape so the rest of the
 * loop is unchanged.
 *
 * Key insight: tool_call IDs are synthesised deterministically from position
 * (`call_<msgIdx>_<callIdx>`) so the assistant tool_calls and the subsequent
 * tool messages reference the same IDs across translation rounds.
 */

// ─── Gemini wire types (mirrored from lib/agent/run.ts) ──────────────

export type GeminiTextPart = { text: string }
export type GeminiFunctionCallPart = {
  functionCall: { name: string; args?: Record<string, unknown> }
}
export type GeminiFunctionResponsePart = {
  functionResponse: { name: string; response: Record<string, unknown> }
}
export type GeminiInlineDataPart = {
  inline_data: { mime_type: string; data: string }
}
export type GeminiPart =
  | GeminiTextPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart
  | GeminiInlineDataPart

export type GeminiContent = {
  role: 'user' | 'model' | 'function'
  parts: GeminiPart[]
}

export type GeminiCandidate = {
  content?: GeminiContent
  finishReason?: string
}

export type GeminiResponse = {
  candidates?: GeminiCandidate[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

// ─── OpenAI / DeepSeek wire types ────────────────────────────────────

export type OpenAiToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAiToolCall[]
    }
  | { role: 'tool'; content: string; tool_call_id: string }

export type OpenAiTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type OpenAiChatRequest = {
  model: string
  messages: OpenAiMessage[]
  tools?: OpenAiTool[]
  tool_choice?: 'auto' | 'none' | 'required'
  temperature?: number
  max_tokens?: number
  response_format?: { type: 'text' | 'json_object' }
}

export type OpenAiChatResponse = {
  choices?: Array<{
    message?: {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAiToolCall[]
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function isTextPart(p: GeminiPart): p is GeminiTextPart {
  return typeof (p as GeminiTextPart).text === 'string'
}
function isFunctionCallPart(p: GeminiPart): p is GeminiFunctionCallPart {
  return (p as GeminiFunctionCallPart).functionCall !== undefined
}
function isFunctionResponsePart(p: GeminiPart): p is GeminiFunctionResponsePart {
  return (p as GeminiFunctionResponsePart).functionResponse !== undefined
}

/** Deterministic synthetic tool-call ID from message + call position. */
function callId(msgIdx: number, callIdx: number, name: string): string {
  return `c${msgIdx}_${callIdx}_${name.slice(0, 24)}`
}

/**
 * Gemini parameter schemas use uppercase `"OBJECT" / "STRING" / "ARRAY"`
 * while OpenAI/JSON-Schema expects lowercase. Walk recursively and lowercase
 * every `type` field, leaving the rest of the schema intact.
 */
function lowercaseSchemaTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => lowercaseSchemaTypes(v))
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'type' && typeof v === 'string') {
        out[k] = v.toLowerCase()
      } else {
        out[k] = lowercaseSchemaTypes(v)
      }
    }
    return out
  }
  return value
}

// ─── Gemini → OpenAI: tools ──────────────────────────────────────────

type GeminiToolsField = Array<{
  functionDeclarations?: Array<{
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }>
}>

export function geminiToolsToOpenAi(tools: unknown): OpenAiTool[] {
  if (!Array.isArray(tools)) return []
  const out: OpenAiTool[] = []
  for (const group of tools as GeminiToolsField) {
    const decls = group?.functionDeclarations
    if (!Array.isArray(decls)) continue
    for (const d of decls) {
      const params = (lowercaseSchemaTypes(
        d.parameters ?? { type: 'object', properties: {} }
      ) as Record<string, unknown>)
      // OpenAI rejects parameters without a "type" key - guard.
      if (!params.type) params.type = 'object'
      if (!params.properties) params.properties = {}
      out.push({
        type: 'function',
        function: {
          name: d.name,
          description: d.description ?? '',
          parameters: params,
        },
      })
    }
  }
  return out
}

// ─── Gemini → OpenAI: messages ───────────────────────────────────────

/**
 * Convert a Gemini conversation (systemInstruction + contents[]) into the
 * OpenAI chat-completions messages array.
 *
 * - Multi-call assistant turns produce ONE assistant message with N tool_calls.
 * - Multi-response function turns produce N tool messages (one per call).
 * - Inline image parts are silently DROPPED (DeepSeek-chat has no vision)
 *   and a `[image attachment omitted]` note is appended to the user text
 *   so the model knows context was lost.
 */
export function geminiToOpenAiMessages(
  systemPrompt: string,
  contents: GeminiContent[]
): OpenAiMessage[] {
  const messages: OpenAiMessage[] = []
  if (systemPrompt.trim()) {
    messages.push({ role: 'system', content: systemPrompt })
  }

  // Track tool_call IDs by name as we walk so the next 'function' turn can
  // reference them. We use a per-turn list of ids, FIFO matched.
  let lastIds: string[] = []
  let lastNames: string[] = []

  for (let i = 0; i < contents.length; i++) {
    const c = contents[i]

    if (c.role === 'user') {
      const textParts: string[] = []
      let droppedImage = 0
      for (const p of c.parts) {
        if (isTextPart(p)) textParts.push(p.text)
        else if ('inline_data' in p) droppedImage++
      }
      let text = textParts.join('\n').trim()
      if (droppedImage > 0) {
        text +=
          (text ? '\n\n' : '') +
          `[${droppedImage} image attachment${droppedImage > 1 ? 's' : ''} omitted - model fell back to text-only provider]`
      }
      if (!text) text = '(empty user turn)'
      messages.push({ role: 'user', content: text })
      continue
    }

    if (c.role === 'model') {
      const calls = c.parts.filter(isFunctionCallPart)
      const texts = c.parts.filter(isTextPart).map((p) => p.text).join('').trim()
      if (calls.length > 0) {
        const toolCalls: OpenAiToolCall[] = calls.map((p, j) => ({
          id: callId(i, j, p.functionCall.name),
          type: 'function' as const,
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          },
        }))
        lastIds = toolCalls.map((tc) => tc.id)
        lastNames = calls.map((p) => p.functionCall.name)
        messages.push({
          role: 'assistant',
          content: texts || null,
          tool_calls: toolCalls,
        })
      } else if (texts) {
        messages.push({ role: 'assistant', content: texts })
        lastIds = []
        lastNames = []
      }
      continue
    }

    if (c.role === 'function') {
      const responses = c.parts.filter(isFunctionResponsePart)
      // Match each functionResponse to the corresponding lastIds entry.
      // Prefer name-matching when possible, otherwise positional.
      const used = new Set<number>()
      for (const r of responses) {
        let matchIdx = lastNames.findIndex(
          (n, k) => n === r.functionResponse.name && !used.has(k)
        )
        if (matchIdx === -1) {
          // positional fallback
          matchIdx = lastIds.findIndex((_, k) => !used.has(k))
        }
        if (matchIdx === -1) continue
        used.add(matchIdx)
        messages.push({
          role: 'tool',
          tool_call_id: lastIds[matchIdx] ?? callId(i, matchIdx, r.functionResponse.name),
          content: safeJsonStringify(r.functionResponse.response),
        })
      }
      // After consuming, clear so the next assistant turn restarts the mapping.
      lastIds = []
      lastNames = []
      continue
    }
  }

  return messages
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? {})
  } catch {
    return '{"error":"unserialisable tool response"}'
  }
}

// ─── OpenAI → Gemini: response ───────────────────────────────────────

/**
 * Wrap an OpenAI chat-completions response in Gemini's shape so the agent
 * loop can consume it without branching. Tool calls become functionCall
 * parts; arguments JSON strings are parsed back into objects.
 */
export function openAiResponseToGemini(resp: OpenAiChatResponse): GeminiResponse {
  const choice = resp.choices?.[0]
  if (!choice?.message) {
    return { candidates: [{ finishReason: 'STOP' }] }
  }

  const parts: GeminiPart[] = []
  const msg = choice.message

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {}
      try {
        args = tc.function?.arguments
          ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
          : {}
      } catch {
        args = { _raw: tc.function?.arguments ?? '' }
      }
      parts.push({
        functionCall: { name: tc.function?.name ?? 'unknown', args },
      })
    }
  }

  if (typeof msg.content === 'string' && msg.content.trim()) {
    parts.push({ text: msg.content })
  }

  if (parts.length === 0) {
    parts.push({ text: '' })
  }

  const finishReason = normaliseFinishReason(choice.finish_reason)
  const usage = resp.usage
  const usageMetadata =
    usage && (usage.total_tokens || usage.prompt_tokens || usage.completion_tokens)
      ? {
          promptTokenCount: usage.prompt_tokens,
          candidatesTokenCount: usage.completion_tokens,
          totalTokenCount:
            usage.total_tokens ??
            (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
        }
      : undefined

  return {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason,
      },
    ],
    usageMetadata,
  }
}

function normaliseFinishReason(r: string | undefined): string | undefined {
  if (!r) return undefined
  switch (r) {
    case 'stop':
      return 'STOP'
    case 'length':
      return 'MAX_TOKENS'
    case 'tool_calls':
    case 'function_call':
      return 'STOP'
    case 'content_filter':
      return 'SAFETY'
    default:
      return r.toUpperCase()
  }
}
