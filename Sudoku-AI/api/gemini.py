"""Proxy Gemini per Vercel: stessa logica di server.py, senza file .env.

La chiave viene letta dalla variabile d'ambiente GEMINI_API_KEY impostata
nel pannello Vercel (Settings -> Environment Variables).
"""

from __future__ import annotations

import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler

GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
MODEL_RE = re.compile(r"^gemini-[A-Za-z0-9._-]{1,80}$")
MAX_BODY_BYTES = 16 * 1024 * 1024
ALLOWED_PAYLOAD_KEYS = {"contents", "generationConfig", "safetySettings", "systemInstruction"}

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
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
RETRYABLE_STATUS = {404, 429, 500, 502, 503, 504}

# Vercel Hobby: massimo 60 secondi per function. Questi valori lasciano margine.
TRY_DEADLINE_SECONDS = 40
TRY_DEADLINE_MEDIA_SECONDS = 50
TRY_TIMEOUT_SECONDS = 20
TRY_TIMEOUT_MEDIA_SECONDS = 30


def model_chain(requested: str) -> list[str]:
    chain: list[str] = []
    for name in [requested, DEFAULT_MODEL, *FALLBACK_MODELS]:
        if name and name not in chain and MODEL_RE.match(name):
            chain.append(name)
    return chain


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        self.send_error_json(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD", "Usa POST su /api/gemini.")

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/api/gemini":
            self.send_error_json(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Endpoint non trovato.")
            return

        if not API_KEY:
            self.send_error_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "NO_KEY",
                "GEMINI_API_KEY non configurata nelle Environment Variables di Vercel.",
            )
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "BAD_LENGTH", "Content-Length non valido.")
            return

        if length <= 0 or length > MAX_BODY_BYTES:
            self.send_error_json(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "BAD_SIZE",
                "Richiesta vuota o troppo grande (massimo 16 MB).",
            )
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error_json(HTTPStatus.BAD_REQUEST, "BAD_JSON", "Corpo della richiesta non valido.")
            return

        if not isinstance(payload, dict):
            self.send_error_json(HTTPStatus.BAD_REQUEST, "BAD_JSON", "Il corpo deve essere un oggetto JSON.")
            return

        model = str(payload.pop("model", DEFAULT_MODEL)).strip()
        if not MODEL_RE.match(model):
            self.send_error_json(
                HTTPStatus.BAD_REQUEST,
                "BAD_MODEL",
                "Nome del modello non valido. Usa un identificativo gemini-*.",
            )
            return

        body = {key: value for key, value in payload.items() if key in ALLOWED_PAYLOAD_KEYS}
        if not isinstance(body.get("contents"), list) or not body["contents"]:
            self.send_error_json(
                HTTPStatus.BAD_REQUEST,
                "BAD_REQUEST",
                "Manca il campo 'contents' con i contenuti da inviare a Gemini.",
            )
            return

        payload_bytes = json.dumps(body).encode("utf-8")
        has_media = any(
            isinstance(part, dict) and "inlineData" in part
            for content in body.get("contents", [])
            if isinstance(content, dict)
            for part in (content.get("parts") or [])
            if isinstance(part, dict)
        )
        attempt_timeout = TRY_TIMEOUT_MEDIA_SECONDS if has_media else TRY_TIMEOUT_SECONDS
        deadline = time.monotonic() + (
            TRY_DEADLINE_MEDIA_SECONDS if has_media else TRY_DEADLINE_SECONDS
        )

        status = 0
        data = b""
        used_model = model
        retired = False
        network_error = ""
        finished = False

        sequence = model_chain(model)
        if DEFAULT_MODEL in sequence:
            sequence = sequence + [DEFAULT_MODEL]

        for candidate in sequence:
            if finished:
                break
            remaining = deadline - time.monotonic()
            if remaining < 5:
                finished = True
                break
            used_model = candidate
            started = time.monotonic()
            request = urllib.request.Request(
                GEMINI_ENDPOINT.format(model=urllib.parse.quote(candidate, safe="")),
                data=payload_bytes,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": API_KEY,
                    "Accept": "application/json",
                },
            )
            try:
                with urllib.request.urlopen(
                    request,
                    timeout=min(attempt_timeout, remaining),
                    context=ssl.create_default_context(),
                ) as response:
                    status = response.status
                    data = response.read()
                self.log_attempt(candidate, status, started)
                finished = True
            except urllib.error.HTTPError as error:
                status = error.code
                data = error.read()
                self.log_attempt(candidate, error.code, started)
                if error.code == 404 and candidate == model:
                    retired = True
                if error.code not in RETRYABLE_STATUS or error.code == 429:
                    finished = True
            except (TimeoutError, urllib.error.URLError) as error:
                reason = getattr(error, "reason", error)
                if isinstance(error, urllib.error.URLError) and not isinstance(reason, TimeoutError):
                    network_error = str(reason)
                    self.log_attempt(candidate, "rete", started)
                else:
                    status = HTTPStatus.GATEWAY_TIMEOUT
                    data = b""
                    self.log_attempt(candidate, "timeout", started)
                finished = True
            except Exception as error:  # pragma: no cover
                self.send_error_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "PROXY_ERROR",
                    f"Errore del proxy Vercel: {error}",
                )
                return

        if network_error:
            self.send_error_json(
                HTTPStatus.BAD_GATEWAY,
                "NETWORK",
                f"Impossibile raggiungere Gemini: {network_error}. Controlla la connessione.",
            )
            return

        if status == HTTPStatus.GATEWAY_TIMEOUT or not status:
            self.send_error_json(
                HTTPStatus.GATEWAY_TIMEOUT,
                "TIMEOUT",
                "Gemini non ha risposto in tempo. Riprova con una foto più piccola."
                if has_media
                else "Gemini non ha risposto in tempo. Riprova tra qualche secondo.",
            )
            return

        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Gemini-Model", used_model)
            if retired and used_model != model:
                self.send_header("X-Gemini-Retired", "1")
            self.end_headers()
            if data:
                self.wfile.write(data)
        except (ConnectionError, OSError):
            pass

    def send_error_json(self, status: int, code: str, message: str) -> None:
        self.send_json(status, {"error": {"code": code, "message": message}})

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionError, OSError):
            pass

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return

    @staticmethod
    def log_attempt(model: str, status, started: float) -> None:
        elapsed = time.monotonic() - started
        sys.stderr.write(
            "[%s] proxy %s: %s in %.1fs\n"
            % (time.strftime("%H:%M:%S"), model, status, elapsed)
        )
