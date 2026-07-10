import { NextResponse } from 'next/server'
import {
  fetchMarketNewsFeed,
  formatTimeAgo,
  sentimentFromHeadline,
} from '@/lib/finnhub'
import { isAuthSession, requireAuth } from '@/lib/require-auth'

export const dynamic = 'force-dynamic'

function classifyImpact(headline: string, summary: string): 'High' | 'Medium' | 'Low' {
  const text = `${headline} ${summary}`.toLowerCase()
  if (/fed|fomc|rate decision|cpi|inflation|gdp|nfp|payroll|ecb|boe|war|crisis|default/i.test(text)) {
    return 'High'
  }
  if (/earnings|forecast|pmi|unemployment|trade balance|oil|gold|bitcoin|forex/i.test(text)) {
    return 'Medium'
  }
  return 'Low'
}

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const { searchParams } = new URL(request.url)
  const limit = Math.min(40, Math.max(5, Number(searchParams.get('limit')) || 24))

  try {
    const articles = await fetchMarketNewsFeed(limit)

    const news = articles.map((a) => ({
      id: a.id,
      title: a.headline,
      summary: a.summary?.slice(0, 220) || '',
      source: a.source,
      url: a.url,
      time: formatTimeAgo(a.datetime),
      sentiment: sentimentFromHeadline(a.headline),
      impact: classifyImpact(a.headline, a.summary || ''),
      category: /forex|fx|currency|dollar|euro|yen|pound/i.test(
        `${a.headline} ${a.summary}`
      )
        ? 'forex'
        : 'markets',
    }))

    const hot = [...news]
      .sort((a, b) => {
        const score = (n: typeof a) =>
          (n.impact === 'High' ? 3 : n.impact === 'Medium' ? 2 : 1) +
          (n.sentiment !== 'neutral' ? 1 : 0)
        return score(b) - score(a)
      })
      .slice(0, 8)

    return NextResponse.json({
      news,
      hot,
      timestamp: new Date().toISOString(),
      source: 'finnhub',
    })
  } catch (error) {
    console.error('Market news error:', error)
    return NextResponse.json({ news: [], hot: [], error: 'Failed to fetch news' }, { status: 500 })
  }
}
