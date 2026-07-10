export type UserAnalysis = {
  id: string
  signal: string
  probability: number
  prediction: string
  riskLevel?: string
  timeframe?: string
  createdAt: string
}

/**
 * Lightweight, serializable form of a market-agent message.
 * Deliberately omits client-only blobs (images, transient tool args, etc.) so a
 * single conversation stays well under any KV value limit.
 */
export type StoredAgentTrace = {
  plan?: {
    intent: string
    intentLabel: string
    subAgents: string[]
    progressSteps?: string[]
    /** @deprecated legacy traces - migrated to progressSteps in UI */
    selfQuestions?: string[]
  } | null
  steps?: Array<{
    id: string
    kind: string
    label: string
    detail?: string
    status: string
    durationMs?: number
  }>
  tools?: Array<{
    callId: string
    tool: string
    status: string
    summary?: string
    error?: string
    durationMs?: number
  }>
  model?: string | null
}

export type StoredChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** Optional structured fields produced by the agent. */
  setup?: unknown
  levels?: unknown[]
  zones?: unknown[]
  drawIntent?: boolean | null
  model?: string
  /** Collapsible agent work log (steps, tools, plan) for replay. */
  agentTrace?: StoredAgentTrace
  /** Rich capability outputs (setup visual, scans, clarifications). */
  artifacts?: import('@/lib/agent/artifacts').AgentArtifact[]
}

/** Per-scope conversation (e.g. `chart:AAPL`, `insights:MARKET`). */
export type StoredConversation = {
  scope: string
  /** Human-readable title (e.g. "AAPL · Chart"). Optional. */
  title?: string
  messages: StoredChatMessage[]
  updatedAt: string
}

/** Per-user preferences surface (real, simple). */
export type UserPreferences = {
  /** Agent default verbosity - currently advisory, not enforced. */
  agentVerbosity?: 'concise' | 'detailed'
  /** Auto-apply chart drawings when the agent returns levels. */
  agentAutoDraw?: boolean
  /** Preferred timezone for calendar / sessions display. */
  timezone?: string
  /** Default timeframe for the chart view. */
  defaultTimeframe?: string
  /** Last chart symbol the user viewed (synced when signed in). */
  lastChartSymbol?: string
}

export type UserData = {
  email: string
  watchlist: string[]
  /** Starred symbols - shown first in watchlist UI */
  favorites?: string[]
  analyses: UserAnalysis[]
  plan?: string
  /** Stripe subscription id (set after checkout / webhook). */
  stripeSubscriptionId?: string
  /** Stripe customer id (set after checkout / webhook). */
  stripeCustomerId?: string
  /** When the current paid plan was first activated (ISO). */
  planActivatedAt?: string
  /** Last known Stripe subscription status. */
  subscriptionStatus?:
    | 'active'
    | 'trialing'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'incomplete'
    | 'incomplete_expired'
    | 'paused'
  /** How the plan was granted. */
  planSource?: 'stripe' | 'manual'
  /** Per-user agent conversations, keyed by scope. */
  conversations?: Record<string, StoredConversation>
  /** Per-user app preferences. */
  preferences?: UserPreferences
  /** Account creation timestamp (ISO). Set on first save. */
  createdAt?: string
  updatedAt: string
}
