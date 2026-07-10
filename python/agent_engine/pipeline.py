"""Multi-agent pipeline - parallel specialists + orchestrator."""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Generator

from agent_engine.orchestrator import run_orchestrator
from agent_engine.specialists import ORDER, RUNNERS
from agent_engine.pipeline_types import PipelineResult, SpecialistReport


def _normalize_timeframe(raw: str) -> str:
    if raw in ("1D", "D"):
        return "1d"
    return raw.lower()


def run_pipeline_streaming(
    symbol: str,
    symbol_label: str,
    timeframe: str = "1h",
    risk_budget_pct: float = 1.0,
    fast: bool = False,
    grounding: dict[str, Any] | None = None,
) -> Generator[str, None, None]:
    """Yield NDJSON lines compatible with lib/agent/pipeline-types PipelineEvent."""
    symbol = symbol.upper()
    tf = _normalize_timeframe(timeframe)
    risk = risk_budget_pct
    g = grounding or {}
    started_at = datetime.now(timezone.utc).isoformat()
    t0 = time.perf_counter()

    yield json.dumps({"type": "started", "symbol": symbol, "symbolLabel": symbol_label, "timeframe": tf})
    yield json.dumps({
        "type": "grounding",
        "grounding": g,
        "durationMs": 0,
        "engine": "python",
    })

    ids = [i for i in ORDER if not (fast and i in ("pattern", "sentiment"))]
    ctx = {
        "symbol": symbol,
        "symbolLabel": symbol_label,
        "timeframe": tf,
        "grounding": g,
    }

    for sid in ids:
        yield json.dumps({"type": "specialist_started", "id": sid})

    reports: list[SpecialistReport] = []

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(RUNNERS[sid], ctx): sid for sid in ids}
        for fut in as_completed(futures):
            sid = futures[fut]
            try:
                report = fut.result()
            except Exception as exc:
                report = {
                    "id": sid,
                    "verdict": "NEUTRAL",
                    "confidence": 0,
                    "headline": "Specialist crashed",
                    "durationMs": 0,
                    "degraded": True,
                    "error": str(exc),
                }
            reports.append(report)
            yield json.dumps({"type": "specialist_done", "report": report})

    yield json.dumps({"type": "orchestrator_started", "engine": "python"})

    setup = run_orchestrator(symbol, symbol_label, tf, g, reports, risk)
    finished_at = datetime.now(timezone.utc).isoformat()
    duration_ms = (time.perf_counter() - t0) * 1000

    result: PipelineResult = {
        "symbol": symbol,
        "symbolLabel": symbol_label,
        "timeframe": tf,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "durationMs": duration_ms,
        "grounding": g,
        "reports": reports,
        "setup": setup,
    }
    yield json.dumps({"type": "done", "result": result, "engine": "python"})


def run_pipeline(
    symbol: str,
    symbol_label: str,
    timeframe: str = "1h",
    risk_budget_pct: float = 1.0,
    fast: bool = False,
    grounding: dict[str, Any] | None = None,
) -> PipelineResult | None:
    last_result = None
    for line in run_pipeline_streaming(
        symbol, symbol_label, timeframe, risk_budget_pct, fast, grounding
    ):
        event = json.loads(line)
        if event.get("type") == "done":
            last_result = event.get("result")
    return last_result
