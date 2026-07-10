/**
 * Smart Money & Liquidity Analyst - persona and synthesis helpers.
 */

export const SMART_MONEY_ANALYST_PERSONA = `You are a Smart Money & Liquidity Analyst. Analyze market structure, liquidity pools, equal highs/lows, support/resistance, volume, and order flow. Detect stop-loss hunts, liquidity grabs, inducement, bull traps, bear traps, false breakouts, and liquidation cascades. Identify where retail traders are likely trapped and where institutions may seek liquidity. Predict the highest-probability next move based on market structure and liquidity - not indicators alone. Mark key entry zones, invalidation levels, and profit targets. Assign confidence (0–100%) and explain reasoning step-by-step. Always distinguish CONFIRMED signals (sweep + close back, BOS/CHoCH with structure) from SPECULATIVE scenarios (equal highs/lows, unmitigated FVG/OB, inducement without follow-through). Never assume manipulation without evidence from price action and liquidity behavior.`

export function formatSmcAnalysisForPrompt(data: {
  primary?: { resolution: string; analysis: Record<string, unknown> | null }
  htf?: { resolution: string; analysis: Record<string, unknown> | null }
  volumeProfile?: Record<string, unknown> | null
  orderbook?: Record<string, unknown> | null
  sessions?: Record<string, unknown> | null
  timeframeNote?: string
}): string[] {
  const lines: string[] = [
    SMART_MONEY_ANALYST_PERSONA,
    '',
    'EVIDENCE FROM LIQUIDITY SCOUT (rule-based - treat as facts):',
  ]
  if (data.timeframeNote) lines.push(`Timeframe policy: ${data.timeframeNote}`)

  const renderAnalysis = (label: string, raw: Record<string, unknown> | null | undefined) => {
    if (!raw) return
    const verdict = raw.verdict as string | undefined
    const confidence = raw.confidence as number | undefined
    const headline = raw.headline as string | undefined
    lines.push(`\n${label}:`)
    if (verdict) lines.push(`Bias: ${verdict}${confidence != null ? ` · confidence ${confidence}%` : ''}`)
    if (headline) lines.push(`Headline: ${headline}`)
    const confirmed = raw.confirmed as Array<{ detail: string }> | undefined
    if (confirmed?.length) {
      lines.push('Confirmed (price-action evidence):')
      for (const c of confirmed.slice(0, 4)) lines.push(`  • ${c.detail}`)
    }
    const speculative = raw.speculative as Array<{ detail: string }> | undefined
    if (speculative?.length) {
      lines.push('Speculative (needs confirmation):')
      for (const s of speculative.slice(0, 4)) lines.push(`  • ${s.detail}`)
    }
    const pools = raw.liquidityPools as Array<{ detail: string }> | undefined
    if (pools?.length) {
      lines.push('Liquidity pools (retail stop clusters):')
      for (const p of pools.slice(0, 3)) lines.push(`  • ${p.detail}`)
    }
    const blockers = raw.blockers as string[] | undefined
    if (blockers?.length) lines.push(`Caution: ${blockers.join('; ')}`)
  }

  renderAnalysis(`Primary TF (${data.primary?.resolution ?? '?'})`, data.primary?.analysis ?? null)
  renderAnalysis(`HTF (${data.htf?.resolution ?? '?'})`, data.htf?.analysis ?? null)

  const vp = data.volumeProfile as { pocPrice?: number; valueAreaLow?: number; valueAreaHigh?: number } | null
  if (vp?.pocPrice != null) {
    lines.push(`\nVolume POC (magnet): ${vp.pocPrice.toFixed(2)}`)
    if (vp.valueAreaLow != null && vp.valueAreaHigh != null) {
      lines.push(`Value area: ${vp.valueAreaLow.toFixed(2)} – ${vp.valueAreaHigh.toFixed(2)}`)
    }
  }

  const ob = data.orderbook as { imbalance?: string } | null
  if (ob?.imbalance) lines.push(`Order-book imbalance: ${ob.imbalance}`)

  const sess = data.sessions as {
    activeSessions?: string[]
    liquidity?: string
    nextSession?: { name?: string; opensIn?: string } | null
  } | null
  if (sess?.activeSessions?.length) {
    lines.push(
      `Session: ${sess.activeSessions.join('+')} · liquidity ${sess.liquidity ?? 'n/a'}${sess.nextSession?.opensIn ? ` · next ${sess.nextSession.name} ${sess.nextSession.opensIn}` : ''}`
    )
  }

  lines.push(
    '',
    'SYNTHESIS RULES:',
    '- Anchor entry/stop/target to CONFIRMED sweeps, OB/FVG, and swing liquidity - not indicator crosses alone.',
    '- Place stops BEYOND the liquidity pool that would invalidate the thesis (not on the pool itself).',
    '- If only speculative signals exist → bias WAIT with triggerZone + invalidation.',
    '- Mention retail trap risk when inducement or equal-high/low pools sit between price and target.'
  )

  return lines
}
