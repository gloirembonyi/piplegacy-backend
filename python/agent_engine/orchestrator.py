"""Decision orchestrator - synthesizes specialist reports into TradingSetup."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from agent_engine.confluence import compute_confluence_score
from agent_engine.pipeline_types import SpecialistReport, TradingSetup


def _level_multipliers(timeframe: str) -> tuple[float, float]:
    tf = timeframe.lower()
    m = {
        "5m": (0.6, 0.8),
        "15m": (0.8, 1.2),
        "30m": (1.0, 1.8),
        "1h": (1.0, 2.0),
        "4h": (1.2, 2.4),
    }
    return m.get(tf, (1.2, 2.8))


def _extract_anchor(reports: list[SpecialistReport], grounding: dict) -> tuple[float | None, float | None]:
    for rid in ("momentum", "technical"):
        for r in reports:
            if r.get("id") != rid:
                continue
            data = r.get("data") or {}
            if rid == "momentum":
                lc = data.get("lastClose")
                if lc:
                    atr_est = None
                    ind = data.get("ind") or {}
                    rh, rl = ind.get("range20High"), ind.get("range20Low")
                    if rh and rl:
                        atr_est = (rh - rl) / 20
                    tech_atr = None
                    for t in reports:
                        if t.get("id") == "technical":
                            tech_atr = (t.get("data") or {}).get("summary", {}).get("atr14")
                    return float(lc), float(tech_atr or atr_est) if (tech_atr or atr_est) else None
            if rid == "technical":
                summary = data.get("summary") or {}
                if summary.get("lastClose"):
                    return float(summary["lastClose"]), summary.get("atr14")

    quote = (grounding or {}).get("quote") or {}
    price = quote.get("price")
    return (float(price) if price else None, None)


def run_orchestrator(
    symbol: str,
    symbol_label: str,
    timeframe: str,
    grounding: dict[str, Any],
    reports: list[SpecialistReport],
    risk_budget_pct: float,
) -> TradingSetup:
    regime_rep = next((r for r in reports if r.get("id") == "regime"), None)
    regime_state = (regime_rep.get("data") or {}).get("state") if regime_rep else None

    conf = compute_confluence_score(reports, regime_state)
    score = conf["score"]
    rule_bias = conf["bias"]
    avoid = conf["avoid"]
    all_blockers = []
    for r in reports:
        for b in r.get("blockers") or []:
            all_blockers.append(b)

    anchor, atr_v = _extract_anchor(reports, grounding)
    stop_mult, target_mult = _level_multipliers(timeframe)

    momentum = next((r for r in reports if r.get("id") == "momentum"), None)
    smc_rep = next((r for r in reports if r.get("id") == "smc"), None)

    strong_momentum = (
        momentum
        if momentum
        and momentum.get("confidence", 0) >= 55
        and momentum.get("verdict") not in ("NEUTRAL", "AVOID")
        else None
    )
    strong_smc = (
        smc_rep
        if smc_rep
        and smc_rep.get("confidence", 0) >= 60
        and smc_rep.get("verdict") not in ("NEUTRAL", "AVOID")
        else None
    )

    bias = rule_bias
    if avoid:
        bias = "HOLD"
    elif bias == "HOLD" and strong_smc:
        bias = "BUY" if strong_smc.get("verdict") == "BULLISH" else "SELL"
    elif bias == "HOLD" and strong_momentum:
        bias = "BUY" if strong_momentum.get("verdict") == "BULLISH" else "SELL"
    elif bias == "HOLD" and rule_bias != "HOLD" and score >= 25:
        bias = rule_bias

    # Regime extension guard
    if regime_state in ("extension_up",) and bias == "BUY":
        bias = "HOLD"
    if regime_state in ("extension_down",) and bias == "SELL":
        bias = "HOLD"

    # Majority vote
    if bias == "HOLD" and not avoid:
        bull = sum(
            1
            for r in reports
            if r.get("verdict") == "BULLISH" and r.get("confidence", 0) >= 45
        )
        bear = sum(
            1
            for r in reports
            if r.get("verdict") == "BEARISH" and r.get("confidence", 0) >= 45
        )
        if bull >= 3 and bull > bear:
            bias = "BUY"
        elif bear >= 3 and bear > bull:
            bias = "SELL"

    entry = anchor if bias != "HOLD" else None
    stop = tp = rr = None

    if bias != "HOLD" and entry and atr_v and atr_v > 0:
        stop_dist = atr_v * stop_mult
        target_dist = atr_v * target_mult
        stop = entry - stop_dist if bias == "BUY" else entry + stop_dist
        tp = entry + target_dist if bias == "BUY" else entry - target_dist
        rr = target_dist / stop_dist if stop_dist else None
    elif bias != "HOLD" and entry:
        pct = 0.0015 if timeframe == "5m" else (0.0025 if timeframe == "15m" else 0.004)
        stop_dist = entry * pct
        target_dist = stop_dist * (target_mult / stop_mult)
        stop = entry - stop_dist if bias == "BUY" else entry + stop_dist
        tp = entry + target_dist if bias == "BUY" else entry - target_dist
        rr = target_mult / stop_mult

    rules = []
    for r in reports:
        if r.get("confidence", 0) >= 50 and r.get("verdict") not in ("NEUTRAL", "AVOID"):
            rules.append(f"{r.get('id')}={r.get('verdict', '').lower()} ({r.get('confidence')}%)")

    agreement_pct = int(conf.get("agreement", 0) * 100)
    reasoning = (
        f"{bias} on {timeframe}: {' · '.join(rules[:4])}. "
        f"Confluence {score}/100 · {agreement_pct}% specialist agreement. "
        f"(Python engine · deterministic)"
        if rules
        else f"{bias} on {timeframe} · confluence {score}/100. (Python engine)"
    )

    if avoid:
        reasoning = "Events specialist flagged news blackout - standing aside."

    valid_until = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()

    return {
        "symbol": symbol,
        "symbolLabel": symbol_label,
        "timeframe": timeframe,
        "bias": bias,
        "confluenceScore": max(0, min(100, score)),
        "entry": entry,
        "stopLoss": stop,
        "takeProfit": tp,
        "riskRewardRatio": rr,
        "suggestedRiskPct": max(0.1, min(5.0, risk_budget_pct)),
        "atr": atr_v,
        "validUntil": valid_until,
        "reasoning": reasoning[:400],
        "blockers": list(dict.fromkeys(all_blockers))[:6],
    }
