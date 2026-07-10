import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _helpers import authorize, cors_path, read_json_body, send_error, send_ndjson


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        path = cors_path(self)
        if path not in ("/api/python-agent/scan/stream",):
            send_error(self, 404, "Not found")
            return
        if not authorize(self):
            send_error(self, 401, "Unauthorized")
            return

        body = read_json_body(self)
        symbol = str(body.get("symbol", "")).upper().strip()
        if not symbol:
            send_error(self, 400, "Missing symbol")
            return

        symbol_label = str(body.get("symbolLabel") or symbol)
        timeframe = str(body.get("timeframe") or "1h")
        risk_budget = float(body.get("riskBudgetPct") or 1.0)
        fast = bool(body.get("fast"))
        grounding = body.get("grounding") if isinstance(body.get("grounding"), dict) else {}

        try:
            from agent_engine.pipeline import run_pipeline_streaming

            lines = list(
                run_pipeline_streaming(
                    symbol=symbol,
                    symbol_label=symbol_label,
                    timeframe=timeframe,
                    risk_budget_pct=risk_budget,
                    fast=fast,
                    grounding=grounding,
                )
            )
            send_ndjson(self, 200, lines)
        except Exception as exc:
            send_error(self, 500, f"Pipeline failed: {exc}")

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()
