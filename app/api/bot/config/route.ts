import { isAuthSession, requireAuth } from '@/lib/require-auth'
import {
  getBotConfig,
  removeStrategy,
  resetKillSwitch,
  saveBotConfig,
  STRATEGY_TIMEFRAMES,
  tripKillSwitch,
  upsertStrategy,
  type BotStrategy,
  type StrategyTimeframe,
} from '@/lib/bot-config-store'

export async function GET(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth
  const cfg = await getBotConfig(auth.email)
  return Response.json(cfg)
}

type StrategyPatch = Partial<BotStrategy> & { id?: string }

type PostBody = {
  action: 'upsert' | 'delete' | 'trip' | 'reset' | 'setDailyLossPct'
  strategy?: StrategyPatch
  id?: string
  reason?: string
  dailyLossPct?: number
}

function isValidTimeframe(tf: unknown): tf is StrategyTimeframe {
  return typeof tf === 'string' && (STRATEGY_TIMEFRAMES as string[]).includes(tf)
}

export async function POST(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth
  const body = (await req.json().catch(() => null)) as PostBody | null
  if (!body) return Response.json({ error: 'Invalid body' }, { status: 400 })

  if (body.action === 'upsert') {
    if (!body.strategy) {
      return Response.json({ error: 'Missing strategy' }, { status: 400 })
    }
    if (body.strategy.timeframe && !isValidTimeframe(body.strategy.timeframe)) {
      return Response.json({ error: 'Invalid timeframe' }, { status: 400 })
    }
    try {
      const saved = await upsertStrategy(auth.email, body.strategy)
      return Response.json({ ok: true, strategy: saved })
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'Save failed' },
        { status: 400 }
      )
    }
  }

  if (body.action === 'delete') {
    if (!body.id) return Response.json({ error: 'Missing id' }, { status: 400 })
    await removeStrategy(auth.email, body.id)
    return Response.json({ ok: true })
  }

  if (body.action === 'trip') {
    await tripKillSwitch(auth.email, body.reason ?? 'Manual')
    return Response.json({ ok: true })
  }

  if (body.action === 'reset') {
    await resetKillSwitch(auth.email)
    return Response.json({ ok: true })
  }

  if (body.action === 'setDailyLossPct') {
    const cfg = await getBotConfig(auth.email)
    const pct = Number(body.dailyLossPct)
    if (!Number.isFinite(pct) || pct < 0.5 || pct > 20) {
      return Response.json(
        { error: 'dailyLossPct must be between 0.5 and 20' },
        { status: 400 }
      )
    }
    cfg.killSwitch.dailyLossPct = pct
    await saveBotConfig(cfg)
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 })
}
