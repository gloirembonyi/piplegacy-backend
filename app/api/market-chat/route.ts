import { runAgent, type AgentEvent } from '@/lib/agent/run'
import { mergeChatHistories, buildSessionMemoryBlock } from '@/lib/agent/conversation-memory'
import { loadConversation } from '@/lib/conversation-store'
import { getAiConfigStatus, isAiConfigured } from '@/lib/ai-config'
import { getGeminiApiKeys } from '@/lib/gemini'
import { inferSymbolFromMessage } from '@/lib/insights-symbols'
import { formatNetworkError, networkErrorStatus } from '@/lib/network-errors'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { consumePlanUsage, getPlanUsage, recordPlanTokens } from '@/lib/plan-usage'
import { ensureUserData } from '@/lib/user-store'
import { displaySymbolLabel, isValidSymbol, normalizeSymbol } from '@/lib/symbols'
import { parseChartState, type ChartStateSnapshot } from '@/lib/chart-state'
import {
  isValidChatMessage,
  parseChatHistory,
  parseChatImages,
  type ChatImage,
} from '@/lib/validation'

type ParsedInput = {
  mode: 'chart' | 'insights'
  symbol: string
  label: string
  chartResolution: string
  scope: string
  message: string
  history: { role: 'user' | 'assistant'; content: string }[]
  images: ChatImage[]
  chartState: ChartStateSnapshot | null
}

type ValidationError = { error: string; status: number }

function isValidationError(v: ParsedInput | ValidationError): v is ValidationError {
  return 'error' in v && typeof (v as ValidationError).error === 'string'
}

function parseInput(body: unknown): ParsedInput | ValidationError {
  if (typeof body !== 'object' || body === null) {
    return { error: 'Invalid request body', status: 400 }
  }
  const {
    symbol: rawSymbol,
    message,
    history,
    mode: rawMode,
    resolution: rawResolution,
    images: rawImages,
    scope: rawScope,
    chartState: rawChartState,
  } = body as Record<string, unknown>

  const mode: 'chart' | 'insights' = rawMode === 'insights' ? 'insights' : 'chart'

  if (!isValidChatMessage(message)) {
    return { error: 'Message is required (max 2000 characters).', status: 400 }
  }

  let symbol = normalizeSymbol(typeof rawSymbol === 'string' ? rawSymbol : '')

  if (mode === 'insights') {
    if (!symbol || symbol === 'GLOBAL') symbol = 'MARKET'
    if (symbol !== 'MARKET' && !isValidSymbol(symbol)) {
      return { error: 'Invalid symbol', status: 400 }
    }
    if (symbol === 'MARKET') {
      const inferred = inferSymbolFromMessage((message as string).trim())
      if (inferred && isValidSymbol(inferred)) symbol = inferred
    }
  } else {
    if (!symbol || !isValidSymbol(symbol)) {
      return { error: 'Invalid symbol', status: 400 }
    }
  }

  const chartResolution =
    typeof rawResolution === 'string' && rawResolution.length <= 4
      ? rawResolution
      : 'D'

  const chatHistory = parseChatHistory(history).map((h) => ({
    role: h.role,
    content: h.content,
  }))

  const label =
    mode === 'insights' && symbol === 'MARKET'
      ? 'Global markets'
      : displaySymbolLabel(symbol)

  const scope =
    typeof rawScope === 'string' && rawScope.length <= 120
      ? rawScope
      : mode === 'insights'
        ? `insights:${symbol}`
        : `chart:${symbol}`

  return {
    mode,
    symbol,
    label,
    chartResolution,
    scope,
    message: (message as string).trim(),
    history: chatHistory,
    images: parseChatImages(rawImages),
    chartState:
      mode === 'chart'
        ? parseChartState(rawChartState, symbol, chartResolution)
        : null,
  }
}

function statusFromAgentStatus(status: number): number {
  if (status === 429) return 429
  if (status === 503) return 503
  if (status === 422) return 422
  if (status === 504) return 504
  return 502
}

/**
 * @swagger
 * /api/market-chat:
 *   post:
 *     summary: Run the chat/chart agent loop (streams NDJSON events)
 *     description: >
 *       The core agent endpoint — resolves live grounding, runs the orchestrator/specialist
 *       pipeline, calls Gemini (DeepSeek fallback) with tool-calling, and streams every state
 *       change back as newline-delimited JSON events.
 *     tags: [Agent]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message, mode, symbol]
 *             properties:
 *               mode: { type: string, enum: [chart, insights] }
 *               symbol: { type: string }
 *               message: { type: string }
 *               history:
 *                 type: array
 *                 items: { type: object }
 *               images:
 *                 type: array
 *                 items: { type: object }
 *     responses:
 *       200:
 *         description: application/x-ndjson stream of agent events
 *       401:
 *         description: Unauthorized
 */
export async function POST(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const user = await ensureUserData(auth.email)

  try {
    const raw = await req.text()
    if (!raw.trim()) {
      return Response.json({ error: 'Empty request body' }, { status: 400 })
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsed = parseInput(body)
    if (isValidationError(parsed)) {
      return Response.json({ error: parsed.error }, { status: parsed.status })
    }

    const hourPeek = await getPlanUsage(auth.email, user.plan, 'marketChatHour')
    if (!hourPeek.ok) {
      return Response.json(
        {
          error: hourPeek.message ?? 'Chat limit reached. Try again later.',
          upgradeRequired: hourPeek.upgradeRequired,
        },
        { status: 429 }
      )
    }
    const dayPeek = await getPlanUsage(auth.email, user.plan, 'marketChatDay')
    if (!dayPeek.ok) {
      return Response.json(
        {
          error: dayPeek.message ?? 'Daily chat limit reached.',
          upgradeRequired: dayPeek.upgradeRequired,
        },
        { status: 429 }
      )
    }
    await consumePlanUsage(auth.email, user.plan, 'marketChatHour')
    await consumePlanUsage(auth.email, user.plan, 'marketChatDay')

    const geminiApiKeys = getGeminiApiKeys()
    const aiStatus = getAiConfigStatus()
    if (!isAiConfigured()) {
      return Response.json({ error: aiStatus.message }, { status: 503 })
    }

    const { mode, symbol, label, chartResolution, scope, message, history, images, chartState } = parsed
    const isFocused = mode === 'chart' || symbol !== 'MARKET'

    const storedConv = await loadConversation(auth.email, scope).catch(() => null)
    const mergedHistory = mergeChatHistories(history, storedConv?.messages ?? [])
    const sessionMemory = buildSessionMemoryBlock(storedConv?.messages ?? [])

    const agentUser = {
      name: auth.name,
      email: auth.email,
      plan: user.plan,
      preferences: user.preferences,
      watchlist: user.watchlist,
      favorites: user.favorites,
    }

    const wantsStream = req.headers
      .get('accept')
      ?.toLowerCase()
      .includes('application/x-ndjson')

    // ─── Streaming NDJSON branch ───────────────────────────────
    if (wantsStream) {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (obj: object) => {
            try {
              controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
            } catch {
              /* controller may already be closed */
            }
          }

          write({ type: 'open', symbol, label, resolution: chartResolution })

          try {
            const result = await runAgent({
              apiKeys: geminiApiKeys,
              mode,
              symbol: isFocused ? symbol : undefined,
              symbolLabel: label,
              resolution: mode === 'chart' ? chartResolution : undefined,
              message,
              history: mergedHistory,
              images,
              user: agentUser,
              sessionMemory,
              chartState,
              signal: req.signal,
              onEvent: (event: AgentEvent) => write(event),
            })

            if (result.ok) {
              if (result.tokensUsed > 0) {
                await recordPlanTokens(auth.email, result.tokensUsed)
              }
              write({
                type: 'done',
                symbol,
                label,
                resolution: chartResolution,
                model: result.model,
                iterations: result.iterations,
                trace: result.trace,
                response: result.response,
              })
            } else if (result.status === 499 || req.signal.aborted) {
              write({ type: 'done', symbol, label, status: 499 })
            } else {
              write({
                type: 'done',
                error: result.error,
                status: result.status,
                symbol,
                label,
                model: result.model,
                trace: result.trace,
              })
            }
          } catch (err) {
            if (req.signal.aborted) {
              write({ type: 'done', symbol, label, status: 499 })
            } else {
              const error = formatNetworkError(err, 'Market Agent')
              const status = networkErrorStatus(err)
              write({ type: 'error', status, error })
              write({ type: 'done', error, status, symbol, label })
            }
          } finally {
            controller.close()
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    // ─── Legacy one-shot JSON branch ───────────────────────────
    const result = await runAgent({
      apiKeys: geminiApiKeys,
      mode,
      symbol: isFocused ? symbol : undefined,
      symbolLabel: label,
      resolution: mode === 'chart' ? chartResolution : undefined,
      message,
      history: mergedHistory,
      images,
      user: agentUser,
      sessionMemory,
      chartState,
      signal: req.signal,
    })

    if (!result.ok) {
      return Response.json(
        { error: result.error, trace: result.trace, model: result.model },
        { status: statusFromAgentStatus(result.status) }
      )
    }

    if (result.tokensUsed > 0) {
      await recordPlanTokens(auth.email, result.tokensUsed)
    }

    return Response.json({
      ...result.response,
      symbol,
      label,
      resolution: chartResolution,
      model: result.model,
      iterations: result.iterations,
      trace: result.trace,
    })
  } catch (error) {
    console.error('[market-chat] error:', error)
    const message = formatNetworkError(error, 'Market Agent')
    return Response.json(
      { error: message },
      { status: networkErrorStatus(error) }
    )
  }
}
