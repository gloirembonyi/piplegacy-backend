import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { addUserAnalysis, getUserData } from '@/lib/user-store'

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const data = await getUserData(auth.email)
  return NextResponse.json({ analyses: data.analyses, email: auth.email })
}

export async function POST(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  try {
    const body = await request.json()
    const signal = ['BUY', 'SELL', 'HOLD'].includes(String(body.signal))
      ? String(body.signal)
      : 'HOLD'
    const probability = Number(body.probability ?? 0)
    const prediction = String(body.prediction ?? '')
    const riskLevel = body.riskLevel ? String(body.riskLevel) : undefined
    const timeframe = body.timeframe ? String(body.timeframe) : undefined

    const data = await addUserAnalysis(auth.email, {
      signal,
      probability,
      prediction,
      riskLevel,
      timeframe,
    })

    return NextResponse.json({ analyses: data.analyses, email: auth.email })
  } catch {
    return NextResponse.json({ error: 'Failed to save analysis' }, { status: 400 })
  }
}
