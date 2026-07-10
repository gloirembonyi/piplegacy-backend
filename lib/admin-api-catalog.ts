/**
 * REST API catalog for admin API documentation / playground.
 * Each entry maps to a real Next.js route under app/api.
 */

export type ApiFieldSchema = {
  name: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  required?: boolean
  enum?: string[]
  default?: unknown
  itemsType?: 'string' | 'number'
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type ApiAuthLevel = 'public' | 'user' | 'admin' | 'super_admin' | 'cron' | 'webhook'

export type ApiEndpointSchema = {
  id: string
  path: string
  method: HttpMethod
  label: string
  description: string
  category: string
  auth: ApiAuthLevel
  /** False for OAuth redirects, webhooks, cron without secret UI. */
  executable: boolean
  readOnly?: boolean
  queryParams?: ApiFieldSchema[]
  pathParams?: ApiFieldSchema[]
  bodyFields?: ApiFieldSchema[]
  bodyExample?: string
  warnings?: string[]
  notExecutableReason?: string
}

function q(fields: ApiFieldSchema[]): ApiFieldSchema[] {
  return fields
}

function body(fields: ApiFieldSchema[]): ApiFieldSchema[] {
  return fields
}

export const API_ENDPOINT_CATALOG: ApiEndpointSchema[] = [
  // ─── Health ───────────────────────────────────────────────
  {
    id: 'GET /api/health',
    path: '/api/health',
    method: 'GET',
    label: 'Service health',
    description: 'Authenticated health dashboard: Finnhub, AI engine, Redis, storage, Stripe probes.',
    category: 'health',
    auth: 'user',
    executable: true,
    readOnly: true,
  },

  // ─── Market data ──────────────────────────────────────────
  {
    id: 'GET /api/market-data',
    path: '/api/market-data',
    method: 'GET',
    label: 'Batch quotes',
    description: 'Live quotes for up to 20 comma-separated symbols via Finnhub.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      {
        name: 'symbols',
        type: 'string',
        required: true,
        description: 'Comma-separated tickers',
        default: 'SPY,QQQ,XAUUSD,BTCUSD',
      },
    ]),
  },
  {
    id: 'GET /api/market-news',
    path: '/api/market-news',
    method: 'GET',
    label: 'Market news feed',
    description: 'Finnhub market headlines with sentiment and impact classification.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      { name: 'limit', type: 'integer', description: '5–40 items', default: 24 },
    ]),
  },
  {
    id: 'GET /api/market-brief',
    path: '/api/market-brief',
    method: 'GET',
    label: 'Market brief',
    description: 'Aggregated cross-market brief from live quotes.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'GET /api/market-ideas',
    path: '/api/market-ideas',
    method: 'GET',
    label: 'Market ideas',
    description: 'Aggregated trade ideas from upstream sources.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'GET /api/market-context',
    path: '/api/market-context',
    method: 'GET',
    label: 'Market context',
    description: 'Sessions, liquidity, calendar events, and notes for a symbol.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      { name: 'symbol', type: 'string', description: 'Optional symbol', default: 'XAUUSD' },
    ]),
  },
  {
    id: 'GET /api/market-candles',
    path: '/api/market-candles',
    method: 'GET',
    label: 'Intraday candles',
    description: 'Candlesticks from Finnhub with generated-data fallback.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      { name: 'symbol', type: 'string', default: 'AAPL' },
      { name: 'timeframe', type: 'string', description: '1, 5, 15, 60, D', default: '5' },
    ]),
  },
  {
    id: 'GET /api/chart-overlay-data',
    path: '/api/chart-overlay-data',
    method: 'GET',
    label: 'Chart overlay data',
    description: 'Overlay candles merged with live quote and optional drawings JSON.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      { name: 'symbol', type: 'string', required: true, default: 'XAUUSD' },
      { name: 'resolution', type: 'string', default: '60' },
    ]),
  },
  {
    id: 'GET /api/finnhub',
    path: '/api/finnhub',
    method: 'GET',
    label: 'OHLC candles',
    description: 'OHLC candle data via candle providers.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      { name: 'symbol', type: 'string', default: 'AAPL' },
      { name: 'resolution', type: 'string', default: 'D' },
    ]),
  },
  {
    id: 'GET /api/forex-volatility',
    path: '/api/forex-volatility',
    method: 'GET',
    label: 'Forex volatility',
    description: 'Forex session volatility profile for a timezone.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      {
        name: 'tz',
        type: 'string',
        description: 'IANA timezone',
        default: 'America/New_York',
      },
    ]),
  },
  {
    id: 'GET /api/economic-calendar',
    path: '/api/economic-calendar',
    method: 'GET',
    label: 'Economic calendar',
    description: 'Economic events for a date range.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      { name: 'from', type: 'string', description: 'YYYY-MM-DD' },
      { name: 'to', type: 'string', description: 'YYYY-MM-DD' },
    ]),
  },
  {
    id: 'GET /api/symbols/search',
    path: '/api/symbols/search',
    method: 'GET',
    label: 'Symbol search',
    description: 'Search tradable symbols; empty q returns popular markets.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      { name: 'q', type: 'string', description: 'Search query', default: 'gold' },
    ]),
  },
  {
    id: 'GET /api/ai-suggestions',
    path: '/api/ai-suggestions',
    method: 'GET',
    label: 'AI watchlist suggestions',
    description: 'Personalized watchlist suggestions for the logged-in user.',
    category: 'market',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      { name: 'refresh', type: 'string', description: 'Set to 1 to force refresh (paid)', default: '' },
    ]),
    warnings: ['May consume AI quota when refresh=1 on paid plans.'],
  },

  // ─── Chat / AI ────────────────────────────────────────────
  {
    id: 'POST /api/market-chat',
    path: '/api/market-chat',
    method: 'POST',
    label: 'Market chat (agent)',
    description: 'Main AI market chat - streams NDJSON agent events. Consumes chat quota.',
    category: 'chat',
    auth: 'user',
    executable: true,
    queryParams: [],
    bodyExample: JSON.stringify(
      {
        message: 'Where are entry, stop and target for XAUUSD?',
        symbol: 'XAUUSD',
        mode: 'insights',
        resolution: '60',
        history: [],
      },
      null,
      2
    ),
    warnings: ['Streams response - playground shows raw stream text.', 'Consumes AI quota.'],
  },
  {
    id: 'POST /api/analyze-chart',
    path: '/api/analyze-chart',
    method: 'POST',
    label: 'Analyze chart (vision)',
    description: 'Gemini vision analysis of a chart screenshot. Consumes analyze quota.',
    category: 'chat',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify({ image: 'data:image/png;base64,...' }, null, 2),
    warnings: ['Requires a valid base64 image data-URL.', 'Consumes AI quota and saves history.'],
  },

  // ─── Bot / auto-trader ────────────────────────────────────
  {
    id: 'GET /api/bot/pulse',
    path: '/api/bot/pulse',
    method: 'GET',
    label: 'Market pulse',
    description: 'Compact quote, sparkline, key levels, ATR for chart analysis UI.',
    category: 'bot',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      { name: 'symbol', type: 'string', required: true, default: 'XAUUSD' },
    ]),
  },
  {
    id: 'GET /api/bot/log',
    path: '/api/bot/log',
    method: 'GET',
    label: 'Bot audit log',
    description: 'Trade and scan audit log for the authenticated user.',
    category: 'bot',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([
      { name: 'limit', type: 'integer', default: 50 },
      { name: 'symbol', type: 'string', default: '' },
    ]),
  },
  {
    id: 'GET /api/bot/config',
    path: '/api/bot/config',
    method: 'GET',
    label: 'Bot config (read)',
    description: 'Get auto-trader configuration and strategies.',
    category: 'bot',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'POST /api/bot/config',
    path: '/api/bot/config',
    method: 'POST',
    label: 'Bot config (write)',
    description: 'Upsert/delete strategies, trip/reset kill switch, set daily loss %.',
    category: 'bot',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify({ action: 'reset' }, null, 2),
    warnings: ['Mutates bot configuration.'],
  },
  {
    id: 'GET /api/bot/pending',
    path: '/api/bot/pending',
    method: 'GET',
    label: 'Pending setups (list)',
    description: 'List armed/active pending trade setups.',
    category: 'bot',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([{ name: 'active', type: 'string', description: 'Set 1 for active only', default: '' }]),
  },
  {
    id: 'POST /api/bot/pending',
    path: '/api/bot/pending',
    method: 'POST',
    label: 'Arm pending setup',
    description: 'Arm a setup waiting for entry price touch.',
    category: 'bot',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify(
      {
        setup: {
          symbol: 'XAUUSD',
          bias: 'BUY',
          entry: 2650,
          stopLoss: 2640,
          takeProfit: 2670,
        },
        brokerId: 'alpaca',
        riskPct: 1,
      },
      null,
      2
    ),
    warnings: ['Arms a live pending setup.'],
  },
  {
    id: 'DELETE /api/bot/pending/[id]',
    path: '/api/bot/pending/[id]',
    method: 'DELETE',
    label: 'Cancel pending setup',
    description: 'Cancel an armed pending setup by id.',
    category: 'bot',
    auth: 'user',
    executable: true,
    pathParams: q([{ name: 'id', type: 'string', required: true, description: 'Pending setup id' }]),
    warnings: ['Destructive - cancels pending setup.'],
  },
  {
    id: 'POST /api/bot/pending/check',
    path: '/api/bot/pending/check',
    method: 'POST',
    label: 'Check pending setups',
    description: 'Poll armed setups against live price; may execute trades on entry hit.',
    category: 'bot',
    auth: 'user',
    executable: true,
    warnings: ['May execute real/paper trades if entry is hit.'],
  },
  {
    id: 'POST /api/bot/scan',
    path: '/api/bot/scan',
    method: 'POST',
    label: 'Pipeline scan',
    description: 'Manual multi-agent pipeline scan; streams NDJSON. Requires paid plan.',
    category: 'bot',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify(
      { symbol: 'XAUUSD', timeframe: '1h', fast: true, riskBudgetPct: 1 },
      null,
      2
    ),
    warnings: ['Streams NDJSON.', 'Consumes AI quota.', 'May arm pending setups.'],
  },
  {
    id: 'POST /api/bot/trade',
    path: '/api/bot/trade',
    method: 'POST',
    label: 'Execute trade',
    description: 'Manual trade execution via connected broker.',
    category: 'bot',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify(
      {
        setup: {
          symbol: 'XAUUSD',
          bias: 'BUY',
          entry: 2650,
          stopLoss: 2640,
          takeProfit: 2670,
        },
        overrideBrokerId: 'alpaca',
        overrideMode: 'paper',
      },
      null,
      2
    ),
    warnings: ['Executes a trade on connected broker (paper or live).'],
  },

  // ─── User ─────────────────────────────────────────────────
  {
    id: 'GET /api/user/me',
    path: '/api/user/me',
    method: 'GET',
    label: 'Current user',
    description: 'Profile, plan, limits, usage, watchlist, admin flags.',
    category: 'user',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'GET /api/user/preferences',
    path: '/api/user/preferences',
    method: 'GET',
    label: 'User preferences (read)',
    description: 'Get user preference object.',
    category: 'user',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'PATCH /api/user/preferences',
    path: '/api/user/preferences',
    method: 'PATCH',
    label: 'User preferences (write)',
    description: 'Patch user preferences.',
    category: 'user',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify({ theme: 'dark' }, null, 2),
    warnings: ['Mutates user preferences.'],
  },
  {
    id: 'GET /api/user/watchlist',
    path: '/api/user/watchlist',
    method: 'GET',
    label: 'Watchlist (read)',
    description: 'Get watchlist and favorites.',
    category: 'user',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'GET /api/user/conversations',
    path: '/api/user/conversations',
    method: 'GET',
    label: 'Conversations (list)',
    description: 'List saved chat conversations.',
    category: 'user',
    auth: 'user',
    executable: true,
    readOnly: true,
    queryParams: q([{ name: 'scope', type: 'string', default: '' }]),
  },
  {
    id: 'GET /api/user/analyses',
    path: '/api/user/analyses',
    method: 'GET',
    label: 'Saved analyses',
    description: 'List saved chart vision analyses.',
    category: 'user',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'PUT /api/user/conversations',
    path: '/api/user/conversations',
    method: 'PUT',
    label: 'Save conversation',
    description: 'Save messages for a chat scope.',
    category: 'user',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify(
      { scope: 'insights:MARKET', messages: [{ role: 'user', content: 'Hello' }], title: 'Test' },
      null,
      2
    ),
    warnings: ['Persists conversation data.'],
  },
  {
    id: 'DELETE /api/user/conversations',
    path: '/api/user/conversations',
    method: 'DELETE',
    label: 'Delete conversations',
    description: 'Delete one scope or all conversations.',
    category: 'user',
    auth: 'user',
    executable: true,
    queryParams: q([
      { name: 'scope', type: 'string', default: '' },
      { name: 'all', type: 'string', description: 'Set 1 to delete all', default: '' },
    ]),
    warnings: ['Destructive - deletes saved chats.'],
  },
  {
    id: 'POST /api/user/analyses',
    path: '/api/user/analyses',
    method: 'POST',
    label: 'Save analysis',
    description: 'Manually save a chart analysis record.',
    category: 'user',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify(
      { signal: 'BUY', probability: 72, prediction: 'Bullish breakout', timeframe: '1h' },
      null,
      2
    ),
    warnings: ['Persists analysis history.'],
  },
  {
    id: 'PUT /api/user/watchlist',
    path: '/api/user/watchlist',
    method: 'PUT',
    label: 'Replace watchlist',
    description: 'Replace entire watchlist and optional favorites.',
    category: 'user',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify({ watchlist: ['SPY', 'XAUUSD'], favorites: ['XAUUSD'] }, null, 2),
    warnings: ['Mutates watchlist.'],
  },
  {
    id: 'PATCH /api/user/watchlist',
    path: '/api/user/watchlist',
    method: 'PATCH',
    label: 'Patch watchlist',
    description: 'Add, remove, or toggle favorite for a symbol.',
    category: 'user',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify({ action: 'add', symbol: 'NVDA' }, null, 2),
    warnings: ['Mutates watchlist.'],
  },

  // ─── Brokers ──────────────────────────────────────────────
  {
    id: 'GET /api/brokers',
    path: '/api/brokers',
    method: 'GET',
    label: 'Connected brokers',
    description: 'List connected broker metadata.',
    category: 'brokers',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'GET /api/brokers/account',
    path: '/api/brokers/account',
    method: 'GET',
    label: 'Broker accounts',
    description: 'Aggregate broker accounts and open positions.',
    category: 'brokers',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'GET /api/brokers/[broker]',
    path: '/api/brokers/[broker]',
    method: 'GET',
    label: 'Broker connection meta',
    description: 'Get connection metadata for alpaca or oanda.',
    category: 'brokers',
    auth: 'user',
    executable: true,
    readOnly: true,
    pathParams: q([
      { name: 'broker', type: 'string', required: true, enum: ['alpaca', 'oanda'], default: 'alpaca' },
    ]),
  },
  {
    id: 'PATCH /api/brokers/[broker]',
    path: '/api/brokers/[broker]',
    method: 'PATCH',
    label: 'Test broker connection',
    description: 'Test broker API credentials.',
    category: 'brokers',
    auth: 'user',
    executable: true,
    pathParams: q([
      { name: 'broker', type: 'string', required: true, enum: ['alpaca', 'oanda'], default: 'alpaca' },
    ]),
  },
  {
    id: 'POST /api/brokers/[broker]',
    path: '/api/brokers/[broker]',
    method: 'POST',
    label: 'Connect broker',
    description: 'Store broker API credentials (Alpaca or OANDA).',
    category: 'brokers',
    auth: 'user',
    executable: true,
    pathParams: q([
      { name: 'broker', type: 'string', required: true, enum: ['alpaca', 'oanda'], default: 'alpaca' },
    ]),
    bodyExample: JSON.stringify(
      { env: 'paper', keyId: 'YOUR_KEY', secret: 'YOUR_SECRET' },
      null,
      2
    ),
    warnings: ['Stores broker credentials - use paper keys only for testing.'],
  },
  {
    id: 'DELETE /api/brokers/[broker]',
    path: '/api/brokers/[broker]',
    method: 'DELETE',
    label: 'Disconnect broker',
    description: 'Remove stored broker connection.',
    category: 'brokers',
    auth: 'user',
    executable: true,
    pathParams: q([
      { name: 'broker', type: 'string', required: true, enum: ['alpaca', 'oanda'], default: 'alpaca' },
    ]),
    warnings: ['Removes broker connection.'],
  },

  // ─── TradingView MCP ──────────────────────────────────────
  {
    id: 'GET /api/tradingview-mcp',
    path: '/api/tradingview-mcp',
    method: 'GET',
    label: 'TradingView MCP status',
    description: 'Check TradingView Desktop MCP bridge health.',
    category: 'integrations',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'POST /api/tradingview-mcp',
    path: '/api/tradingview-mcp',
    method: 'POST',
    label: 'Draw on TradingView',
    description: 'Draw entry/stop/target on TradingView Desktop via MCP.',
    category: 'integrations',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify(
      {
        symbol: 'XAUUSD',
        resolution: '60',
        setup: { side: 'long', entry: 2650, stopLoss: 2640, takeProfit: 2670 },
      },
      null,
      2
    ),
    warnings: ['Requires TradingView Desktop + MCP bridge running locally.'],
  },

  // ─── Admin ────────────────────────────────────────────────
  {
    id: 'GET /api/admin/overview',
    path: '/api/admin/overview',
    method: 'GET',
    label: 'Admin overview',
    description: 'Dashboard snapshot: deployment, config, users, AI health, usage.',
    category: 'admin',
    auth: 'admin',
    executable: true,
    readOnly: true,
  },
  {
    id: 'GET /api/admin/services',
    path: '/api/admin/services',
    method: 'GET',
    label: 'Admin services probe',
    description: 'Infrastructure probes: Finnhub, AI, Redis, Stripe, pipeline.',
    category: 'admin',
    auth: 'admin',
    executable: true,
    readOnly: true,
  },
  {
    id: 'GET /api/admin/agents',
    path: '/api/admin/agents',
    method: 'GET',
    label: 'Tools & agents report',
    description: 'Registry, usage, health probes, canary, recent errors and runs.',
    category: 'admin',
    auth: 'admin',
    executable: true,
    readOnly: true,
  },
  {
    id: 'GET /api/admin/users',
    path: '/api/admin/users',
    method: 'GET',
    label: 'List users',
    description: 'All users with admin metadata.',
    category: 'admin',
    auth: 'admin',
    executable: true,
    readOnly: true,
  },
  {
    id: 'GET /api/admin/ai-health',
    path: '/api/admin/ai-health',
    method: 'GET',
    label: 'AI key health',
    description: 'AI key pool status, usage metrics, optional live probe.',
    category: 'admin',
    auth: 'admin',
    executable: true,
    readOnly: true,
    queryParams: q([{ name: 'live', type: 'string', description: 'Set 1 for live probe', default: '' }]),
  },
  {
    id: 'POST /api/admin/ai-health',
    path: '/api/admin/ai-health',
    method: 'POST',
    label: 'Reset AI cooldowns',
    description: 'Reset Gemini/DeepSeek key pool cooldowns.',
    category: 'admin',
    auth: 'admin',
    executable: true,
    bodyExample: JSON.stringify({ action: 'reset-gemini' }, null, 2),
    warnings: ['Resets key pool cooldown state.'],
  },
  {
    id: 'GET /api/admin/admins',
    path: '/api/admin/admins',
    method: 'GET',
    label: 'List admins',
    description: 'All admin accounts.',
    category: 'admin',
    auth: 'super_admin',
    executable: true,
    readOnly: true,
  },
  {
    id: 'GET /api/admin/apis',
    path: '/api/admin/apis',
    method: 'GET',
    label: 'API catalog (this page)',
    description: 'Returns the REST API catalog for this documentation UI.',
    category: 'admin',
    auth: 'admin',
    executable: true,
    readOnly: true,
  },
  {
    id: 'PATCH /api/admin/users/[email]',
    path: '/api/admin/users/[email]',
    method: 'PATCH',
    label: 'Override user plan',
    description: 'Admin override of a user subscription plan.',
    category: 'admin',
    auth: 'admin',
    executable: true,
    pathParams: q([
      { name: 'email', type: 'string', required: true, description: 'User email', default: 'user@example.com' },
    ]),
    bodyExample: JSON.stringify({ plan: 'pro' }, null, 2),
    warnings: ['Mutates user subscription plan.'],
  },
  {
    id: 'POST /api/admin/admins',
    path: '/api/admin/admins',
    method: 'POST',
    label: 'Add admin',
    description: 'Grant admin access to an email.',
    category: 'admin',
    auth: 'super_admin',
    executable: true,
    bodyExample: JSON.stringify({ email: 'admin@example.com', role: 'admin' }, null, 2),
    warnings: ['Requires super admin.', 'Grants admin access.'],
  },
  {
    id: 'DELETE /api/admin/admins',
    path: '/api/admin/admins',
    method: 'DELETE',
    label: 'Remove admin',
    description: 'Revoke admin access from an email.',
    category: 'admin',
    auth: 'super_admin',
    executable: true,
    queryParams: q([{ name: 'email', type: 'string', required: true, default: 'admin@example.com' }]),
    warnings: ['Requires super admin.', 'Revokes admin access.'],
  },
  {
    id: 'GET /api/notifications',
    path: '/api/notifications',
    method: 'GET',
    label: 'Notifications',
    description: 'In-app notification feed: movers, calendar, sessions, admin alerts.',
    category: 'user',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'POST /api/auth/login',
    path: '/api/auth/login',
    method: 'POST',
    label: 'Login',
    description: 'Email/password login - creates session cookie.',
    category: 'auth',
    auth: 'public',
    executable: false,
    notExecutableReason: 'Use the app login page - playground already uses your admin session.',
    bodyExample: JSON.stringify({ email: 'user@example.com', password: '***' }, null, 2),
  },
  {
    id: 'POST /api/auth/signup',
    path: '/api/auth/signup',
    method: 'POST',
    label: 'Signup',
    description: 'Create account with email/password.',
    category: 'auth',
    auth: 'public',
    executable: false,
    notExecutableReason: 'Use the app signup page to avoid duplicate sessions.',
  },
  {
    id: 'POST /api/auth/logout',
    path: '/api/auth/logout',
    method: 'POST',
    label: 'Logout',
    description: 'Clears session cookie.',
    category: 'auth',
    auth: 'public',
    executable: false,
    notExecutableReason: 'Would log you out of the admin session.',
  },
  {
    id: 'GET /api/auth/google',
    path: '/api/auth/google',
    method: 'GET',
    label: 'Google OAuth start',
    description: 'Redirects to Google OAuth.',
    category: 'auth',
    auth: 'public',
    executable: false,
    notExecutableReason: 'OAuth redirect - open /api/auth/google in browser manually.',
  },

  // ─── Stripe ───────────────────────────────────────────────
  {
    id: 'GET /api/stripe/subscription',
    path: '/api/stripe/subscription',
    method: 'GET',
    label: 'Subscription (read)',
    description: 'Subscription details, plan limits, and usage.',
    category: 'stripe',
    auth: 'user',
    executable: true,
    readOnly: true,
  },
  {
    id: 'POST /api/stripe/subscription',
    path: '/api/stripe/subscription',
    method: 'POST',
    label: 'Subscription (manage)',
    description: 'Cancel or resume subscription.',
    category: 'stripe',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify({ action: 'cancel' }, null, 2),
    warnings: ['Mutates Stripe subscription.'],
  },
  {
    id: 'POST /api/create-checkout-session',
    path: '/api/create-checkout-session',
    method: 'POST',
    label: 'Create checkout',
    description: 'Create Stripe Checkout session for starter/pro plan.',
    category: 'stripe',
    auth: 'user',
    executable: true,
    bodyExample: JSON.stringify({ planId: 'pro', isAnnual: false }, null, 2),
    warnings: ['Creates a real Stripe checkout session.'],
  },
  {
    id: 'POST /api/stripe/webhook',
    path: '/api/stripe/webhook',
    method: 'POST',
    label: 'Stripe webhook',
    description: 'Stripe webhook handler - requires stripe-signature header.',
    category: 'stripe',
    auth: 'webhook',
    executable: false,
    notExecutableReason: 'Requires valid Stripe signature - use Stripe CLI for testing.',
  },

  // ─── Cron ─────────────────────────────────────────────────
  {
    id: 'GET /api/cron/scan',
    path: '/api/cron/scan',
    method: 'GET',
    label: 'Cron: bot scan',
    description: 'Vercel cron - scan all user strategies and execute trades.',
    category: 'cron',
    auth: 'cron',
    executable: false,
    notExecutableReason: 'Requires CRON_SECRET bearer token - not available in browser playground.',
  },
  {
    id: 'GET /api/cron/trigger-pending',
    path: '/api/cron/trigger-pending',
    method: 'GET',
    label: 'Cron: pending setups',
    description: 'Process armed pending setups - may execute trades.',
    category: 'cron',
    auth: 'cron',
    executable: false,
    notExecutableReason: 'Requires CRON_SECRET bearer token.',
  },
]

export function getApiCatalog(): ApiEndpointSchema[] {
  return API_ENDPOINT_CATALOG
}

export function getApiCatalogGrouped(): Record<string, ApiEndpointSchema[]> {
  const grouped: Record<string, ApiEndpointSchema[]> = {}
  for (const ep of API_ENDPOINT_CATALOG) {
    const list = grouped[ep.category] ?? []
    list.push(ep)
    grouped[ep.category] = list
  }
  return grouped
}

export function getApiCatalogStats() {
  const all = API_ENDPOINT_CATALOG
  return {
    total: all.length,
    executable: all.filter((e) => e.executable).length,
    readOnly: all.filter((e) => e.readOnly).length,
    categories: [...new Set(all.map((e) => e.category))].sort(),
  }
}
