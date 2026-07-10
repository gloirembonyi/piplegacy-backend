"""Yahoo Finance candle fetcher - mirrors lib/agent/specialists/candles.ts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

import numpy as np
import pandas as pd
import yfinance as yf

Source = Literal["yahoo", "none"]


@dataclass
class CandleBar:
    t: int
    o: float
    h: float
    l: float
    c: float
    v: float = 0.0


@dataclass
class SpecialistCandles:
    bars: list[CandleBar]
    source: Source
    resolution: str


YAHOO_MAP: dict[str, str] = {
    "XAUUSD": "GC=F",
    "XAGUSD": "SI=F",
    "EURUSD": "EURUSD=X",
    "GBPUSD": "GBPUSD=X",
    "USDJPY": "USDJPY=X",
    "AUDUSD": "AUDUSD=X",
    "USDCAD": "USDCAD=X",
    "NZDUSD": "NZDUSD=X",
    "BTCUSD": "BTC-USD",
    "ETHUSD": "ETH-USD",
    "SOLUSD": "SOL-USD",
}

_COL_ALIASES = {
    "open": "Open",
    "high": "High",
    "low": "Low",
    "close": "Close",
    "volume": "Volume",
    "adj close": "Close",
}


def normalize_resolution(resolution: str) -> str:
    m = {"1d": "D", "1D": "D", "4h": "4h", "1h": "60", "60m": "60"}
    return m.get(resolution, resolution)


def timeframe_to_resolution(tf: str) -> str:
    m = {"5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "4h", "1d": "D", "D": "D"}
    return m.get(tf, tf)


def yahoo_ticker(symbol: str) -> str:
    s = symbol.upper().replace("OANDA:", "").replace("BINANCE:", "")
    if s in YAHOO_MAP:
        return YAHOO_MAP[s]
    if s.endswith("USD") and len(s) == 6:
        return f"{s[:3]}{s[3:]}=X"
    return s


def _to_float(value: Any) -> float:
    """Coerce yfinance/pandas/numpy values to a plain float."""
    if value is None:
        return 0.0
    if isinstance(value, pd.Series):
        value = value.iloc[-1] if len(value) else np.nan
    elif isinstance(value, pd.DataFrame):
        value = value.iloc[-1, -1] if value.size else np.nan
    elif isinstance(value, np.ndarray):
        value = value.flat[-1] if value.size else np.nan
    try:
        v = float(value)
        return v if np.isfinite(v) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _normalize_ohlcv_df(df: pd.DataFrame | None) -> pd.DataFrame | None:
    """Flatten MultiIndex columns from yfinance into Open/High/Low/Close/Volume."""
    if df is None or df.empty:
        return None

    out = df.copy()

    if isinstance(out.columns, pd.MultiIndex):
        # yfinance >= 0.2.40: columns like ('Close', 'GC=F') or ('Close', '')
        level0 = [str(c[0]) if isinstance(c, tuple) else str(c) for c in out.columns]
        out.columns = level0

    rename: dict[str, str] = {}
    for col in out.columns:
        key = str(col).strip().lower()
        if key in _COL_ALIASES:
            rename[col] = _COL_ALIASES[key]
    if rename:
        out = out.rename(columns=rename)

    required = ["Open", "High", "Low", "Close"]
    if not all(c in out.columns for c in required):
        return None

    out = out.dropna(subset=["Close"])
    return out if not out.empty else None


def _interval_period(res: str) -> tuple[str, str]:
    if res == "D":
        return "1d", "400d"
    if res == "4h":
        return "1h", "180d"
    if res == "60":
        return "1h", "60d"
    if res == "30":
        return "30m", "21d"
    if res == "15":
        return "15m", "14d"
    if res == "5":
        return "5m", "7d"
    n = int(res) if res.isdigit() else 60
    return f"{n}m", "7d"


def _df_to_bars(df: pd.DataFrame) -> list[CandleBar]:
    """Vectorized OHLCV → CandleBar list (avoids iterrows Series bugs)."""
    opens = np.asarray(df["Open"], dtype=float)
    highs = np.asarray(df["High"], dtype=float)
    lows = np.asarray(df["Low"], dtype=float)
    closes = np.asarray(df["Close"], dtype=float)
    volumes = (
        np.asarray(df["Volume"], dtype=float)
        if "Volume" in df.columns
        else np.zeros(len(df))
    )

    bars: list[CandleBar] = []
    for i, ts in enumerate(df.index):
        c = closes[i]
        if not np.isfinite(c) or c <= 0:
            continue
        if hasattr(ts, "timestamp"):
            t = int(ts.timestamp())
        else:
            t = int(datetime.now(timezone.utc).timestamp())
        bars.append(
            CandleBar(
                t=t,
                o=_to_float(opens[i]),
                h=_to_float(highs[i]),
                l=_to_float(lows[i]),
                c=_to_float(c),
                v=_to_float(volumes[i]),
            )
        )
    return bars


def fetch_specialist_candles(
    symbol: str, resolution: str, min_bars: int | None = None
) -> SpecialistCandles:
    res = normalize_resolution(resolution)
    need = min_bars or (30 if res == "D" else 20)
    ticker = yahoo_ticker(symbol)
    interval, period = _interval_period(res)

    try:
        df = yf.download(
            ticker,
            period=period,
            interval=interval,
            progress=False,
            auto_adjust=True,
            threads=False,
            multi_level_index=False,
        )
    except TypeError:
        # Older yfinance without multi_level_index kwarg
        try:
            df = yf.download(
                ticker,
                period=period,
                interval=interval,
                progress=False,
                auto_adjust=True,
                threads=False,
            )
        except Exception:
            return SpecialistCandles(bars=[], source="none", resolution=res)
    except Exception:
        return SpecialistCandles(bars=[], source="none", resolution=res)

    df = _normalize_ohlcv_df(df)
    if df is None:
        return SpecialistCandles(bars=[], source="none", resolution=res)

    bars = _df_to_bars(df)
    if bars:
        return SpecialistCandles(bars=bars, source="yahoo", resolution=res)
    return SpecialistCandles(bars=[], source="none", resolution=res)
