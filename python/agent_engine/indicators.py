"""Vectorized technical indicators (numpy)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from agent_engine.candles import CandleBar


@dataclass
class TechnicalSummary:
    bars: int
    last_close: float
    change_pct5: float | None
    change_pct20: float | None
    sma20: float | None
    sma50: float | None
    ema9: float | None
    ema21: float | None
    rsi14: float | None
    atr14: float | None
    swing_high20: float | None
    swing_low20: float | None
    trend: Literal["bullish", "bearish", "neutral", "choppy"]
    recent_highs: list[float]
    recent_lows: list[float]


def sma(values: np.ndarray, n: int) -> float | None:
    if len(values) < n:
        return None
    return float(np.mean(values[-n:]))


def ema(values: np.ndarray, n: int) -> float | None:
    if len(values) < n:
        return None
    k = 2.0 / (n + 1)
    prev = float(np.mean(values[:n]))
    for v in values[n:]:
        prev = float(v) * k + prev * (1 - k)
    return prev


def rsi(closes: np.ndarray, period: int = 14) -> float | None:
    if len(closes) <= period:
        return None
    deltas = np.diff(closes)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_gain = float(np.mean(gains[:period]))
    avg_loss = float(np.mean(losses[:period]))
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def atr(bars: list[CandleBar], period: int = 14) -> float | None:
    if len(bars) <= period:
        return None
    trs: list[float] = []
    for i in range(1, len(bars)):
        h, l, pc = bars[i].h, bars[i].l, bars[i - 1].c
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if len(trs) < period:
        return None
    return float(np.mean(trs[-period:]))


def find_swings(bars: list[CandleBar], lookback: int = 3) -> tuple[list[float], list[float]]:
    highs: list[float] = []
    lows: list[float] = []
    for i in range(lookback, len(bars) - lookback):
        window_h = [bars[i - k].h for k in range(1, lookback + 1)] + [
            bars[i + k].h for k in range(1, lookback + 1)
        ]
        window_l = [bars[i - k].l for k in range(1, lookback + 1)] + [
            bars[i + k].l for k in range(1, lookback + 1)
        ]
        if bars[i].h > max(window_h):
            highs.append(bars[i].h)
        if bars[i].l < min(window_l):
            lows.append(bars[i].l)
    return highs, lows


def compute_technical_summary(bars: list[CandleBar]) -> TechnicalSummary | None:
    if len(bars) < 5:
        return None
    sorted_bars = sorted(bars, key=lambda b: b.t)
    closes = np.array([b.c for b in sorted_bars], dtype=float)
    last = sorted_bars[-1]

    lb5 = sorted_bars[max(0, len(sorted_bars) - 6)]
    lb20 = sorted_bars[max(0, len(sorted_bars) - 21)]
    change_pct5 = ((last.c - lb5.c) / lb5.c * 100) if lb5.c else None
    change_pct20 = ((last.c - lb20.c) / lb20.c * 100) if lb20.c else None

    sma20_v = sma(closes, 20)
    sma50_v = sma(closes, 50)
    ema9_v = ema(closes, 9)
    ema21_v = ema(closes, 21)
    rsi14_v = rsi(closes, 14)
    atr14_v = atr(sorted_bars, 14)

    recent = sorted_bars[-20:]
    swing_high20 = max(b.h for b in recent) if recent else None
    swing_low20 = min(b.l for b in recent) if recent else None

    trend: Literal["bullish", "bearish", "neutral", "choppy"] = "neutral"
    if sma20_v is not None and sma50_v is not None:
        if last.c > sma20_v and sma20_v > sma50_v:
            trend = "bullish"
        elif last.c < sma20_v and sma20_v < sma50_v:
            trend = "bearish"
        elif abs(last.c - sma20_v) / (last.c or 1) < 0.002:
            trend = "choppy"

    rh, rl = find_swings(sorted_bars[-60:] if len(sorted_bars) >= 60 else sorted_bars)

    return TechnicalSummary(
        bars=len(sorted_bars),
        last_close=last.c,
        change_pct5=change_pct5,
        change_pct20=change_pct20,
        sma20=sma20_v,
        sma50=sma50_v,
        ema9=ema9_v,
        ema21=ema21_v,
        rsi14=rsi14_v,
        atr14=atr14_v,
        swing_high20=swing_high20,
        swing_low20=swing_low20,
        trend=trend,
        recent_highs=rh[-5:],
        recent_lows=rl[-5:],
    )


def bollinger_width(closes: np.ndarray, n: int = 20, mult: float = 2.0) -> float | None:
    if len(closes) < n:
        return None
    slice_ = closes[-n:]
    m = float(np.mean(slice_))
    sd = float(np.std(slice_))
    upper = m + mult * sd
    lower = m - mult * sd
    if m == 0:
        return None
    return (upper - lower) / m * 100
