"""Health check per il deploy Vercel: dice se la chiave Gemini è configurata."""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler

DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite").strip() or "gemini-3.5-flash-lite"
BUILTIN_FALLBACK_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-flash-latest",
]
FALLBACK_MODELS = [
    entry.strip()
    for entry in os.environ.get("GEMINI_FALLBACK_MODELS", ",".join(BUILTIN_FALLBACK_MODELS)).split(",")
    if entry.strip()
]


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        payload = {
            "proxy": True,
            "configured": bool(os.environ.get("GEMINI_API_KEY", "").strip()),
            "model": DEFAULT_MODEL,
            "fallbackModels": FALLBACK_MODELS,
        }
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return
