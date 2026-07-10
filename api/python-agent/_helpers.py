"""Shared helpers for Vercel Python serverless functions."""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from typing import Any
from urllib.parse import urlparse

# Make `agent_engine` importable from repo python/ package.
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_PYTHON = os.path.join(_ROOT, "python")
if _PYTHON not in sys.path:
    sys.path.insert(0, _PYTHON)


def agent_secret() -> str:
    return (
        os.environ.get("PYTHON_AGENT_SECRET")
        or os.environ.get("CRON_SECRET")
        or os.environ.get("SESSION_SECRET")
        or ""
    ).strip()


def authorize(handler: BaseHTTPRequestHandler) -> bool:
    secret = agent_secret()
    if not secret:
        return True
    got = handler.headers.get("X-Python-Agent-Secret", "").strip()
    return got == secret


def read_json_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length) if length > 0 else b"{}"
    try:
        parsed = json.loads(raw.decode("utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def send_json(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def send_ndjson(handler: BaseHTTPRequestHandler, status: int, lines: list[str]) -> None:
    body = ("\n".join(lines) + ("\n" if lines else "")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/x-ndjson")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-cache, no-transform")
    handler.end_headers()
    handler.wfile.write(body)


def send_error(handler: BaseHTTPRequestHandler, status: int, message: str) -> None:
    send_json(handler, status, {"error": message})


def cors_path(handler: BaseHTTPRequestHandler) -> str:
    return urlparse(handler.path).path
