/**
 * Search deferred / extended tool catalog (claw-code-parity ToolSearch).
 */

import { listRegisteredToolNames } from '@/lib/ai-tools/registry'
import { AGENT_TOOL_META } from '@/lib/agent-work-ui'

export type ToolSearchHit = {
  name: string
  label: string
  category: string
  score: number
}

const CATEGORY_HINTS: Record<string, string[]> = {
  market: ['quote', 'technical', 'candle', 'calendar', 'session', 'volume', 'orderbook', 'deep_market', 'metal', 'crypto', 'global'],
  research: ['search', 'news', 'web', 'fetch', 'catalyst', 'research'],
  chart: ['chart_mcp', 'draw', 'clear'],
  tradingview: ['tradingview'],
  agent: ['agent_', 'todo', 'skill', 'background', 'ask'],
}

function toolCategory(name: string): string {
  if (name.startsWith('chart_mcp')) return 'chart'
  if (name.startsWith('tradingview')) return 'tradingview'
  if (name.startsWith('agent_')) return 'agent'
  if (name.includes('crypto')) return 'market'
  if (/search|news|web|fetch|catalyst/.test(name)) return 'research'
  return 'market'
}

function scoreTool(name: string, query: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return 0

  const label = AGENT_TOOL_META[name]?.label ?? name.replace(/_/g, ' ')
  const haystack = `${name} ${label} ${toolCategory(name)}`.toLowerCase()

  if (name.toLowerCase() === q) return 100
  if (name.toLowerCase().includes(q)) return 80
  if (label.toLowerCase().includes(q)) return 70

  let score = 0
  for (const term of q.split(/\s+/)) {
    if (term.length < 2) continue
    if (haystack.includes(term)) score += 15
    for (const [cat, hints] of Object.entries(CATEGORY_HINTS)) {
      if (hints.some((h) => term.includes(h) || h.includes(term)) && toolCategory(name) === cat) {
        score += 10
      }
    }
  }
  return score
}

export function searchAgentTools(query: string, maxResults = 8): ToolSearchHit[] {
  const names = listRegisteredToolNames()
  const scored = names
    .map((name) => ({
      name,
      label: AGENT_TOOL_META[name]?.label ?? name.replace(/_/g, ' '),
      category: toolCategory(name),
      score: scoreTool(name, query),
    }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, maxResults))

  return scored
}

export function describeAllTools(): Array<{ name: string; label: string; category: string }> {
  return listRegisteredToolNames().map((name) => ({
    name,
    label: AGENT_TOOL_META[name]?.label ?? name.replace(/_/g, ' '),
    category: toolCategory(name),
  }))
}

/** Compact grouped catalog for the manager prompt (claw-code-parity tool pool). */
export function renderCompactToolCatalogForPrompt(): string {
  const byCategory = new Map<string, string[]>()
  for (const { name, label, category } of describeAllTools()) {
    const list = byCategory.get(category) ?? []
    list.push(`${name} (${label})`)
    byCategory.set(category, list)
  }
  const lines = ['FULL TOOL CATALOG (grouped - use agent_search_tools to find by keyword):']
  for (const [cat, items] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${cat}: ${items.join(', ')}`)
  }
  return lines.join('\n')
}
