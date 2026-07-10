"""All eight specialist agents - pure Python, no LLM dependency."""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from agent_engine.candles import CandleBar, fetch_specialist_candles, timeframe_to_resolution
from agent_engine.indicators import (
    atr,
    bollinger_width,
    compute_technical_summary,
    ema,
    find_swings,
    rsi,
    sma,
)
from agent_engine.pipeline_types import SpecialistReport


def _now_ms(start: float) -> float:
    return (time.perf_counter() - start) * 1000


def run_technical(ctx: dict[str, Any]) -> SpecialistReport:
    start = time.perf_counter()
    symbol = ctx["symbol"]
    tf = ctx["timeframe"]
    res = timeframe_to_resolution(tf)
    candles = fetch_specialist_candles(symbol, res, 25)
    if len(candles.bars) < 20:
        daily = fetch_specialist_candles(symbol, "D", 20)
        if len(daily.bars) >= 20:
            candles = daily
        else:
            return {
                "id": "technical",
                "verdict": "NEUTRAL",
                "confidence": 0,
                "headline": f"Insufficient bars on {tf}",
                "durationMs": _now_ms(start),
                "degraded": True,
            }

    summary = compute_technical_summary(candles.bars)
    if not summary:
        return {
            "id": "technical",
            "verdict": "NEUTRAL",
            "confidence": 0,
            "headline": "Indicator computation failed",
            "durationMs": _now_ms(start),
            "degraded": True,
        }

    verdict = "NEUTRAL"
    confidence = 35
    if summary.trend == "bullish":
        verdict, confidence = "BULLISH", 62
    elif summary.trend == "bearish":
        verdict, confidence = "BEARISH", 62

    if summary.rsi14 is not None:
        if summary.rsi14 > 70 and verdict == "BULLISH":
            confidence = min(75, confidence + 8)
        elif summary.rsi14 < 30 and verdict == "BEARISH":
            confidence = min(75, confidence + 8)

    threshold = 0.8 if tf in ("1d", "4h") else 0.25
    if (
        verdict == "NEUTRAL"
        and summary.change_pct5 is not None
        and abs(summary.change_pct5) >= threshold
    ):
        verdict = "BULLISH" if summary.change_pct5 > 0 else "BEARISH"
        confidence = 60

    rsi_label = f"{summary.rsi14:.0f}" if summary.rsi14 is not None else "n/a"
    return {
        "id": "technical",
        "verdict": verdict,
        "confidence": confidence,
        "headline": f"{verdict.title()} TA on {tf} · RSI {rsi_label} · trend {summary.trend}",
        "durationMs": _now_ms(start),
        "data": {
            "summary": {
                "lastClose": summary.last_close,
                "sma20": summary.sma20,
                "sma50": summary.sma50,
                "rsi14": summary.rsi14,
                "atr14": summary.atr14,
                "changePct5": summary.change_pct5,
                "trend": summary.trend,
            },
            "source": candles.source,
        },
    }


def run_momentum(ctx: dict[str, Any]) -> SpecialistReport:
    start = time.perf_counter()
    symbol = ctx["symbol"]
    tf = ctx["timeframe"]
    res = timeframe_to_resolution(tf)
    candles = fetch_specialist_candles(symbol, res, 25)
    bars = candles.bars[-80:]
    if len(bars) < 25:
        return {
            "id": "momentum",
            "verdict": "NEUTRAL",
            "confidence": 0,
            "headline": f"Need 25+ bars, got {len(bars)}",
            "durationMs": _now_ms(start),
            "degraded": True,
        }

    closes = np.array([b.c for b in bars], dtype=float)
    last = bars[-1]
    ema9 = ema(closes, 9)
    ema21 = ema(closes, 21)
    ema50 = ema(closes, 50)
    rsi7 = rsi(closes, 7)

    body_ratios = [(b.c - b.o) / max(b.h - b.l, 1e-9) for b in bars]
    last5 = body_ratios[-5:]
    direction = sum(np.sign(x) for x in last5)
    recent_dir = 1 if direction >= 3 else (-1 if direction <= -3 else 0)

    range20 = bars[-21:-1]
    r_high = max(b.h for b in range20) if range20 else None
    r_low = min(b.l for b in range20) if range20 else None
    broke_up = r_high is not None and last.c > r_high and last.c > last.o
    broke_down = r_low is not None and last.c < r_low and last.c < last.o

    verdict, confidence, why = "NEUTRAL", 30, "Sideways / mixed bars"
    if broke_up:
        verdict, confidence, why = "BULLISH", 78, "Broke 20-bar high"
    elif broke_down:
        verdict, confidence, why = "BEARISH", 78, "Broke 20-bar low"
    elif ema9 and ema21 and ema9 > ema21 and last.c > ema9:
        strong = ema50 and ema21 > ema50 and rsi7 and rsi7 > 55
        verdict, confidence, why = "BULLISH", (72 if strong else 62), "EMA stack bullish"
    elif ema9 and ema21 and ema9 < ema21 and last.c < ema9:
        strong = ema50 and ema21 < ema50 and rsi7 and rsi7 < 45
        verdict, confidence, why = "BEARISH", (72 if strong else 62), "EMA stack bearish"
    elif recent_dir == 1:
        verdict, confidence, why = "BULLISH", 58, "Last 5 bars mostly green"
    elif recent_dir == -1:
        verdict, confidence, why = "BEARISH", 58, "Last 5 bars mostly red"

    return {
        "id": "momentum",
        "verdict": verdict,
        "confidence": confidence,
        "headline": f"{verdict.title()} momentum · {why}",
        "durationMs": _now_ms(start),
        "data": {
            "lastClose": last.c,
            "ind": {
                "range20High": r_high,
                "range20Low": r_low,
                "ema9": ema9,
                "ema21": ema21,
            },
            "breakout": broke_up or broke_down,
        },
    }


def run_regime(ctx: dict[str, Any]) -> SpecialistReport:
    start = time.perf_counter()
    symbol = ctx["symbol"]
    tf = ctx["timeframe"]
    res = timeframe_to_resolution(tf)
    candles = fetch_specialist_candles(symbol, res, 30)
    bars = candles.bars
    if len(bars) < 25:
        return {
            "id": "regime",
            "verdict": "NEUTRAL",
            "confidence": 30,
            "headline": "Insufficient data for regime",
            "durationMs": _now_ms(start),
            "degraded": True,
        }

    closes = np.array([b.c for b in bars], dtype=float)
    last = bars[-1]
    sma20_v = sma(closes, 20)
    atr_v = atr(bars, 14)
    bbw = bollinger_width(closes)

    state = "sideways"
    verdict = "NEUTRAL"
    confidence = 45

    if sma20_v and atr_v:
        dist_atr = abs(last.c - sma20_v) / atr_v if atr_v > 0 else 0
        if dist_atr > 2.5:
            state = "extension_up" if last.c > sma20_v else "extension_down"
            verdict = "NEUTRAL"
            confidence = 55
        elif bbw is not None and bbw < 1.5:
            state = "compression"
            verdict = "NEUTRAL"
            confidence = 50
        elif last.c > sma20_v and closes[-1] > closes[-5]:
            state = "trending_up"
            verdict = "BULLISH"
            confidence = 58
        elif last.c < sma20_v and closes[-1] < closes[-5]:
            state = "trending_down"
            verdict = "BEARISH"
            confidence = 58

    last3 = bars[-3:]
    prior5 = bars[-8:-3]
    if prior5 and last3:
        prior_up = sum(1 for b in prior5 if b.c > b.o)
        last_down = sum(1 for b in last3 if b.c < b.o)
        if prior_up >= 4 and last_down >= 2:
            state = "reversal_down"
            verdict = "BEARISH"
            confidence = 52
        prior_down = sum(1 for b in prior5 if b.c < b.o)
        last_up = sum(1 for b in last3 if b.c > b.o)
        if prior_down >= 4 and last_up >= 2:
            state = "reversal_up"
            verdict = "BULLISH"
            confidence = 52

    return {
        "id": "regime",
        "verdict": verdict,
        "confidence": confidence,
        "headline": f"Regime: {state.replace('_', ' ')}",
        "durationMs": _now_ms(start),
        "data": {"state": state, "bbw": bbw, "atr": atr_v},
        "blockers": ["Choppy regime - wait for breakout"] if state == "sideways" else None,
    }


def run_smc(ctx: dict[str, Any]) -> SpecialistReport:
    start = time.perf_counter()
    symbol = ctx["symbol"]
    tf = ctx["timeframe"]
    res = timeframe_to_resolution(tf)
    candles = fetch_specialist_candles(symbol, res, 30)
    bars = candles.bars[-60:]
    if len(bars) < 15:
        return {
            "id": "smc",
            "verdict": "NEUTRAL",
            "confidence": 25,
            "headline": "Not enough bars for SMC",
            "durationMs": _now_ms(start),
            "degraded": True,
        }

    highs, lows = find_swings(bars, 2)
    last = bars[-1]
    signals: list[tuple[str, float, str]] = []

    if highs:
        swing_h = highs[-1]
        if last.h > swing_h and last.c < swing_h:
            signals.append(("BEARISH", 75, "Bearish liquidity sweep above swing high"))
        elif last.c > swing_h:
            signals.append(("BULLISH", 68, "Bullish BOS above swing high"))

    if lows:
        swing_l = lows[-1]
        if last.l < swing_l and last.c > swing_l:
            signals.append(("BULLISH", 75, "Bullish liquidity sweep below swing low"))
        elif last.c < swing_l:
            signals.append(("BEARISH", 68, "Bearish BOS below swing low"))

    # FVG detection (3-bar imbalance)
    for i in range(2, len(bars)):
        b0, b2 = bars[i - 2], bars[i]
        if b2.l > b0.h:
            signals.append(("BULLISH", 55, f"Bullish FVG near {b0.h:.4f}"))
        if b2.h < b0.l:
            signals.append(("BEARISH", 55, f"Bearish FVG near {b0.l:.4f}"))

    if not signals:
        return {
            "id": "smc",
            "verdict": "NEUTRAL",
            "confidence": 35,
            "headline": "No SMC edge detected",
            "durationMs": _now_ms(start),
            "data": {"signalCount": 0},
        }

    best = max(signals, key=lambda s: s[1])
    verdict, confidence, headline = best[0], best[1], best[2]
    return {
        "id": "smc",
        "verdict": verdict,
        "confidence": confidence,
        "headline": headline,
        "durationMs": _now_ms(start),
        "data": {"signalCount": len(signals), "signals": [s[2] for s in signals[:3]]},
    }


def run_mtf(ctx: dict[str, Any]) -> SpecialistReport:
    start = time.perf_counter()
    symbol = ctx["symbol"]
    tf = ctx["timeframe"]
    tf_ladder = {
        "5m": ["5", "15", "60"],
        "15m": ["15", "60", "4h"],
        "30m": ["30", "60", "4h"],
        "1h": ["60", "4h", "D"],
        "4h": ["4h", "D"],
        "1d": ["D"],
    }
    resolutions = tf_ladder.get(tf, ["60", "D"])
    biases: list[str] = []

    for res in resolutions:
        candles = fetch_specialist_candles(symbol, res, 20)
        summary = compute_technical_summary(candles.bars)
        if summary:
            if summary.trend == "bullish":
                biases.append("BULLISH")
            elif summary.trend == "bearish":
                biases.append("BEARISH")
            else:
                biases.append("NEUTRAL")

    if not biases:
        return {
            "id": "mtf",
            "verdict": "NEUTRAL",
            "confidence": 30,
            "headline": "MTF data unavailable",
            "durationMs": _now_ms(start),
            "degraded": True,
        }

    bull = biases.count("BULLISH")
    bear = biases.count("BEARISH")
    aligned = max(bull, bear)
    total = len(biases)

    if aligned == total and bull == total:
        verdict, confidence = "BULLISH", 72
        headline = f"All {total} timeframes aligned bullish"
    elif aligned == total and bear == total:
        verdict, confidence = "BEARISH", 72
        headline = f"All {total} timeframes aligned bearish"
    elif bull > bear:
        verdict, confidence = "BULLISH", 50 + bull * 8
        headline = f"{bull}/{total} TFs bullish"
    elif bear > bull:
        verdict, confidence = "BEARISH", 50 + bear * 8
        headline = f"{bear}/{total} TFs bearish"
    else:
        verdict, confidence = "NEUTRAL", 35
        headline = "Mixed timeframe alignment"

    return {
        "id": "mtf",
        "verdict": verdict,
        "confidence": min(confidence, 85),
        "headline": headline,
        "durationMs": _now_ms(start),
        "data": {"biases": biases, "alignment": aligned / total if total else 0},
    }


def run_pattern(ctx: dict[str, Any]) -> SpecialistReport:
    start = time.perf_counter()
    symbol = ctx["symbol"]
    tf = ctx["timeframe"]
    res = timeframe_to_resolution(tf)
    candles = fetch_specialist_candles(symbol, res, 25)
    bars = candles.bars[-10:]
    if len(bars) < 5:
        return {
            "id": "pattern",
            "verdict": "NEUTRAL",
            "confidence": 25,
            "headline": "Too few bars for patterns",
            "durationMs": _now_ms(start),
            "degraded": True,
        }

    patterns: list[tuple[str, float, str]] = []
    b = bars[-1]
    body = abs(b.c - b.o)
    rng = b.h - b.l or 1e-9
    upper_wick = b.h - max(b.c, b.o)
    lower_wick = min(b.c, b.o) - b.l

    if lower_wick > body * 2 and upper_wick < body * 0.5:
        patterns.append(("BULLISH", 62, "Hammer / rejection wick"))
    if upper_wick > body * 2 and lower_wick < body * 0.5:
        patterns.append(("BEARISH", 62, "Shooting star / rejection wick"))
    if body / rng > 0.7:
        direction = "BULLISH" if b.c > b.o else "BEARISH"
        patterns.append((direction, 58, f"Strong {'bull' if direction == 'BULLISH' else 'bear'} body candle"))

    if len(bars) >= 3:
        a, c = bars[-3], bars[-1]
        mid = bars[-2]
        if c.c > a.c and mid.h < max(a.h, c.h) and mid.l > min(a.l, c.l):
            patterns.append(("BULLISH", 65, "Bullish flag / consolidation breakout"))
        if c.c < a.c and mid.h < max(a.h, c.h):
            patterns.append(("BEARISH", 65, "Bearish flag / consolidation breakdown"))

    if not patterns:
        return {
            "id": "pattern",
            "verdict": "NEUTRAL",
            "confidence": 32,
            "headline": "No clear candle pattern",
            "durationMs": _now_ms(start),
        }

    best = max(patterns, key=lambda p: p[1])
    return {
        "id": "pattern",
        "verdict": best[0],
        "confidence": best[1],
        "headline": best[2],
        "durationMs": _now_ms(start),
        "data": {"patterns": [p[2] for p in patterns]},
    }


def run_events(ctx: dict[str, Any]) -> SpecialistReport:
    start = time.perf_counter()
    grounding = ctx.get("grounding") or {}
    symbol = ctx.get("symbolLabel") or ctx.get("symbol", "")

    blackout = bool(grounding.get("newsBlackout"))
    reason = grounding.get("newsBlackoutReason") or "High-impact event window"
    liquidity = grounding.get("liquidity", "Medium")
    sessions = grounding.get("activeSessions") or []
    next_event = grounding.get("nextHighImpact")

    if blackout:
        return {
            "id": "events",
            "verdict": "AVOID",
            "confidence": 85,
            "headline": f"News blackout · {reason[:80]}",
            "durationMs": _now_ms(start),
            "blockers": [reason],
            "data": {"blackout": True, "liquidity": liquidity},
        }

    headline = f"{liquidity} liquidity · sessions: {', '.join(sessions) or 'none'}"
    confidence = 50
    verdict = "NEUTRAL"
    blockers: list[str] = []

    if liquidity == "Low":
        blockers.append("Low liquidity - widen stops or wait for session open")
        confidence = 42

    if next_event:
        mins = next_event.get("minutesUntil")
        if mins is not None and 0 < mins <= 60:
            headline = f"High-impact in {mins}m · {next_event.get('event', 'event')}"
            confidence = 55

    return {
        "id": "events",
        "verdict": verdict,
        "confidence": confidence,
        "headline": headline,
        "durationMs": _now_ms(start),
        "blockers": blockers or None,
        "data": {"liquidity": liquidity, "sessions": sessions},
    }


def run_sentiment(ctx: dict[str, Any]) -> SpecialistReport:
    start = time.perf_counter()
    grounding = ctx.get("grounding") or {}
    quote = grounding.get("quote") or {}
    change = quote.get("changePercent")
    price = quote.get("price")

    if change is None:
        return {
            "id": "sentiment",
            "verdict": "NEUTRAL",
            "confidence": 30,
            "headline": "No live quote for sentiment",
            "durationMs": _now_ms(start),
            "degraded": True,
        }

    ch = float(change)
    if ch >= 0.5:
        verdict, confidence = "BULLISH", min(70, 50 + int(ch * 5))
        headline = f"Risk-on tone · +{ch:.2f}% today"
    elif ch <= -0.5:
        verdict, confidence = "BEARISH", min(70, 50 + int(abs(ch) * 5))
        headline = f"Risk-off tone · {ch:.2f}% today"
    else:
        verdict, confidence = "NEUTRAL", 40
        headline = f"Flat session · {ch:+.2f}%"

    return {
        "id": "sentiment",
        "verdict": verdict,
        "confidence": confidence,
        "headline": headline,
        "durationMs": _now_ms(start),
        "data": {"changePercent": ch, "price": price},
    }


RUNNERS = {
    "regime": run_regime,
    "smc": run_smc,
    "technical": run_technical,
    "momentum": run_momentum,
    "mtf": run_mtf,
    "pattern": run_pattern,
    "events": run_events,
    "sentiment": run_sentiment,
}

ORDER = ["regime", "smc", "technical", "momentum", "mtf", "pattern", "events", "sentiment"]
