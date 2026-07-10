"""Adaptive confluence scoring - regime-aware specialist weights."""

from __future__ import annotations

from typing import Literal

from agent_engine.pipeline_types import SpecialistReport

BASE_WEIGHTS: dict[str, float] = {
    "technical": 0.18,
    "momentum": 0.20,
    "regime": 0.12,
    "smc": 0.18,
    "mtf": 0.14,
    "pattern": 0.08,
    "events": 0.06,
    "sentiment": 0.04,
}


def adaptive_weights(reports: list[SpecialistReport], regime_state: str | None) -> dict[str, float]:
    """Shift weights based on detected market regime."""
    w = dict(BASE_WEIGHTS)
    state = (regime_state or "").lower()

    if "compression" in state or "sideways" in state:
        w["regime"] += 0.06
        w["smc"] += 0.04
        w["momentum"] -= 0.05
        w["pattern"] += 0.03
    elif "trending" in state:
        w["momentum"] += 0.06
        w["mtf"] += 0.04
        w["pattern"] -= 0.04
    elif "extension" in state:
        w["regime"] += 0.08
        w["momentum"] -= 0.06

    total = sum(w.values())
    return {k: v / total for k, v in w.items()}


def compute_confluence_score(
    reports: list[SpecialistReport],
    regime_state: str | None = None,
) -> dict:
    weights = adaptive_weights(reports, regime_state)
    bull = 0.0
    bear = 0.0
    weight_sum = 0.0
    avoid = False
    degraded_count = 0
    counted = 0

    for r in reports:
        rid = r.get("id", "")
        w = weights.get(rid, 0)
        conf = float(r.get("confidence", 0))
        if conf < 25:
            continue
        if r.get("degraded"):
            degraded_count += 1
        if r.get("verdict") == "AVOID" and rid == "events":
            avoid = True
        c = conf / 100.0
        verdict = r.get("verdict", "NEUTRAL")
        if verdict == "BULLISH":
            bull += w * c
        elif verdict == "BEARISH":
            bear += w * c
        weight_sum += w
        counted += 1

    rule_based_only = counted > 0 and degraded_count == counted

    if weight_sum == 0:
        return {
            "score": 0,
            "bias": "HOLD",
            "avoid": avoid,
            "bull": 0.0,
            "bear": 0.0,
            "ruleBasedOnly": rule_based_only,
            "agreement": 0.0,
        }

    dominant = max(bull, bear)
    score = round(dominant / weight_sum * 100)
    margin = abs(bull - bear) / weight_sum
    bias: Literal["BUY", "SELL", "HOLD"] = "HOLD"
    if margin >= 0.08:
        bias = "BUY" if bull > bear else "SELL"
    if avoid:
        bias = "HOLD"

    # Specialist agreement ratio (how many agree with dominant direction)
    dom_verdict = "BULLISH" if bull >= bear else "BEARISH"
    agreeing = sum(
        1
        for r in reports
        if r.get("confidence", 0) >= 45 and r.get("verdict") == dom_verdict
    )
    active = sum(1 for r in reports if r.get("confidence", 0) >= 25)
    agreement = agreeing / active if active else 0.0

    # Boost score when specialists strongly agree
    if agreement >= 0.6 and score >= 40:
        score = min(100, score + int(agreement * 10))

    return {
        "score": score,
        "bias": bias,
        "avoid": avoid,
        "bull": bull,
        "bear": bear,
        "ruleBasedOnly": rule_based_only,
        "agreement": agreement,
    }
