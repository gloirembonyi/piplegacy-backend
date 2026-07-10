"""Shared types mirroring lib/agent/pipeline-types.ts."""

from __future__ import annotations

from typing import Any, Literal, TypedDict

SpecialistId = Literal[
    "technical",
    "momentum",
    "regime",
    "smc",
    "mtf",
    "pattern",
    "events",
    "sentiment",
]

SpecialistVerdict = Literal["BULLISH", "BEARISH", "NEUTRAL", "AVOID"]


class SpecialistReport(TypedDict, total=False):
    id: SpecialistId
    verdict: SpecialistVerdict
    confidence: float
    headline: str
    data: dict[str, Any]
    blockers: list[str]
    durationMs: float
    degraded: bool
    error: str


class TradingSetup(TypedDict, total=False):
    symbol: str
    symbolLabel: str
    timeframe: str
    bias: Literal["BUY", "SELL", "HOLD"]
    confluenceScore: float
    entry: float | None
    stopLoss: float | None
    takeProfit: float | None
    riskRewardRatio: float | None
    suggestedRiskPct: float
    atr: float | None
    validUntil: str | None
    reasoning: str
    blockers: list[str]


class PipelineResult(TypedDict):
    symbol: str
    symbolLabel: str
    timeframe: str
    startedAt: str
    finishedAt: str
    durationMs: float
    grounding: dict[str, Any]
    reports: list[SpecialistReport]
    setup: TradingSetup
