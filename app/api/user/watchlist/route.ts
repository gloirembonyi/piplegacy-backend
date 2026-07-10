import { NextResponse } from 'next/server'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { getUserData, patchWatchlist, updateWatchlist } from '@/lib/user-store'

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  const data = await getUserData(auth.email)
  return NextResponse.json({
    watchlist: data.watchlist,
    favorites: data.favorites ?? [],
    email: auth.email,
  })
}

export async function PUT(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  try {
    const body = await request.json()
    const symbols = Array.isArray(body.watchlist) ? body.watchlist : []
    const favorites = Array.isArray(body.favorites) ? body.favorites : undefined
    if (symbols.length === 0) {
      return NextResponse.json({ error: 'Watchlist cannot be empty' }, { status: 400 })
    }

    const data = await updateWatchlist(auth.email, symbols, favorites)
    return NextResponse.json({
      watchlist: data.watchlist,
      favorites: data.favorites ?? [],
      email: auth.email,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid watchlist' }, { status: 400 })
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAuth(request)
  if (!isAuthSession(auth)) return auth

  try {
    const body = await request.json()
    const action = body.action as 'add' | 'remove' | 'toggleFavorite'
    const symbol = typeof body.symbol === 'string' ? body.symbol : ''

    if (!['add', 'remove', 'toggleFavorite'].includes(action) || !symbol) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const data = await patchWatchlist(auth.email, action, symbol)
    return NextResponse.json({
      watchlist: data.watchlist,
      favorites: data.favorites ?? [],
      email: auth.email,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown'
    if (message === 'WATCHLIST_FULL') {
      return NextResponse.json({ error: 'Watchlist is full (max 12 symbols)' }, { status: 400 })
    }
    if (message === 'WATCHLIST_EMPTY') {
      return NextResponse.json({ error: 'Watchlist cannot be empty' }, { status: 400 })
    }
    if (message === 'INVALID_SYMBOL') {
      return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 })
    }
    return NextResponse.json({ error: 'Failed to update watchlist' }, { status: 400 })
  }
}
