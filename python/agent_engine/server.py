"""FastAPI server - HTTP bridge for Next.js pipeline."""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from agent_engine.pipeline import run_pipeline, run_pipeline_streaming

app = FastAPI(title="Market Signal Python Agent Engine", version="1.0.0")


class ScanRequest(BaseModel):
    symbol: str
    symbolLabel: str = ""
    timeframe: str = "1h"
    riskBudgetPct: float = Field(default=1.0, ge=0.1, le=5.0)
    fast: bool = False
    grounding: dict[str, Any] = Field(default_factory=dict)


@app.get("/health")
def health():
    return {"ok": True, "engine": "python", "version": "1.0.0"}


@app.post("/scan")
def scan(body: ScanRequest):
    label = body.symbolLabel or body.symbol
    result = run_pipeline(
        symbol=body.symbol,
        symbol_label=label,
        timeframe=body.timeframe,
        risk_budget_pct=body.riskBudgetPct,
        fast=body.fast,
        grounding=body.grounding,
    )
    if not result:
        return JSONResponse({"error": "Pipeline produced no result"}, status_code=500)
    return result


@app.post("/scan/stream")
def scan_stream(body: ScanRequest):
    label = body.symbolLabel or body.symbol

    def generate():
        for line in run_pipeline_streaming(
            symbol=body.symbol,
            symbol_label=label,
            timeframe=body.timeframe,
            risk_budget_pct=body.riskBudgetPct,
            fast=body.fast,
            grounding=body.grounding,
        ):
            yield line + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Engine": "python"},
    )


def main():
    import uvicorn

    host = os.environ.get("PYTHON_AGENT_HOST", "127.0.0.1")
    port = int(os.environ.get("PYTHON_AGENT_PORT", "8765"))
    reload = os.environ.get("PYTHON_AGENT_RELOAD", "0") in ("1", "true", "yes")
    uvicorn.run(
        "agent_engine.server:app",
        host=host,
        port=port,
        log_level="info",
        reload=reload,
        reload_dirs=[os.path.dirname(os.path.dirname(__file__))],
    )


if __name__ == "__main__":
    main()
