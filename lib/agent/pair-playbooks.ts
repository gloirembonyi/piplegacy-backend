/**
 * Instrument-specific trading playbooks injected into the agent prompt.
 *
 * For the most-traded global pairs we encode:
 *  - Typical behavior (range, volatility, session profile)
 *  - The setups that historically work
 *  - The setups that historically fail
 *  - Correlations & catalysts to monitor
 *
 * The agent reads the playbook for the active symbol and applies it
 * alongside generic SMC / risk rules from `trading-knowledge.ts`.
 */

type PairPlaybook = {
  /** Matches against the user's symbol (uppercase, before `:` resolution). */
  match: RegExp
  label: string
  body: string
}

const PLAYBOOKS: PairPlaybook[] = [
  {
    match: /^(XAU|GOLD|XAUUSD)/,
    label: 'XAU/USD - Gold',
    body: `XAU/USD PLAYBOOK
- Volatility: high. Daily ATR commonly 15–35 USD. ATR per hour during NY can be 5+.
- Sessions: ranges in Asia, real moves start at London open, peak during London/NY overlap.
- Drivers (in order of impact):
  1. DXY direction (negative correlation ~ -0.8 vs gold)
  2. Real US 10Y yields (inverse): falling yields = bullish gold
  3. Geopolitical risk-off (escalations, wars) = spike up
  4. Fed expectations: hawkish surprise = down, dovish = up
  5. Physical demand cycles (China/India, central banks)
- Best setups:
  - Liquidity sweep at Asia high/low → reversal at London open (classic Judas Swing)
  - 4H bullish OB retest with DXY rolling over
  - Round-number rejections at every $50 step (2300, 2350, etc.) - fade them
  - News-driven momentum: CPI/NFP miss → ride the first hour, exit before second wave
- Bad setups (avoid):
  - Breakout trades during Asia session (false breakouts dominant)
  - Counter-trending on Fed days unless rejection candle prints first
  - Tight scalps in the 5 minutes before NY economic releases
- Key levels mindset: gold respects $5–10 reaction zones around prior swings, NOT round numbers alone.
- Stops: use 1.5× ATR minimum. Tight stops get hunted on gold's noise.
- Position sizing: gold pip = $0.01 movement per 1 oz; 1 standard lot ≈ $1 per pip. Cut size vs FX.`,
  },
  {
    match: /^EUR.?USD|^OANDA:EUR_USD/,
    label: 'EUR/USD',
    body: `EUR/USD PLAYBOOK
- Most-traded pair, tightest spreads, cleanest technical reactions.
- Daily ATR commonly 60–100 pips. London/NY overlap = peak volatility.
- Drivers:
  1. ECB vs Fed rate differential (real & expected)
  2. DXY (inverse). EUR/USD is ~57% of DXY weight.
  3. EU CPI, NFP, FOMC, ECB meetings
  4. EU growth vs US growth (German Bunds vs US 10Y spread)
- Best setups:
  - London open sweep of Asia high/low then reverse
  - 1H/4H continuation after BOS in trending direction
  - FOMC drift: trend direction in the days BEFORE FOMC often continues right after the volatility spike
  - PMI / CPI fade on misaligned reactions (initial spike fades within 1–2 hours)
- Bad setups:
  - Breakouts in Asia session
  - Trading the second hour after NFP / CPI (chop)
  - Trend trades against the daily 50EMA without BOS
- Pivot tactic: pre-NY range often gets swept exactly at 13:30 UTC during US data drop.
- Stops: typical structural stops 25–40 pips. Round number traps at 1.0500, 1.1000, 1.1500.`,
  },
  {
    match: /^GBP.?USD|^OANDA:GBP_USD/,
    label: 'GBP/USD - Cable',
    body: `GBP/USD PLAYBOOK
- Higher volatility than EUR/USD: daily ATR 80–130 pips.
- Drivers:
  1. BoE vs Fed rate differential
  2. UK CPI / employment / GDP
  3. EUR/USD (often correlated short-term)
  4. Risk sentiment (cable trades risk-on relative to EUR)
- Best setups:
  - London 8 AM (UTC) range explosion - wait for first 30m candle close, then trade in the direction
  - BoE day: pre-event drift continues for ~1 hour after, then often fades by NY close
  - 4H pin bars at swing highs/lows have higher win rate than EUR/USD
- Bad setups:
  - Tight scalps (cable's noise eats <15 pip stops)
  - Trading 15:00 UTC onward (often choppy unless trend day)
  - Friday after NY close - gap & weekend risk
- Watch GBP/JPY for risk sentiment confirmation.`,
  },
  {
    match: /^USD.?JPY|^OANDA:USD_JPY/,
    label: 'USD/JPY',
    body: `USD/JPY PLAYBOOK
- Daily ATR: 80–150 pips. Heavily driven by yield differentials.
- Drivers:
  1. US 10Y yield (positive correlation, single biggest driver)
  2. BoJ policy (rare moves but huge - intervention risk above 150)
  3. Risk sentiment (USD/JPY is a risk barometer for global equity)
  4. Carry trade flows (JPY funding currency)
- Best setups:
  - Yield-driven trend continuation in NY session
  - Tokyo open consolidation breakout (rare but clean)
  - SMC: liquidity sweep below Asia low then bullish BOS during London
- Bad setups:
  - Trying to short below 150 (intervention zone; verbal warnings = avoid shorts)
  - Counter-trend trades against US 10Y direction
  - Tight stops during Tokyo session (low-volume noise)
- Above 150 = MOF/BoJ intervention zone. Trade defensively, expect sudden 200+ pip drops.`,
  },
  {
    match: /^GBP.?JPY|^OANDA:GBP_JPY/,
    label: 'GBP/JPY - The Dragon',
    body: `GBP/JPY PLAYBOOK
- Nicknamed "the dragon" / "the beast". Daily ATR: 120–200 pips.
- Highest-volatility major. Risk-on bellwether - moves with global equities.
- Drivers: GBP factors × JPY factors compound (BoE × BoJ × risk sentiment).
- Best setups:
  - Strong-trend days: ride London/NY with wide stops (60+ pips)
  - 4H structure trades only - anything lower is too noisy
  - Risk-on/off pivots: when SPX rallies hard, GBP/JPY follows
- Bad setups:
  - Any scalp under 20 pip stop - gets hunted
  - News trading (gap risk huge)
  - Counter-trend on momentum days (price extends much further than EUR/USD)
- Use larger ATR multiples for stops (2×–2.5× ATR).`,
  },
  {
    match: /^AUD.?USD|^OANDA:AUD_USD/,
    label: 'AUD/USD - Aussie',
    body: `AUD/USD PLAYBOOK
- Risk-on commodity currency. Daily ATR: 40–80 pips.
- Drivers:
  1. China data / commodity prices (iron ore, copper)
  2. Risk sentiment (correlated with SPX, BTC, oil)
  3. RBA vs Fed rate path
  4. Gold price (positive correlation with AUD)
- Best setups:
  - Asia session ranges can break with Chinese data drops (1:30 UTC area)
  - Trend continuation when SPX is in uptrend
  - Trade with copper/iron ore catalysts in mind
- Bad setups:
  - Counter-cyclical trades when SPX is selling off hard
  - Asia-session breakouts against US risk-off
- Watch DXY and copper futures for confirmation.`,
  },
  {
    match: /^USD.?CAD|^OANDA:USD_CAD/,
    label: 'USD/CAD - Loonie',
    body: `USD/CAD PLAYBOOK
- Daily ATR: 50–90 pips. Heavily driven by oil.
- Drivers:
  1. WTI crude oil (inverse - oil up = CAD up = USD/CAD down)
  2. BoC vs Fed
  3. US growth (Canada exports to US)
- Best setups:
  - Oil-driven swings: fade USD/CAD when crude breaks resistance hard
  - BoC days produce clean trends
- Bad setups:
  - Counter-oil-trend trades
  - Tight scalps during low-volume NY mornings
- Always check WTI on a separate chart before taking a USD/CAD setup.`,
  },
  {
    match: /^BTC|^BINANCE:BTCUSDT|^BTCUSDT?$/,
    label: 'BTC/USD - Bitcoin',
    body: `BTC/USD PLAYBOOK
- 24/7 market, but real volume during US session (ETF flows post-2024).
- Daily ATR: variable; can be 2–8%.
- Drivers:
  1. Spot ETF flows (US trading hours)
  2. Macro liquidity (DXY, US 10Y, M2)
  3. Regulatory news (SEC, ETFs)
  4. Crypto-native catalysts (halving cycles, exchange outages)
- Best setups:
  - Weekend low or Friday-close sweep then Sunday/Monday reversal
  - 4H bullish/bearish OB on the daily timeframe
  - ETF inflow days: trend continuation in the US session
  - Wyckoff-style accumulation/distribution (BTC respects these classic phases very well)
- Bad setups:
  - Counter-trending against ETF flow trend
  - Tight scalps - BTC moves in vertical legs that hunt small stops
  - Buying after exhaustion blow-off candles (parabolic tops)
- Round number psychology: 50K, 70K, 100K matter. Funding rate extremes = reversal signals.
- Use percentage-based stops (1–3%) rather than absolute dollars.`,
  },
  {
    match: /^ETH|^BINANCE:ETHUSDT/,
    label: 'ETH/USD',
    body: `ETH/USD PLAYBOOK
- Beta to BTC (1.1–1.5x typically). Daily ATR 2–6%.
- Drivers: BTC direction, ETH-specific catalysts (upgrades, ETF, gas trends).
- Best setups: follow BTC trend with leverage on continuations; ETH/BTC ratio breaks signal alt-season pivots.
- Bad setups: counter-trading BTC; trading during low ETF/spot-volume hours.
- Always check BTC chart before taking an ETH setup.`,
  },
  {
    match: /^(US30|DJI|DIA)/,
    label: 'US30 / Dow Jones',
    body: `US30 (Dow Jones) PLAYBOOK
- 30 blue-chip mega-caps; banks, industrials weight.
- Daily ATR: 200–500 points.
- Drivers: macro data, banks earnings, industrial / energy. Less tech-sensitive than NAS100.
- Best setups: 1H/4H structure trades, NY open reversal of Asia/London move.
- Bad setups: counter-trending FOMC days, single-stock-earnings sensitive periods (post-mkt single component moves).
- Open: 14:30 UTC. Closes 21:00 UTC.`,
  },
  {
    match: /^(SPX500|SPX|SPY|S&P)/,
    label: 'SPX500 / S&P 500',
    body: `SPX500 (S&P 500) PLAYBOOK
- Risk-on/off benchmark. Daily ATR 30–80 points.
- Drivers: Fed (#1), mega-cap earnings (NVDA, AAPL, MSFT), VIX, yields.
- Best setups: opening drive (first 30m of NY) trades in trend direction; gap fills on opening gaps < 1%.
- Bad setups: counter-trending VIX direction; fading earnings beats from mega-caps.
- 0DTE options expiration: Mon/Wed/Fri afternoons can see exaggerated pinning to round levels.`,
  },
  {
    match: /^(NAS100|NDX|QQQ|NASDAQ)/,
    label: 'NAS100 / Nasdaq 100',
    body: `NAS100 (Nasdaq 100) PLAYBOOK
- Tech-heavy, more volatile than SPX. Daily ATR 150–350 points.
- Drivers: NVDA / AAPL / MSFT / TSLA single names, US 10Y yield (inverse), AI sentiment.
- Best setups: trend continuation when yields fall and VIX drops; opening 30m breakouts on trend days.
- Bad setups: trading during NVDA-style mega-earnings nights; counter-trending the daily 21EMA without BOS.
- High beta - use 1.5× stops vs SPX.`,
  },
  {
    match: /^(NVDA|AAPL|MSFT|TSLA|AMZN|GOOGL|META|AMD)/,
    label: 'US Mega-Cap Equity',
    body: `MEGA-CAP EQUITY PLAYBOOK
- Drivers: earnings, sector rotation, indices flow (passive ETF buying), CEO/analyst news.
- Best setups: post-earnings drift continuation (3–5 days after surprise beat/miss); gap & go on news catalysts; 4H BOS retests.
- Bad setups: holding into earnings without confirmed direction; counter-trending sector flow; chasing parabolic moves.
- Always check sector ETF (XLK, XLF, XLE) and SPY for context before taking a single-name trade.
- Pre-market gaps > 3% often fade by 11:00 EST.`,
  },
]

const GENERIC_FX_PLAYBOOK = `GENERIC FX PLAYBOOK
- Sessions matter most. Avoid Asia breakouts; favor London open / NY overlap.
- Pairs respect round numbers (xx.00, xx.50). Expect liquidity sweeps there.
- Most retail traders use 8 EMA, RSI, MACD - market often hunts the obvious setups.
- News risk: avoid taking new positions within 30 min of high-impact data on the involved currency.`

const GENERIC_CRYPTO_PLAYBOOK = `GENERIC CRYPTO PLAYBOOK
- 24/7 markets; US session dominates volume for majors.
- Weekend liquidity is thin - expect manipulation moves to be more pronounced.
- Funding rates: extreme positive funding = long crowd over-positioned (short bias); extreme negative = opposite.
- Always check BTC dominance before taking alt-coin trades.`

/** Resolve the best matching playbook block for a symbol; falls back to FX/crypto generic. */
export function getPairPlaybook(symbol?: string): string {
  if (!symbol) return ''
  const s = symbol.toUpperCase()
  const match = PLAYBOOKS.find((p) => p.match.test(s))
  if (match) return `INSTRUMENT PLAYBOOK - ${match.label}\n${match.body}`

  if (/^OANDA:|^[A-Z]{3}\.?[A-Z]{3}$/.test(s)) return GENERIC_FX_PLAYBOOK
  if (/^(BINANCE:|COINBASE:|BTC|ETH|SOL|XRP|ADA|DOGE)/.test(s)) return GENERIC_CRYPTO_PLAYBOOK
  return ''
}
