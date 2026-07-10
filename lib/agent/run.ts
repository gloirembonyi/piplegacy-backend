/**
 * Agent loop - runs Gemini in multi-iteration function-calling mode.
 *
 * Flow:
 *   user message + system prompt + tool declarations
 *   ↓
 *   Gemini responds with either (a) a function call, or (b) final text
 *   ↓
 *   if function call: execute it, append functionResponse, loop
 *   ↓
 *   if final text: parse as MarketChatResponse, return
 *
 * Hard limits (free tier safety):
 *   - max 6 tool calls per turn
 *   - max 8 model round-trips per turn
 *   - 45s soft timeout on the whole agent run
 */

import {
  GEMINI_CHAT_MODEL,
  getGeminiAgentModels,
  getGeminiGenerateUrl,
} from '@/lib/gemini'
import {
  DEEPSEEK_CHAT_MODEL,
  DEEPSEEK_CHAT_MODEL_FALLBACKS,
} from '@/lib/deepseek'
import {
  getActiveKeys,
  markFailure,
  markSuccess,
  msUntilNextReady,
  poolExhaustedMessage,
  waitForPoolRecovery,
  type AiProvider,
} from '@/lib/gemini-keypool'
import { callDeepseek } from '@/lib/deepseek-client'
import { recordAiKeyUsageFromResponse, recordAiKeyRequestFailed } from '@/lib/ai-usage-tracker'
import { parseProviderErrorBody, recordAdminError } from '@/lib/admin-error-log'
import {
  getToolByName,
  makeToolContext,
  toolDeclarationsForGemini,
} from '@/lib/ai-tools/registry'
import type { ToolContext, ToolTraceEntry } from '@/lib/ai-tools/types'
import {
  parseMarketChatJson,
  repairEmptyMarketChatReply,
  type MarketChatResponse,
} from '@/lib/parse-market-chat-json'
import {
  buildAgentSystemPrompt,
  buildAgentContextHeader,
} from '@/lib/agent/trading-knowledge'
import { buildChartStatePromptBlock, type ChartStateSnapshot } from '@/lib/chart-state'
import {
  fetchLiveGrounding,
  renderGroundingForPrompt,
  type LiveGrounding,
} from '@/lib/agent/live-grounding'
import {
  planAgentTask,
  prefetchRecommendedGaps,
  reflectOnResponse,
  renderPlanForPrompt,
  renderReflectionPrompt,
  renderSubAgentBriefs,
  renderUnderstandingForPrompt,
  renderUserContextForPrompt,
  runSubAgentsParallel,
  type AgentPlan,
  type AgentUserContext,
  type SubAgentBrief,
} from '@/lib/agent/orchestrator'
import { buildSessionMemoryBlock } from '@/lib/agent/conversation-memory'
import { renderUndercoverPromptBlock, sanitizePublicReply } from '@/lib/agent/orchestrator/defense'
import { sanitizeAgentErrorForUser } from '@/lib/agent-user-facing'
import { guardToolCall } from '@/lib/agent/orchestrator/tool-guards'
import {
  mergePipelineIntoChatResponse,
  buildChartStateLevelsChatResponse,
  canUsePipelineLevelsFastPath,
  filterSubAgentsAfterPipeline,
  isDirectLevelsQuestion,
  renderPipelineToolPlanForMainAgent,
  resolutionToTimeframe,
  PIPELINE_COVERED_TOOLS,
  renderPipelineBriefForPrompt,
  shouldRunSpecialistPipeline,
  runChatSpecialistPipeline,
  type PipelineBridgeEmit,
} from '@/lib/agent/orchestrator/pipeline-bridge'
import { runSetupCritic } from '@/lib/agent/orchestrator/critic'
import type { PipelineResult } from '@/lib/agent/pipeline-types'
import { formatNetworkError, isNetworkError, networkErrorStatus } from '@/lib/network-errors'
import {
  artifactFromToolResult,
  attachCapabilitiesToResponse,
  type AgentArtifact,
} from '@/lib/agent/artifacts'
import { formatMarketChatReply } from '@/lib/agent/format-reply-agent.server'
import { exponentialBackoffMs, sleepMs } from '@/lib/ai-retry'
import { buildEmergencyMarketResponse } from '@/lib/agent/emergency-finish'
import {
  runConversationalGeminiResponse,
  type ConversationalInput,
} from '@/lib/agent/conversational-gemini'
import { synthesizePipelineReplyWithGemini } from '@/lib/agent/pipeline-reply-gemini'
import { buildGeneralReplyFromResearch } from '@/lib/agent/general-fallback'
import {
  buildEvidenceFallbackResponse,
  buildLiquidityPoolChatResponse,
  isGenericOrEmptyReply,
  resolveEvidenceFallback,
  shouldUseLiquidityFastPath,
  shouldUseScoutFastPath,
  shouldUseScoutSetupSynthesis,
} from '@/lib/agent/evidence-fallback'
import {
  isStaticSetupTemplateReply,
  needsSetupReplyPolish,
} from '@/lib/setup-reply-format'
import {
  startRunAudit,
  clearCurrentRunAudit,
  getCurrentRunAudit,
  setRunAiCallEmit,
  type AgentRunAudit,
} from '@/lib/agent/run-audit'
import { withAiCallSlot } from '@/lib/ai-call-limiter'

/** Live progress event the agent emits while it runs. */
export type AgentEvent =
  | { type: 'thinking'; iteration: number }
  | {
      type: 'planning'
      intent: string
      subAgents: string[]
      progressSteps: string[]
      taskTags?: string[]
      effort?: 'light' | 'standard' | 'deep'
    }
  | { type: 'sub_agent_start'; agent: string }
  | { type: 'sub_agent_done'; agent: string; ok: boolean; summary: string; durationMs: number }
  | { type: 'confluence_start'; agent?: string }
  | {
      type: 'confluence'
      score: number
      bias: string
      blockers?: string[]
      specialistCount?: number
    }
  | { type: 'reflecting'; passed: boolean; issues?: string[] }
  | { type: 'grounding'; grounding: LiveGrounding; durationMs: number }
  | {
      type: 'tool_call'
      tool: string
      args: Record<string, unknown>
      callId: string
    }
  | {
      type: 'tool_result'
      tool: string
      ok: boolean
      summary?: string
      error?: string
      durationMs: number
      callId: string
      /** Chart MCP / TradingView tool payload for live client-side drawing. */
      payload?: Record<string, unknown>
    }
  | { type: 'model'; model: string }
  | { type: 'ai_call'; source: string; label: string; model: string; tokens: number }
  | { type: 'pool_wait'; seconds: number; attempt: number; message?: string }
  | { type: 'emergency_finish'; reason: string }
  | { type: 'final'; response: MarketChatResponse; iterations: number; reflectionPassed?: boolean; audit?: AgentRunAudit }
  | { type: 'ask_user'; question: string; options?: string[] }
  | { type: 'error'; status: number; error: string }

const RETRYABLE_STATUSES = new Set([429, 502, 503])
const MAX_TOOL_CALLS = 12
const MAX_ROUNDTRIPS = 12
/** Long specialist runs - capped below Vercel `market-chat` maxDuration (120s). */
const AGENT_TIMEOUT_MS = 110_000
const MAX_POOL_WAIT_RETRIES = 30
const STALL_PROGRESS_MS = 45_000
const EMERGENCY_RESERVE_MS = 18_000
const POOL_WAIT_CAP_MS = 90_000

function isPoolExhaustedStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 402
}

async function polishSetupReplyIfNeeded(
  response: MarketChatResponse,
  ctx: {
    userMessage: string
    symbolLabel: string
    plan: AgentPlan
    grounding: LiveGrounding
    pipeline?: PipelineResult | null
    subAgentBriefs?: SubAgentBrief[]
    chartState?: ChartStateSnapshot | null
    userEmail?: string
  }
): Promise<MarketChatResponse> {
  const hasEvidence =
    (ctx.subAgentBriefs?.length ?? 0) > 0 || Boolean(ctx.pipeline?.reports?.length)
  if (!hasEvidence) return response
  if (!needsSetupReplyPolish(response.reply, ctx.plan.intent, ctx.userMessage)) {
    return response
  }

  const polished = await synthesizePipelineReplyWithGemini({
    draft: response,
    userMessage: ctx.userMessage,
    symbolLabel: ctx.symbolLabel,
    plan: ctx.plan,
    grounding: ctx.grounding,
    pipeline: ctx.pipeline ?? null,
    subAgentBriefs: ctx.subAgentBriefs,
    chartState: ctx.chartState,
    userEmail: ctx.userEmail,
  })

  if (
    !isGenericOrEmptyReply(polished.reply) &&
    !isStaticSetupTemplateReply(polished.reply)
  ) {
    return polished
  }
  return response
}

function providersForRun(geminiKeys: string[], deepseekKeys: string[]): AiProvider[] {
  const out: AiProvider[] = []
  if (geminiKeys.length > 0) out.push('gemini')
  if (deepseekKeys.length > 0) out.push('deepseek')
  return out
}

export type AgentChatTurn = {
  role: 'user' | 'assistant'
  content: string
}

export type AgentImageInput = {
  /** "image/png" | "image/jpeg" | "image/webp" */
  mimeType: string
  /** Pure base64 (no `data:...;base64,` prefix). */
  data: string
}

export type AgentRunInput = {
  /** Primary key for backwards compat; if absent we use `apiKeys`. */
  apiKey?: string
  /** Pool of keys to rotate / fail over across (preferred). */
  apiKeys?: string[]
  mode: 'chart' | 'insights'
  symbol?: string
  symbolLabel?: string
  resolution?: string
  message: string
  history: AgentChatTurn[]
  /** Optional user-attached images (max ~3). */
  images?: AgentImageInput[]
  /** Logged-in user profile for personalized answers. */
  user?: AgentUserContext
  /** Extra session memory from persisted conversation (server-side). */
  sessionMemory?: string
  /** Live chart canvas snapshot (drawings + active setup). */
  chartState?: ChartStateSnapshot | null
  /** Optional callback invoked with each AgentEvent as the loop progresses. */
  onEvent?: (event: AgentEvent) => void
  /** When aborted (client disconnect / user stop), exit gracefully. */
  signal?: AbortSignal
}

export type AgentRunOutput =
  | {
      ok: true
      response: MarketChatResponse
      trace: ToolTraceEntry[]
      model: string
      iterations: number
      tokensUsed: number
      audit?: AgentRunAudit
    }
  | {
      ok: false
      status: number
      error: string
      trace: ToolTraceEntry[]
      model: string
      tokensUsed: number
      audit?: AgentRunAudit
    }

// ─── Gemini wire-format types ──────────────────────────────────

type GeminiTextPart = { text: string }
type GeminiFunctionCallPart = {
  functionCall: { name: string; args?: Record<string, unknown> }
}
type GeminiFunctionResponsePart = {
  functionResponse: { name: string; response: Record<string, unknown> }
}
type GeminiInlineDataPart = {
  inline_data: { mime_type: string; data: string }
}
type GeminiPart =
  | GeminiTextPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart
  | GeminiInlineDataPart

type GeminiContent = {
  role: 'user' | 'model' | 'function'
  parts: GeminiPart[]
}

type GeminiCandidate = {
  content?: GeminiContent
  finishReason?: string
}

type GeminiResponse = {
  candidates?: GeminiCandidate[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

function isFunctionCallPart(p: GeminiPart): p is GeminiFunctionCallPart {
  return (p as GeminiFunctionCallPart).functionCall !== undefined
}

function isTextPart(p: GeminiPart): p is GeminiTextPart {
  return typeof (p as GeminiTextPart).text === 'string'
}

async function callGemini(
  apiKey: string,
  model: string,
  body: object
): Promise<
  | { ok: true; data: GeminiResponse }
  | { ok: false; status: number; body: string; retryAfter: string | null }
> {
  try {
    const res = await withAiCallSlot(() =>
      fetch(getGeminiGenerateUrl(model), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      })
    )
    if (res.ok) {
      const data = (await res.json()) as GeminiResponse
      return { ok: true, data }
    }
    return {
      ok: false,
      status: res.status,
      body: await res.text(),
      retryAfter: res.headers.get('retry-after'),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'fetch failed'
    return {
      ok: false,
      status: 503,
      body: msg,
      retryAfter: null,
    }
  }
}

type ProviderCallResult =
  | { ok: true; data: GeminiResponse }
  | { ok: false; status: number; body: string; retryAfter: string | null }

async function callProvider(
  provider: 'gemini' | 'deepseek',
  apiKey: string,
  model: string,
  body: object
): Promise<ProviderCallResult> {
  if (provider === 'deepseek') {
    return callDeepseek(apiKey, model, body as Parameters<typeof callDeepseek>[2])
  }
  return callGemini(apiKey, model, body)
}

/**
 * Try every (provider × key × model) combination until one succeeds. Uses
 * the stateful key pool so 429'd keys are marked cooling and skipped
 * instantly on the next iteration / future request.
 *
 * Provider order: Gemini (primary) → DeepSeek (fallback). DeepSeek is only
 * attempted when at least one Gemini call has already failed AND DeepSeek
 * has a configured key.
 *
 * - On 401/403:        mark key cooling for the full session, switch keys.
 * - On 429:            mark key cooling using Retry-After or 60s default, switch keys.
 * - On 503/502:        brief same-key retry (server overload), then switch model.
 * - On 404:            switch to next model (model not enabled for this key).
 * - Any other 4xx/5xx: surface immediately (non-retryable).
 */
async function callAiWithFallback(
  geminiKeys: string[],
  geminiModels: string[],
  deepseekKeys: string[],
  deepseekModels: string[],
  body: object,
  onModelSwitch?: (info: { model: string; provider: string; keyIdx: number; total: number }) => void
): Promise<
  | {
      ok: true
      data: GeminiResponse
      model: string
      provider: 'gemini' | 'deepseek'
      keyIndex: number
      keySuffix: string
    }
  | {
      ok: false
      status: number
      body: string
      model: string
      provider: 'gemini' | 'deepseek'
      keyIndex: number
      keySuffix: string
    }
> {
  let lastStatus = 502
  let lastBody = ''
  let lastModel = geminiModels[0] ?? GEMINI_CHAT_MODEL
  let lastProvider: 'gemini' | 'deepseek' = 'gemini'
  let lastKeyIdx = 0
  let lastKeySuffix = '????'

  type Stage = {
    provider: 'gemini' | 'deepseek'
    keys: string[]
    models: string[]
  }
  const stages: Stage[] = []
  if (geminiKeys.length > 0) {
    stages.push({ provider: 'gemini', keys: geminiKeys, models: geminiModels })
  }
  if (deepseekKeys.length > 0) {
    stages.push({
      provider: 'deepseek',
      keys: deepseekKeys,
      models: deepseekModels,
    })
  }

  for (const stage of stages) {
    for (let keyIdx = 0; keyIdx < stage.keys.length; keyIdx++) {
      const apiKey = stage.keys[keyIdx]
      lastProvider = stage.provider
      lastKeyIdx = keyIdx
      lastKeySuffix = apiKey.slice(-4)
      if (keyIdx > 0 || stage.provider !== stages[0].provider) {
        onModelSwitch?.({
          model: `${stage.provider}:${stage.models[0] ?? '?'}`,
          provider: stage.provider,
          keyIdx,
          total: stage.keys.length,
        })
      }

      let keyExhausted = false
      let saw429OnKey = false
      for (const model of stage.models) {
        lastModel = model
        for (let attempt = 0; attempt < 2; attempt++) {
          const r = await callProvider(stage.provider, apiKey, model, body)
          if (r.ok) {
            markSuccess(apiKey, stage.provider)
            return {
              ok: true,
              data: r.data,
              model,
              provider: stage.provider,
              keyIndex: keyIdx,
              keySuffix: apiKey.slice(-4),
            }
          }
          lastStatus = r.status
          lastBody = r.body

          if (r.status === 401 || r.status === 402 || r.status === 403) {
            markFailure(apiKey, r.status, {
              retryAfter: r.retryAfter,
              body: r.body,
              provider: stage.provider,
            })
            keyExhausted = true
            break
          }
          // Per-model quota - try the next model on the same key before rotating keys.
          if (r.status === 429) {
            saw429OnKey = true
            break
          }
          if (r.status === 404) break

          // Bad request may be model/key-specific - try next model or key.
          if (r.status === 400) {
            markFailure(apiKey, r.status, {
              retryAfter: r.retryAfter,
              body: r.body,
              provider: stage.provider,
            })
            break
          }

          if (RETRYABLE_STATUSES.has(r.status) && attempt === 0) {
            markFailure(apiKey, r.status, {
              retryAfter: r.retryAfter,
              body: r.body,
              provider: stage.provider,
            })
            await sleepMs(exponentialBackoffMs(attempt + 1, 500, 8_000))
            continue
          }
          if (!RETRYABLE_STATUSES.has(r.status)) {
            return {
              ok: false,
              status: r.status,
              body: r.body,
              model,
              provider: stage.provider,
              keyIndex: keyIdx,
              keySuffix: apiKey.slice(-4),
            }
          }
          markFailure(apiKey, r.status, {
            retryAfter: r.retryAfter,
            provider: stage.provider,
          })
          break
        }
        if (keyExhausted) break
      }
      if (!keyExhausted && saw429OnKey) {
        markFailure(apiKey, 429, {
          retryAfter: null,
          body: lastBody,
          provider: stage.provider,
        })
      }
    }
  }

  return {
    ok: false,
    status: lastStatus,
    body: lastBody,
    model: lastModel,
    provider: lastProvider,
    keyIndex: lastKeyIdx,
    keySuffix: lastKeySuffix,
  }
}

/** Retry AI calls through pool recovery windows instead of failing immediately. */
async function callAiWithPoolRetry(
  opts: {
    geminiKeys: string[]
    geminiModels: string[]
    deepseekKeys: string[]
    deepseekModels: string[]
    body: object
    deadline: number
    signal?: AbortSignal
    emit: (event: AgentEvent) => void
    onModelSwitch?: (info: { model: string; provider: string; keyIdx: number; total: number }) => void
  }
): Promise<
  | {
      ok: true
      data: GeminiResponse
      model: string
      provider: 'gemini' | 'deepseek'
      keyIndex: number
      keySuffix: string
    }
  | {
      ok: false
      status: number
      body: string
      model: string
      provider: 'gemini' | 'deepseek'
      keyIndex: number
      keySuffix: string
    }
> {
  const providers = providersForRun(opts.geminiKeys, opts.deepseekKeys)
  let poolWaits = 0

  while (true) {
    if (opts.signal?.aborted) {
      return {
        ok: false,
        status: 499,
        body: 'Stopped by user',
        model: '',
        provider: 'gemini' as const,
        keyIndex: 0,
        keySuffix: '????',
      }
    }

    const freshGemini =
      opts.geminiKeys.length > 0 ? getActiveKeys('gemini') : []
    const freshDeepseek =
      opts.deepseekKeys.length > 0 ? getActiveKeys('deepseek') : []
    const activeGemini = freshGemini.length > 0 ? freshGemini : opts.geminiKeys
    const activeDeepseek = freshDeepseek.length > 0 ? freshDeepseek : opts.deepseekKeys

    const result = await callAiWithFallback(
      activeGemini,
      opts.geminiModels,
      activeDeepseek,
      opts.deepseekModels,
      opts.body,
      opts.onModelSwitch
    )

    if (result.ok) return result

    const canWait =
      isPoolExhaustedStatus(result.status) &&
      poolWaits < MAX_POOL_WAIT_RETRIES &&
      Date.now() < opts.deadline - 2_000

    const waitMs = msUntilNextReady(providers)

    // Keys already available - retry immediately without burning a wait slot.
    if (canWait && waitMs === 0) {
      poolWaits++
      continue
    }

    if (!canWait) {
      // Last-chance short wait when a key is about to recover.
      if (
        isPoolExhaustedStatus(result.status) &&
        waitMs != null &&
        waitMs > 0 &&
        waitMs <= 25_000
      ) {
        opts.emit({
          type: 'pool_wait',
          seconds: Math.min(90, Math.max(1, Math.ceil(waitMs / 1000))),
          attempt: poolWaits + 1,
          message: poolExhaustedMessage(providers),
        })
        const recovered = await waitForPoolRecovery(providers, {
          maxWaitMs: Math.min(waitMs + 2_000, 25_000),
          signal: opts.signal,
        })
        if (recovered) {
          poolWaits++
          continue
        }
      }
      return result
    }

    if (waitMs == null) return result

    poolWaits++
    const secs = Math.min(90, Math.max(1, Math.ceil((waitMs + 300) / 1000)))
    opts.emit({
      type: 'pool_wait',
      seconds: secs,
      attempt: poolWaits,
      message: poolExhaustedMessage(providers),
    })

    const remaining = opts.deadline - Date.now() - 1_500
    const recovered = await waitForPoolRecovery(providers, {
      maxWaitMs: Math.min(
        Math.max(waitMs + 2_500, 4_000),
        POOL_WAIT_CAP_MS,
        Math.max(remaining, 0)
      ),
      signal: opts.signal,
      onTick: (s) =>
        opts.emit({
          type: 'pool_wait',
          seconds: s,
          attempt: poolWaits,
          message: poolExhaustedMessage(providers),
        }),
    })

    if (!recovered) {
      if (opts.signal?.aborted) {
        return { ...result, status: 499, body: 'Stopped by user' }
      }
      // Keep looping while budget remains - do not fail on a single short wait.
      if (Date.now() < opts.deadline - 2_000 && poolWaits < MAX_POOL_WAIT_RETRIES) {
        continue
      }
      return result
    }
  }
}

function buildInitialContents(
  input: AgentRunInput,
  groundingText: string,
  orchestratorContext?: string
): GeminiContent[] {
  const header = buildAgentContextHeader({
    symbol: input.symbol,
    symbolLabel: input.symbolLabel,
    resolution: input.resolution,
    mode: input.mode,
    user: input.user,
  })

  const chartBlock =
    input.mode === 'chart'
      ? buildChartStatePromptBlock(input.chartState)
      : ''

  const contextBlocks = [header, groundingText]
  if (chartBlock) contextBlocks.push(chartBlock)
  if (orchestratorContext) contextBlocks.push(orchestratorContext)

  const firstTurn = contextBlocks.join('\n\n')

  const contents: GeminiContent[] = [
    { role: 'user', parts: [{ text: firstTurn }] },
    {
      role: 'model',
      parts: [
        {
          text: 'Acknowledged. Live grounding and manager plan noted. I will answer the self-questions internally, use sub-agent briefs when present, call tools only for gaps, then return strict JSON.',
        },
      ],
    },
  ]

  for (const turn of input.history.slice(-10)) {
    contents.push({
      role: turn.role === 'user' ? 'user' : 'model',
      parts: [{ text: turn.content.slice(0, 1500) }],
    })
  }

  // Final user turn - message text + optional attached images for multimodal
  // reasoning. Gemini 2.5-flash accepts inline_data parts inline with text.
  const finalParts: GeminiPart[] = []
  if (input.images && input.images.length > 0) {
    const chartNote = input.chartState?.drawingCount
      ? `\n(Live chart has ${input.chartState.drawingCount} drawing(s)${input.chartState.hasTradeSetup ? ` including active ${input.chartState.activeSetup?.side} setup @ ${input.chartState.activeSetup?.entry}` : ''} - cross-check image with canvas state in context header.)`
      : ''
    const noteLines = [
      input.message,
      '',
      `(${input.images.length} attached image${input.images.length > 1 ? 's' : ''} - analyze visually together with live chart canvas state + tools. Identify patterns, S/R, trendlines, candle structure. Combine with grounding + tool data before answering.)${chartNote}`,
    ]
    finalParts.push({ text: noteLines.join('\n') })
    for (const img of input.images) {
      finalParts.push({ inline_data: { mime_type: img.mimeType, data: img.data } })
    }
  } else {
    finalParts.push({ text: input.message })
  }
  contents.push({ role: 'user', parts: finalParts })
  return contents
}

async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  emit: (event: AgentEvent) => void,
  callId: string,
  guardCtx: { plan: AgentPlan; grounding: LiveGrounding },
  artifactsOut?: AgentArtifact[]
): Promise<Record<string, unknown>> {
  const guarded = guardToolCall({
    name,
    args,
    plan: guardCtx.plan,
    grounding: guardCtx.grounding,
    trace: ctx.trace,
  })
  if (!guarded.ok) {
    ctx.trace.push({
      tool: name,
      args,
      ok: false,
      durationMs: 0,
      error: guarded.error,
    })
    void import('@/lib/tool-usage-tracker').then(({ recordToolCall }) => recordToolCall(name, false))
    emit({
      type: 'tool_result',
      tool: name,
      ok: false,
      error: guarded.error,
      durationMs: 0,
      callId,
    })
    return { error: guarded.error }
  }
  args = guarded.args

  const tool = getToolByName(name)
  if (!tool) {
    ctx.trace.push({
      tool: name,
      args,
      ok: false,
      durationMs: 0,
      error: 'Unknown tool',
    })
    emit({
      type: 'tool_result',
      tool: name,
      ok: false,
      error: 'Unknown tool',
      durationMs: 0,
      callId,
    })
    return { error: `Unknown tool: ${name}` }
  }
  const beforeLen = ctx.trace.length
  try {
    const result = await tool.execute(args, ctx)
    const entry = ctx.trace[ctx.trace.length - 1]
    const payload = chartToolStreamPayload(name, result)
    if (entry && ctx.trace.length > beforeLen) {
      emit({
        type: 'tool_result',
        tool: name,
        ok: entry.ok,
        summary: entry.summary,
        error: entry.error,
        durationMs: entry.durationMs,
        callId,
        payload,
      })
    }
    if (result && typeof result === 'object') {
      const record = result as Record<string, unknown>
      if (artifactsOut) {
        artifactsOut.push(...artifactFromToolResult(name, record))
      }
      if (name === 'agent_ask_user') {
        const q = result as { question?: string; options?: string[] }
        if (q.question) {
          emit({ type: 'ask_user', question: q.question, options: q.options })
        }
      }
      return record
    }
    return { value: result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emit({
      type: 'tool_result',
      tool: name,
      ok: false,
      error: msg,
      durationMs: 0,
      callId,
    })
    return { error: msg }
  }
}

/** Pass drawing payloads to the client stream for immediate chart updates. */
function chartToolStreamPayload(
  name: string,
  result: unknown
): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return undefined
  const r = result as Record<string, unknown>
  if (name === 'chart_mcp_draw_setup' && Array.isArray(r.drawings)) {
    return {
      drawings: r.drawings,
      setup: r.setup,
      levels: r.levels,
    }
  }
  if (name === 'chart_mcp_clear' && r.cleared === true) {
    return { cleared: true }
  }
  if (name === 'tradingview_draw_setup' && r.ok === true) {
    return { tradingView: true, setup: r.setup, levels: r.levels }
  }
  return undefined
}

/** Fallback if the model returns malformed JSON in the final turn. */
function parseMtfTraceSummary(
  summary?: string
): { alignment?: string; recommendation?: string } | undefined {
  if (!summary) return undefined
  const alignment = summary.match(/\b(strong|partial|mixed|conflicting)\b/i)?.[1]?.toLowerCase()
  const recommendation = summary.match(/→\s*(BUY|SELL|WAIT|NEUTRAL)\b/i)?.[1]
  if (!alignment && !recommendation) return undefined
  return { alignment, recommendation }
}

function parseTradeContextTraceSummary(
  summary?: string
): { action?: string } | undefined {
  if (!summary) return undefined
  const action = summary.match(/→\s*(GO_BUY|GO_SELL|WAIT|NEUTRAL)\b/i)?.[1]
  if (!action) return undefined
  return { action }
}

/** Fallback if the model returns malformed JSON in the final turn. */
function safeParseFinal(text: string): MarketChatResponse {
  const parsed = parseMarketChatJson(text)
  const repaired = repairEmptyMarketChatReply(parsed)
  if (repaired.reply && !repaired.reply.includes('could not generate')) {
    return {
      ...repaired,
      reply: sanitizePublicReply(repaired.reply),
    }
  }
  if (parsed.setup || parsed.levels.length > 0) {
    return {
      ...repaired,
      reply: sanitizePublicReply(repaired.reply),
    }
  }
  return finalizeParsedResponseFromRaw(text)
}

function finalizeParsedResponseFromRaw(text: string): MarketChatResponse {
  const raw = text.trim() || 'Empty response.'
  return {
    reply: sanitizePublicReply(raw),
    setup: null,
    levels: [],
    zones: [],
    drawIntent: null,
  }
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  try {
    const result = await runAgentInner(input)
    void import('@/lib/tool-usage-tracker').then(({ recordAgentRun }) =>
      recordAgentRun('main_agent', result.ok)
    )
    if (!result.ok && result.status !== 499) {
      void recordAdminError({
        kind: 'agent',
        target: 'main_agent',
        status: result.status,
        message: result.error ?? `Agent failed (${result.status})`,
        userEmail: input.user?.email,
        model: result.model || undefined,
        detail: result.trace.length
          ? `Tools: ${result.trace.map((t) => `${t.tool}${t.ok ? '' : ' (fail)'}`).join(', ').slice(0, 200)}`
          : undefined,
      })
    }
    return result
  } catch (err) {
    void import('@/lib/tool-usage-tracker').then(({ recordAgentRun }) =>
      recordAgentRun('main_agent', false)
    )
    void recordAdminError({
      kind: 'agent',
      target: 'main_agent',
      message: err instanceof Error ? err.message : 'Agent crashed',
      userEmail: input.user?.email,
    })
    if ((err as Error).name === 'AbortError' || input.signal?.aborted) {
      return {
        ok: false,
        status: 499,
        error: 'Stopped by user',
        trace: [],
        model: '',
        tokensUsed: 0,
      }
    }
    throw err
  }
}

async function runAgentInner(input: AgentRunInput): Promise<AgentRunOutput> {
  const sessionKey =
    input.user?.email?.trim().toLowerCase() ||
    input.symbol?.trim().toUpperCase() ||
    'anonymous'
  const ctx = makeToolContext({
    defaultSymbol: input.symbol,
    defaultResolution: input.resolution,
    sessionKey,
    chartState: input.chartState ?? null,
  })
  const pipelineResultSlot: { current: PipelineResult | null } = { current: null }
  let lastProgressAt = Date.now()
  const emit = (event: AgentEvent) => {
    lastProgressAt = Date.now()
    try {
      input.onEvent?.(event)
    } catch {
      /* never let event handler crash the agent */
    }
  }
  const toolArtifacts: AgentArtifact[] = []

  // Resolve key pool through the STATEFUL pool - automatically excludes any
  // key currently cooling from a recent 429/503 and orders the rest by
  // least-recently-used so load spreads across all configured keys.
  // Falls back to caller-provided keys if the pool happens to be empty
  // (e.g., a direct invocation that bypasses env).
  let geminiKeys = getActiveKeys('gemini')
  if (geminiKeys.length === 0) {
    geminiKeys =
      input.apiKeys && input.apiKeys.length > 0
        ? input.apiKeys
        : input.apiKey
          ? [input.apiKey]
          : []
  }

  // DeepSeek pool - used automatically as a fallback when every Gemini key
  // is cooling AND DeepSeek has at least one configured key. Multimodal
  // (image) input still requires Gemini, so we only consult DeepSeek when
  // there are no images in the user message (deepseek-chat has no vision).
  const hasImages = !!input.images && input.images.length > 0
  const deepseekKeys = hasImages ? [] : getActiveKeys('deepseek')

  if (geminiKeys.length === 0 && deepseekKeys.length === 0) {
    const onVercel = Boolean(process.env.VERCEL)
    const error = hasImages
      ? onVercel
        ? 'Image analysis requires GEMINI_API_KEY in Vercel environment variables (DeepSeek cannot process images).'
        : 'No Gemini API key configured (DeepSeek cannot process images). Add GEMINI_API_KEY to .env.local.'
      : onVercel
        ? 'No AI configured. Add GEMINI_API_KEY and/or DEEPSEEK_API_KEY in Vercel → Settings → Environment Variables, then redeploy.'
        : 'No AI API key configured. Add GEMINI_API_KEY or DEEPSEEK_API_KEY to .env.local.'
    emit({ type: 'error', status: 503, error })
    return { ok: false, status: 503, error, trace: ctx.trace, model: '', tokensUsed: 0 }
  }

  // Pre-fetch live grounding in parallel BEFORE the first model call.
  const groundingStart = Date.now()
  const grounding = await fetchLiveGrounding({
    symbol: input.symbol,
    symbolLabel: input.symbolLabel,
  })
  const groundingMs = Date.now() - groundingStart
  emit({ type: 'grounding', grounding, durationMs: groundingMs })

  const groundingText = renderGroundingForPrompt(grounding)

  // ─── Manager: plan + parallel sub-agents ─────────────────────
  const plan = planAgentTask({
    message: input.message,
    mode: input.mode,
    symbol: input.symbol,
    symbolLabel: input.symbolLabel,
    resolution: input.resolution,
    user: input.user,
    grounding,
    chartState: input.chartState ?? null,
  })

  emit({
    type: 'planning',
    intent: plan.intent,
    subAgents: plan.subAgents,
    progressSteps: plan.progressSteps,
    taskTags: plan.taskTags,
    effort: plan.effort,
  })

  const runAudit = startRunAudit({
    userEmail: input.user?.email,
    symbol: input.symbol,
    message: input.message,
    intent: plan.intent,
  })
  setRunAiCallEmit((ev) => emit(ev))

  const finalizeAudit = (
    ok: boolean,
    model: string,
    iterations: number,
    totalTokens: number
  ): AgentRunAudit => {
    const audit = runAudit.finalize({
      ok,
      model,
      iterations,
      totalTokens,
      trace: ctx.trace,
    })
    clearCurrentRunAudit()
    return audit
  }

  const deadline = Date.now() + AGENT_TIMEOUT_MS
  ctx.grounding = grounding
  ctx.deadlineMs = deadline
  ctx.pipelineResultSlot = pipelineResultSlot
  ctx.onPipelineEvent = (event) => {
    if (
      typeof event === 'object' &&
      event &&
      'agent' in event &&
      typeof (event as { agent?: string }).agent === 'string' &&
      (event as { agent: string }).agent.startsWith('specialist:')
    ) {
      getCurrentRunAudit()?.recordSpecialist(
        (event as { agent: string }).agent.replace('specialist:', '')
      )
    }
    emit(event as AgentEvent)
  }

  let pipelineBriefText = ''
  let pipelineResult: PipelineResult | null = null
  let subAgentBriefs: SubAgentBrief[] = []

  const completeLevelsFastPath = async (
    fastResponse: MarketChatResponse,
    model: string,
    opts?: {
      skipSynthesis?: boolean
      drawFromSetup?: {
        entry: number | null
        stopLoss: number | null
        takeProfit: number | null
        timeframe: string
        bias: string
        invalidation: number | null
      }
      pipeline?: PipelineResult | null
      subAgentBriefs?: SubAgentBrief[]
    }
  ): Promise<AgentRunOutput> => {
    emit({ type: 'thinking', iteration: 0 })

    let response = fastResponse
    if (!opts?.skipSynthesis) {
      response = await synthesizePipelineReplyWithGemini({
        draft: fastResponse,
        userMessage: input.message,
        symbolLabel: input.symbolLabel ?? input.symbol ?? '',
        plan,
        grounding,
        pipeline: opts?.pipeline ?? pipelineResult,
        subAgentBriefs: opts?.subAgentBriefs ?? subAgentBriefs,
        chartState: input.chartState,
        userEmail: input.user?.email,
      })
    }

    response = await polishSetupReplyIfNeeded(response, {
      userMessage: input.message,
      symbolLabel: input.symbolLabel ?? input.symbol ?? '',
      plan,
      grounding,
      pipeline: opts?.pipeline ?? pipelineResult,
      subAgentBriefs: opts?.subAgentBriefs ?? subAgentBriefs,
      chartState: input.chartState,
      userEmail: input.user?.email,
    })

    response = await formatMarketChatReply(response, {
      intent: plan.intent,
      responseMode: plan.responseMode,
      taskTags: plan.taskTags,
      userEmail: input.user?.email,
      hasSetupCard: Boolean(response.setup),
      setup: response.setup ?? undefined,
      deterministicOnly: true,
    })
    if (response.reply) response.reply = sanitizePublicReply(response.reply)

    const drawFromSetup = opts?.drawFromSetup
    if (
      plan.allowToolCalls &&
      response.drawIntent &&
      response.setup &&
      input.symbol &&
      !input.chartState?.hasTradeSetup
    ) {
      const callId = 'fast-chart-draw'
      const drawArgs: Record<string, unknown> = {
        symbol: input.symbol,
        resolution: input.resolution ?? resolutionToTimeframe(drawFromSetup?.timeframe ?? '15m'),
        bias: response.setup.bias,
        entry: response.setup.entry,
        stopLoss: response.setup.stopLoss,
        takeProfit: response.setup.takeProfit,
        invalidation: response.setup.invalidation,
      }
      emit({ type: 'tool_call', tool: 'chart_mcp_draw_setup', args: drawArgs, callId })
      await executeToolCall(
        'chart_mcp_draw_setup',
        drawArgs,
        ctx,
        emit,
        callId,
        { plan, grounding },
        toolArtifacts
      )
    }

    const enriched = attachCapabilitiesToResponse(
      response,
      toolArtifacts,
      input.symbolLabel ?? input.symbol
    )
    const audit = finalizeAudit(true, model, 1, 0)
    emit({
      type: 'final',
      response: enriched,
      iterations: 1,
      reflectionPassed: true,
      audit,
    })
    return {
      ok: true,
      response: enriched,
      trace: ctx.trace,
      model,
      iterations: 1,
      tokensUsed: 0,
      audit,
    }
  }

  const convFastInput: ConversationalInput = {
    message: input.message,
    plan,
    symbolLabel: input.symbolLabel,
    symbol: input.symbol,
    grounding,
    userName: input.user?.name,
    userPlan: input.user?.plan,
    userEmail: input.user?.email,
  }

  if (plan.responseMode === 'conversational') {
    emit({ type: 'thinking', iteration: 0 })
    const conversational = await runConversationalGeminiResponse(convFastInput)
    const formatted = await formatMarketChatReply(conversational, {
      intent: plan.intent,
      responseMode: plan.responseMode,
      taskTags: plan.taskTags,
      userEmail: input.user?.email,
      deterministicOnly: true,
    })
    if (formatted.reply) formatted.reply = sanitizePublicReply(formatted.reply)
    const enriched = attachCapabilitiesToResponse(
      formatted,
      toolArtifacts,
      input.symbolLabel ?? input.symbol
    )
    const audit = finalizeAudit(true, 'gemini:conversational', 0, 0)
    emit({
      type: 'final',
      response: enriched,
      iterations: 0,
      reflectionPassed: true,
      audit,
    })
    return {
      ok: true,
      response: enriched,
      trace: ctx.trace,
      model: 'gemini:conversational',
      iterations: 0,
      tokensUsed: 0,
      audit,
    }
  }

  // Instant recall path: user explicitly asks what's ALREADY on the chart
  // ("what did I set again", "remind me", "on my chart") - safe to echo
  // verbatim. Any other "where are entry/stop/target" phrasing falls through
  // to fresh selective specialist analysis below instead of parroting stale
  // chart state (canUsePipelineLevelsFastPath now requires explicit recall
  // wording - see pipeline-bridge.ts).
  if (
    input.symbol &&
    input.mode === 'chart' &&
    input.chartState &&
    canUsePipelineLevelsFastPath(input.message, plan)
  ) {
    const chartResponse = buildChartStateLevelsChatResponse(input.chartState, {
      symbolLabel: input.symbolLabel ?? input.symbol,
      grounding,
    })
    if (chartResponse) {
      return completeLevelsFastPath(chartResponse, 'chart:levels-fast-path', {
        skipSynthesis: false,
        subAgentBriefs,
      })
    }
  }

  // Fresh selective specialist analysis for setup/reversal chat questions -
  // this is what replaces "echo whatever's already drawn" with a real,
  // re-run confluence read, and what lets the agent honestly answer
  // WAIT / no-valid-setup instead of always forcing entry/stop/target.
  let pipelineRanOk = false
  if (
    shouldRunSpecialistPipeline(plan, {
      symbol: input.symbol,
      undercover: plan.undercoverMode,
    })
  ) {
    const pipelineEmit: PipelineBridgeEmit = (event) => {
      ctx.onPipelineEvent?.(event)
    }
    const upfront = await runChatSpecialistPipeline({
      symbol: input.symbol!,
      symbolLabel: input.symbolLabel,
      resolution: input.resolution,
      grounding,
      deadlineMs: deadline,
      emit: pipelineEmit,
      plan,
    })
    if (upfront) {
      const critiqued = await runSetupCritic(upfront, { grounding })
      pipelineResult = critiqued
      pipelineResultSlot.current = critiqued
      pipelineBriefText = renderPipelineBriefForPrompt(critiqued)
      pipelineRanOk = critiqued.setup.confluenceScore >= 45
    }
  }

  let subAgentBriefText = ''
  const subAgentsToRun = filterSubAgentsAfterPipeline(plan.subAgents, {
    pipelineRanOk,
    message: input.message,
    plan,
  })

  const skipSubAgentsForDirectLevels =
    pipelineRanOk &&
    isDirectLevelsQuestion(input.message) &&
    !subAgentsToRun.some((id) => id === 'research' || id === 'macro')

  const effectiveSubAgents = skipSubAgentsForDirectLevels ? [] : subAgentsToRun

  if (!plan.skipPrefetch && effectiveSubAgents.length > 0) {
    for (const id of effectiveSubAgents) {
      emit({ type: 'sub_agent_start', agent: id })
    }
    const { briefs, trace: subTrace } = await runSubAgentsParallel(
      effectiveSubAgents,
      {
        message: input.message,
        mode: input.mode,
        symbol: input.symbol,
        symbolLabel: input.symbolLabel,
        resolution: input.resolution,
        user: input.user,
        grounding,
      },
      plan
    )
    let subToolIdx = 0
    for (const entry of subTrace) {
      const callId = `sub-${entry.tool}-${subToolIdx++}`
      emit({
        type: 'tool_call',
        tool: entry.tool,
        args: entry.args,
        callId,
      })
      emit({
        type: 'tool_result',
        tool: entry.tool,
        ok: entry.ok,
        summary: entry.summary,
        error: entry.error,
        durationMs: entry.durationMs,
        callId,
      })
      ctx.trace.push(entry)
    }
    for (const b of briefs) {
      emit({
        type: 'sub_agent_done',
        agent: b.id,
        ok: b.ok,
        summary: b.summary,
        durationMs: b.durationMs,
      })
    }
    subAgentBriefs = briefs
    subAgentBriefText = renderSubAgentBriefs(briefs)
  }

  // Gap-fill: skip only when chart already shows the levels user asked about.
  const skipGapPrefetch =
    isDirectLevelsQuestion(input.message) &&
    input.chartState?.hasTradeSetup === true

  if (plan.allowToolCalls && !skipGapPrefetch) {
    const { trace: gapTrace, summary: gapSummary } = await prefetchRecommendedGaps(
      plan,
      ctx.trace,
      {
        symbol: input.symbol,
        symbolLabel: input.symbolLabel,
        resolution: input.resolution,
        message: input.message,
        mode: input.mode,
      },
      ctx,
      pipelineRanOk ? { skipTools: PIPELINE_COVERED_TOOLS } : undefined
    )
    if (gapTrace.length > 0) {
      let gapIdx = 0
      for (const entry of gapTrace) {
        const callId = `gap-${entry.tool}-${gapIdx++}`
        emit({ type: 'tool_call', tool: entry.tool, args: entry.args, callId })
        emit({
          type: 'tool_result',
          tool: entry.tool,
          ok: entry.ok,
          summary: entry.summary,
          error: entry.error,
          durationMs: entry.durationMs,
          callId,
        })
      }
      if (gapSummary) {
        subAgentBriefText = [subAgentBriefText, gapSummary].filter(Boolean).join('\n\n')
      }
    }
  }

  // Liquidity pool questions - answer buy-side/sell-side levels, not a new trade setup.
  if (shouldUseLiquidityFastPath(plan, subAgentBriefs, hasImages, input.message)) {
    const draft = buildLiquidityPoolChatResponse({
      userMessage: input.message,
      symbolLabel: input.symbolLabel ?? input.symbol,
      grounding,
      plan,
      subAgentBriefs,
      chartState: input.chartState,
    })
    if (draft) {
      return completeLevelsFastPath(draft, 'scout:liquidity-pools', {
        skipSynthesis: false,
        subAgentBriefs,
      })
    }
  }

  // Scout fast path: scouts already fetched structure - one synthesis LLM call instead of
  // a multi-pass main loop that re-fetches the same tools.
  if (
    shouldUseScoutFastPath(plan, subAgentBriefs, hasImages, input.message, input.chartState) &&
    !input.chartState?.hasTradeSetup
  ) {
    const draft = buildEvidenceFallbackResponse({
      userMessage: input.message,
      symbolLabel: input.symbolLabel ?? input.symbol,
      grounding,
      plan,
      subAgentBriefs,
      chartState: input.chartState,
      minimalReply: true,
    })
    if (draft) {
      return completeLevelsFastPath(draft, 'scout:evidence-synthesis', {
        skipSynthesis: false,
        subAgentBriefs,
      })
    }
  }

  if (
    shouldUseScoutSetupSynthesis(
      plan,
      subAgentBriefs,
      hasImages,
      input.message,
      input.chartState
    )
  ) {
    const draft = buildEvidenceFallbackResponse({
      userMessage: input.message,
      symbolLabel: input.symbolLabel ?? input.symbol,
      grounding,
      plan,
      subAgentBriefs,
      chartState: input.chartState,
      minimalReply: true,
    })
    if (draft) {
      return completeLevelsFastPath(draft, 'scout:setup-synthesis', {
        skipSynthesis: false,
        subAgentBriefs,
      })
    }
  }

  const scoutsGatheredEvidence = subAgentBriefs.length > 0 || subAgentBriefText.length > 0

  const userContextText = renderUserContextForPrompt(input.user)
  const understandingText = renderUnderstandingForPrompt({
    summary: plan.questionSummary,
    responseMode: plan.responseMode,
    allowToolCalls: plan.allowToolCalls,
    allowPrefetch: !plan.skipPrefetch,
    reason: plan.routingNote,
    undercover: plan.undercoverMode,
  })
  const planText = renderPlanForPrompt(plan)
  const memoryText =
    input.sessionMemory?.trim() ||
    buildSessionMemoryBlock(
      input.history.map((h, i) => ({
        id: `h-${i}`,
        role: h.role,
        content: h.content,
        createdAt: '',
      }))
    )
  const defenseText = plan.undercoverMode
    ? renderUndercoverPromptBlock({
        kind: plan.threatKind ?? 'meta_extraction',
        undercover: true,
        severity: 'high',
        allowToolCalls: false,
        reason: plan.routingNote,
      })
    : ''
  const pipelineToolPlanText = renderPipelineToolPlanForMainAgent(
    ctx.trace.map((t) => t.tool),
    pipelineRanOk
  )

  const orchestratorContext = [
    defenseText,
    understandingText,
    userContextText,
    planText,
    pipelineToolPlanText,
    memoryText,
    pipelineBriefText,
    subAgentBriefText,
    scoutsGatheredEvidence
      ? [
          'SYNTHESIS MODE:',
          'Sub-agents already fetched structure, news, and macro data above.',
          'Do NOT re-call get_technical_analysis, get_intraday_candles, search_web, search_news, or get_economic_calendar.',
          'Return the FINAL JSON object in your next text response (reply + setup + levels + drawIntent).',
          'At most ONE chart_mcp_draw_setup if levels are new - otherwise zero tool calls.',
        ].join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const contents = buildInitialContents(input, groundingText, orchestratorContext)
  const systemPrompt = buildAgentSystemPrompt({
    symbol: input.symbol,
    verbosity: input.user?.preferences?.agentVerbosity,
  })

  const toolsPayload = plan.allowToolCalls
    ? {
        tools: toolDeclarationsForGemini(plan.allowedTools),
        toolConfig: { functionCallingConfig: { mode: 'AUTO' as const } },
      }
    : {
        toolConfig: { functionCallingConfig: { mode: 'NONE' as const } },
      }

  const baseBody = {
    systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
    ...toolsPayload,
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: 2048,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  }

  const geminiModels = getGeminiAgentModels()
  const deepseekModels = [
    DEEPSEEK_CHAT_MODEL,
    ...DEEPSEEK_CHAT_MODEL_FALLBACKS.filter((m) => m !== DEEPSEEK_CHAT_MODEL),
  ]

  let lastModel = geminiModels[0] ?? GEMINI_CHAT_MODEL
  let toolCallsExecuted = 0
  const scoutsRanForSetup =
    scoutsGatheredEvidence &&
    (plan.intent === 'setup' ||
      plan.intent === 'reversal' ||
      plan.taskTags.includes('levels'))
  const isSetupIntent = plan.intent === 'setup' || plan.intent === 'reversal'
  // Setup/reversal answers keep a real budget even after pipeline/scouts ran -
  // if the fresh evidence comes back thin or degraded, the model must still
  // be able to call a gap-filling tool instead of being forced to answer on
  // incomplete data.
  const toolCallBudget =
    pipelineRanOk && (plan.taskTags.includes('levels') || isSetupIntent)
      ? 4
      : scoutsRanForSetup
        ? 5
        : MAX_TOOL_CALLS
  let reflectionAttempts = 0
  let emptyResponseRetries = 0
  let totalTokens = 0
  const MAX_REFLECTION_ATTEMPTS = 2
  const MAX_EMPTY_RETRIES = 1
  const roundtripCap =
    pipelineRanOk && (plan.taskTags.includes('levels') || isSetupIntent)
      ? Math.min(MAX_ROUNDTRIPS, 4)
      : scoutsRanForSetup
        ? Math.min(MAX_ROUNDTRIPS, 5)
        : MAX_ROUNDTRIPS
  // A setup/reversal answer is exactly the case where a wrong or stale read
  // matters most - it must always get at least one reflection pass, not zero.
  const maxReflectionAttempts = isSetupIntent
    ? 1
    : scoutsGatheredEvidence
      ? 0
      : pipelineRanOk
        ? 1
        : MAX_REFLECTION_ATTEMPTS

  const finishEmergency = async (
    reason: string,
    iteration: number
  ): Promise<AgentRunOutput> => {
    emit({ type: 'emergency_finish', reason })

    const fallbackInput = {
      userMessage: input.message,
      symbolLabel: input.symbolLabel,
      grounding,
      plan,
      subAgentBriefs,
      chartState: input.chartState,
      reason,
    }

    let emergency =
      resolveEvidenceFallback(fallbackInput) ??
      buildEmergencyMarketResponse({
        userMessage: input.message,
        symbolLabel: input.symbolLabel,
        grounding,
        plan,
        reason,
        subAgentBriefs,
        pipelineResult: pipelineResult,
      })

    emergency = repairEmptyMarketChatReply(
      emergency,
      input.symbolLabel ?? input.symbol,
      input.message
    )

    if (subAgentBriefs.length > 0 || pipelineResult) {
      const polished = await polishSetupReplyIfNeeded(emergency, {
        userMessage: input.message,
        symbolLabel: input.symbolLabel ?? input.symbol ?? '',
        plan,
        grounding,
        pipeline: pipelineResult,
        subAgentBriefs,
        chartState: input.chartState,
        userEmail: input.user?.email,
      })
      if (!isGenericOrEmptyReply(polished.reply)) {
        emergency = polished
      }
    }

    const formatted = await formatMarketChatReply(emergency, {
      intent: plan.intent,
      responseMode: plan.responseMode,
      taskTags: plan.taskTags,
      userEmail: input.user?.email,
      deterministicOnly: true,
    })
    if (formatted.reply) {
      formatted.reply = sanitizePublicReply(formatted.reply)
    }
    const enriched = attachCapabilitiesToResponse(
      formatted,
      toolArtifacts,
      input.symbolLabel ?? input.symbol
    )
    const audit = finalizeAudit(true, lastModel, iteration + 1, totalTokens)
    emit({
      type: 'final',
      response: enriched,
      iterations: iteration + 1,
      reflectionPassed: false,
      audit,
    })
    return {
      ok: true,
      response: enriched,
      trace: ctx.trace,
      model: lastModel,
      iterations: iteration + 1,
      tokensUsed: totalTokens,
      audit,
    }
  }

  for (let iteration = 0; iteration < roundtripCap; iteration++) {
    if (!pipelineResult && pipelineResultSlot.current) {
      pipelineResult = pipelineResultSlot.current
      pipelineBriefText = renderPipelineBriefForPrompt(pipelineResult)
      pipelineRanOk = pipelineResult.setup.confluenceScore >= 45
    }

    if (input.signal?.aborted) {
      return {
        ok: false,
        status: 499,
        error: 'Stopped by user',
        trace: ctx.trace,
        model: lastModel,
        tokensUsed: totalTokens,
      }
    }

    if (Date.now() > deadline) {
      if (ctx.trace.length > 0 || pipelineBriefText || subAgentBriefText) {
        return finishEmergency('Time budget reached - partial analysis delivered', iteration)
      }
      emit({
        type: 'error',
        status: 504,
        error: 'Agent exceeded time budget. Try a more focused question.',
      })
      return {
        ok: false,
        status: 504,
        error: 'Agent exceeded time budget. Try a more focused question.',
        trace: ctx.trace,
        model: lastModel,
        tokensUsed: totalTokens,
      }
    }

    if (
      Date.now() - lastProgressAt > STALL_PROGRESS_MS &&
      Date.now() > deadline - EMERGENCY_RESERVE_MS &&
      (ctx.trace.length > 0 || pipelineBriefText || subAgentBriefText)
    ) {
      return finishEmergency('No progress - emergency summary from gathered data', iteration)
    }

    emit({ type: 'thinking', iteration })

    // Re-poll active keys each iteration - they may have recovered between
    // turns, and we want to take advantage of that as soon as possible.
    const freshGeminiKeys = geminiKeys.length > 0 ? getActiveKeys('gemini') : []
    const freshDeepseekKeys =
      deepseekKeys.length > 0 ? getActiveKeys('deepseek') : []
    const activeGemini =
      freshGeminiKeys.length > 0 ? freshGeminiKeys : geminiKeys
    const activeDeepseek =
      freshDeepseekKeys.length > 0 ? freshDeepseekKeys : deepseekKeys

    const body = { ...baseBody, contents }
    const result = await callAiWithPoolRetry({
      geminiKeys: activeGemini,
      geminiModels,
      deepseekKeys: activeDeepseek,
      deepseekModels,
      body,
      deadline,
      signal: input.signal,
      emit,
      onModelSwitch: ({ model, provider, keyIdx, total }) => {
        emit({ type: 'model', model: `${provider}:${model} · key ${keyIdx + 1}/${total}` })
      },
    })

    if (!result.ok) {
      if (result.status === 499 || input.signal?.aborted) {
        return {
          ok: false,
          status: 499,
          error: 'Stopped by user',
          trace: ctx.trace,
          model: lastModel,
          tokensUsed: totalTokens,
        }
      }

      const hasGatheredData =
        ctx.trace.length > 0 ||
        pipelineBriefText.length > 0 ||
        subAgentBriefText.length > 0 ||
        grounding.quote != null

      if (
        hasGatheredData &&
        (isPoolExhaustedStatus(result.status) ||
          RETRYABLE_STATUSES.has(result.status) ||
          result.status === 400 ||
          result.status === 504)
      ) {
        return finishEmergency(
          result.status === 400
            ? 'AI rejected the follow-up request - delivering analysis from data already collected'
            : 'Market Agent was busy - delivering analysis from data already collected',
          iteration
        )
      }

      // After the entire pool failed, surface a precise message that says
      // exactly when the next key recovers (uses Retry-After when present).
      const keySuffix = result.keySuffix

      void recordAiKeyRequestFailed({
        provider: result.provider,
        keySuffix,
        model: result.model,
        status: result.status,
        error: parseProviderErrorBody(result.body) ?? undefined,
        userEmail: input.user?.email,
        source: 'agent',
      })
      void recordAdminError({
        kind: 'ai',
        target: 'market-chat',
        status: result.status,
        message: parseProviderErrorBody(result.body) ?? `AI API error (${result.status})`,
        provider: result.provider,
        keySuffix,
        model: result.model,
        userEmail: input.user?.email,
        detail: result.body?.slice(0, 200),
      })

      const providers: Array<'gemini' | 'deepseek'> = []
      if (activeGemini.length > 0) providers.push('gemini')
      if (activeDeepseek.length > 0) providers.push('deepseek')
      const friendlyError = (() => {
        if (isNetworkError({ message: result.body })) {
          return formatNetworkError({ message: result.body }, 'AI provider (Gemini/DeepSeek)')
        }
        if (result.status === 429) {
          return poolExhaustedMessage(providers)
        }
        if (result.status === 503) {
          if (providers.length === 0) {
            return formatNetworkError({ message: result.body }, 'AI provider')
          }
          return poolExhaustedMessage(providers)
        }
        if (result.status === 402) {
          const geminiTotal = activeGemini.length
          const deepseekTotal = activeDeepseek.length
          if (geminiTotal > 0 && deepseekTotal === 0) {
            return 'Gemini quota or billing limit reached. Add DEEPSEEK_API_KEY in Vercel environment variables as a fallback, or top up your Google AI Studio quota.'
          }
          if (providers.length === 0) {
            return process.env.VERCEL
              ? 'AI provider is out of credit. Check GEMINI_API_KEY / DEEPSEEK_API_KEY billing in Vercel env vars.'
              : 'AI provider is out of credit. Add a valid GEMINI_API_KEY or top up the DeepSeek account.'
          }
          return poolExhaustedMessage(providers)
        }
        if (result.status === 401 || result.status === 403) {
          return process.env.VERCEL
            ? 'AI provider key was rejected. Verify GEMINI_API_KEY / DEEPSEEK_API_KEY in Vercel environment variables.'
            : 'AI provider key was rejected. Check GEMINI_API_KEY / DEEPSEEK_API_KEY in .env.local.'
        }
        if (result.status === 500 || result.status === 502 || result.status === 504) {
          return 'AI provider is having issues. Please retry in a moment.'
        }
        if (result.status === 400) {
          const parsed = parseProviderErrorBody(result.body)
          if (parsed?.toLowerCase().includes('image')) {
            return 'Could not process the image with the current model. Try again without an attachment or use a shorter message.'
          }
          if (parsed) return `AI request rejected: ${parsed}`
          return 'AI rejected the request (400). Try a shorter message or start a new conversation.'
        }
        return `AI API error (${result.status})`
      })()
      const error =
        sanitizeAgentErrorForUser(friendlyError, false) ??
        'Market Agent is temporarily unavailable. Please try again shortly.'
      emit({ type: 'error', status: networkErrorStatus({ message: result.body }) || result.status, error })
      return {
        ok: false,
        status: networkErrorStatus({ message: result.body }) || result.status,
        error,
        trace: ctx.trace,
        model: `${result.provider}:${result.model}`,
        tokensUsed: totalTokens,
      }
    }

    const roundTokens = await recordAiKeyUsageFromResponse({
      provider: result.provider,
      keySuffix: result.keySuffix,
      model: result.model,
      data: result.data as Parameters<typeof recordAiKeyUsageFromResponse>[0]['data'],
      userEmail: input.user?.email,
      source: 'agent',
      inputApproxChars: JSON.stringify(body).length,
    })
    totalTokens += roundTokens
    getCurrentRunAudit()?.recordAiCall({
      source: 'main_agent',
      model: result.model,
      tokens: roundTokens,
    })

    const tagged = `${result.provider}:${result.model}`
    if (lastModel !== tagged) {
      lastModel = tagged
      emit({ type: 'model', model: lastModel })
    }
    const candidate = result.data.candidates?.[0]
    const blockReason = candidate?.finishReason || result.data.promptFeedback?.blockReason
    if (blockReason === 'SAFETY' || blockReason === 'BLOCKLIST') {
      const error = 'Message blocked by safety filter. Try rephrasing.'
      emit({ type: 'error', status: 422, error })
      return {
        ok: false,
        status: 422,
        error,
        trace: ctx.trace,
        model: lastModel,
        tokensUsed: totalTokens,
      }
    }

    const parts = candidate?.content?.parts ?? []
    const functionCalls = parts.filter(isFunctionCallPart)

    if (functionCalls.length > 0 && toolCallsExecuted < toolCallBudget && plan.allowToolCalls) {
      contents.push({ role: 'model', parts: parts as GeminiPart[] })

      // Build the list of tool calls to execute this round
      // (respecting the remaining budget) and run them IN PARALLEL.
      type PendingCall = {
        name: string
        args: Record<string, unknown>
        callId: string
      }
      const pending: PendingCall[] = []
      for (const call of functionCalls) {
        if (toolCallsExecuted >= toolCallBudget) break
        toolCallsExecuted++
        const callId = `c-${Date.now()}-${toolCallsExecuted}`
        pending.push({
          name: call.functionCall.name,
          args: call.functionCall.args ?? {},
          callId,
        })
        emit({ type: 'tool_call', tool: call.functionCall.name, args: call.functionCall.args ?? {}, callId })
      }

      const responses = await Promise.all(
        pending.map((p) =>
          executeToolCall(p.name, p.args, ctx, emit, p.callId, { plan, grounding }, toolArtifacts)
        )
      )

      const responseParts: GeminiFunctionResponsePart[] = pending.map((p, i) => ({
        functionResponse: { name: p.name, response: responses[i] },
      }))

      contents.push({ role: 'function', parts: responseParts })
      continue
    }

    // Either out of tool-call budget or model returned text - finalize.
    const text = parts.filter(isTextPart).map((p) => p.text).join('').trim()

    if (!text && toolCallsExecuted >= toolCallBudget) {
      // Force a final answer: append a stern reminder and ask one more time.
      contents.push({
        role: 'user',
        parts: [
          {
            text: 'Tool budget exhausted. Return the FINAL JSON object now using everything you already gathered. No more tool calls.',
          },
        ],
      })
      continue
    }

    if (!text) {
      if (emptyResponseRetries < MAX_EMPTY_RETRIES) {
        emptyResponseRetries++
        contents.push({
          role: 'user',
          parts: [
            {
              text: 'Return the FINAL JSON object now. Use sub-agent evidence and grounding already provided. Include reply, setup (entry/stop/target or WAIT), levels[], zones[], drawIntent. No more tool calls.',
            },
          ],
        })
        continue
      }
      if (ctx.trace.length > 0 || pipelineBriefText || subAgentBriefText) {
        return finishEmergency('Could not finish synthesis - partial analysis delivered', iteration)
      }
      const error = 'Empty response from AI. Please retry.'
      emit({ type: 'error', status: 502, error })
      return {
        ok: false,
        status: 502,
        error,
        trace: ctx.trace,
        model: lastModel,
        tokensUsed: totalTokens,
      }
    }

    let response = safeParseFinal(text)
    if (response.reply) {
      response.reply = sanitizePublicReply(response.reply)
    }

    response = await formatMarketChatReply(response, {
      intent: plan.intent,
      responseMode: plan.responseMode,
      taskTags: plan.taskTags,
      userEmail: input.user?.email,
      deterministicOnly:
        pipelineRanOk ||
        scoutsGatheredEvidence ||
        iteration > 0 ||
        Date.now() >= deadline - 10_000,
    })

    if (!pipelineResult && pipelineResultSlot.current) {
      pipelineResult = pipelineResultSlot.current
      pipelineBriefText = renderPipelineBriefForPrompt(pipelineResult)
      pipelineRanOk = pipelineResult.setup.confluenceScore >= 45
    }

    let mergedResponse = pipelineResult
      ? mergePipelineIntoChatResponse(response, pipelineResult, {
          resolution: input.resolution,
        })
      : response

    mergedResponse = repairEmptyMarketChatReply(
      mergedResponse,
      input.symbolLabel ?? input.symbol,
      input.message
    )

    if (
      needsSetupReplyPolish(mergedResponse.reply, plan.intent, input.message) &&
      (subAgentBriefs.length > 0 || pipelineResult)
    ) {
      mergedResponse = await polishSetupReplyIfNeeded(mergedResponse, {
        userMessage: input.message,
        symbolLabel: input.symbolLabel ?? input.symbol ?? '',
        plan,
        grounding,
        pipeline: pipelineResult,
        subAgentBriefs,
        chartState: input.chartState,
        userEmail: input.user?.email,
      })
    }

    if (isGenericOrEmptyReply(mergedResponse.reply)) {
      const evidenceFallback = resolveEvidenceFallback({
        userMessage: input.message,
        symbolLabel: input.symbolLabel ?? input.symbol,
        grounding,
        plan,
        subAgentBriefs,
        reason: 'model returned empty reply',
      })
      if (evidenceFallback) {
        mergedResponse = {
          ...evidenceFallback,
          clarifyingQuestion: mergedResponse.clarifyingQuestion,
          clarifyingOptions: mergedResponse.clarifyingOptions,
          artifacts: mergedResponse.artifacts ?? evidenceFallback.artifacts,
        }
      }
    }

    if (
      mergedResponse.reply.includes('could not generate') &&
      plan.intent === 'general'
    ) {
      const generalFallback = buildGeneralReplyFromResearch(subAgentBriefs, input.message)
      if (generalFallback) {
        mergedResponse = generalFallback
      }
    }

    const hadWebEvidence = ctx.trace.some(
      (t) =>
        t.ok &&
        (t.tool === 'search_web' ||
          t.tool === 'search_internet' ||
          t.tool === 'search_news' ||
          t.tool === 'fetch_web_page' ||
          t.tool === 'research_catalysts')
    )

    const hadDeepMarketEvidence = ctx.trace.some(
      (t) =>
        t.ok &&
        (t.tool === 'get_deep_market_data' ||
          t.tool === 'get_orderbook_depth' ||
          t.tool === 'get_volume_profile' ||
          t.tool === 'get_metals_deep_market')
    )

    const mtfTraceEntry = ctx.trace.find(
      (t) => t.ok && t.tool === 'analyze_multi_timeframe'
    )
    const mtfAnalysis = parseMtfTraceSummary(mtfTraceEntry?.summary)

    const tradeContextEntry = ctx.trace.find(
      (t) => t.ok && t.tool === 'assess_trade_context'
    )
    const tradeContext = parseTradeContextTraceSummary(tradeContextEntry?.summary)

    mergedResponse = {
      ...mergedResponse,
      reply: sanitizePublicReply(mergedResponse.reply ?? ''),
    }

    const reflection = reflectOnResponse(mergedResponse, {
      plan,
      grounding,
      userMessage: input.message,
      mode: input.mode,
      hadWebEvidence,
      hadDeepMarketEvidence,
      mtfAnalysis,
      tradeContext,
      pipelineEvidence: pipelineRanOk,
      pipelineLevelsComplete: Boolean(
        pipelineResult?.setup.entry != null &&
          pipelineResult.setup.stopLoss != null &&
          pipelineResult.setup.takeProfit != null &&
          mergedResponse.setup?.entry != null
      ),
    })
    emit({
      type: 'reflecting',
      passed: reflection.passed,
      issues:
        reflection.issues.length > 0 || reflection.suggestions.length > 0
          ? [...reflection.issues, ...reflection.suggestions.map((s) => `Note: ${s}`)]
          : undefined,
    })

    if (
      !reflection.passed &&
      reflectionAttempts < maxReflectionAttempts &&
      Date.now() < deadline - 5000
    ) {
      reflectionAttempts++
      contents.push({ role: 'model', parts: [{ text }] })
      contents.push({
        role: 'user',
        parts: [{ text: renderReflectionPrompt(reflection, reflectionAttempts) }],
      })
      continue
    }

    const enrichedResponse = attachCapabilitiesToResponse(
      mergedResponse,
      toolArtifacts,
      input.symbolLabel ?? input.symbol
    )

    const audit = finalizeAudit(true, lastModel, iteration + 1, totalTokens)
    emit({
      type: 'final',
      response: enrichedResponse,
      iterations: iteration + 1,
      reflectionPassed: reflection.passed,
      audit,
    })
    return {
      ok: true,
      response: enrichedResponse,
      trace: ctx.trace,
      model: lastModel,
      iterations: iteration + 1,
      tokensUsed: totalTokens,
      audit,
    }
  }

  if (
    ctx.trace.length > 0 ||
    pipelineBriefText ||
    subAgentBriefText ||
    subAgentBriefs.length > 0 ||
    grounding.quote != null
  ) {
    return finishEmergency('Round-trip budget reached - delivering gathered analysis', roundtripCap)
  }

  const error = 'Agent exceeded round-trip budget.'
  emit({ type: 'error', status: 504, error })
  const failAudit = finalizeAudit(false, lastModel, roundtripCap, totalTokens)
  return {
    ok: false,
    status: 504,
    error,
    trace: ctx.trace,
    model: lastModel,
    tokensUsed: totalTokens,
    audit: failAudit,
  }
}
