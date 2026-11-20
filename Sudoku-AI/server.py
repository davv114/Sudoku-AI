#!/usr/bin/env python3
"""
Sudoku Vision · server locale di sviluppo
=========================================

Serve l'applicazione statica e fa da proxy verso la Gemini API, così la
chiave resta nel file .env e non viene mai esposta al browser.

Uso:
    py -3 server.py
    py -3 server.py --port 9000 --no-browser
    py -3 server.py --host 0.0.0.0        # accesso da smartphone sulla LAN

Non richiede dipendenze esterne: usa solo la libreria standard di Python 3.9+.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
MODEL_RE = re.compile(r"^gemini-[A-Za-z0-9._-]{1,80}$")
MAX_BODY_BYTES = 16 * 1024 * 1024
ALLOWED_PAYLOAD_KEYS = {"contents", "generationConfig", "safetySettings", "systemInstruction"}


def load_dotenv(path: Path) -> None:
    """Lettore .env minimale, senza sovrascrivere variabili già presenti."""
    if not path.is_file():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        print(f"Avviso: impossibile leggere {path.name}: {error}")
        return

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        value = value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv(ROOT / ".env")

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite").strip() or "gemini-3.5-flash-lite"
DEFAULT_PORT = int(os.environ.get("PORT", "8765"))

# Google ritira periodicamente i modelli: se il modello richiesto risponde
# 404 (ritirato) o 503 (sovraccarico) il proxy prova automaticamente i
# successivi, così l'app continua a funzionare senza modifiche manuali.
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
TRY_DEADLINE_SECONDS = 50
TRY_DEADLINE_MEDIA_SECONDS = 65
TRY_TIMEOUT_SECONDS = 25
TRY_TIMEOUT_MEDIA_SECONDS = 40


class SudokuVisionHandler(SimpleHTTPRequestHandler):
    server_version = "SudokuVision/1.0"

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
        ".md": "text/markdown; charset=utf-8",
        ".woff2": "font/woff2",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ------------------------------------------------------------------
    # Utility
    # ------------------------------------------------------------------
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
            # Il browser ha annullato la richiesta (timeout client): nessun log sporco.
            pass

    def send_error_json(self, status: int, code: str, message: str) -> None:
        self.send_json(status, {"error": {"code": code, "message": message}})

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def is_forbidden_path(self, path: str) -> bool:
        clean = path.split("?", 1)[0]
        lowered = clean.lower()
        if "/.git" in lowered or lowered.endswith("/.env"):
            return True
        return any(segment.startswith(".") for segment in lowered.split("/") if segment)

    @staticmethod
    def model_chain(requested: str) -> list[str]:
        """Modello richiesto, poi default e fallback configurati (senza duplicati)."""
        chain: list[str] = []
        for name in [requested, DEFAULT_MODEL, *FALLBACK_MODELS]:
            if name and name not in chain and MODEL_RE.match(name):
                chain.append(name)
        return chain

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 (API http.server)
        if self.path.split("?", 1)[0] == "/api/health":
            self.send_json(
                HTTPStatus.OK,
                {
                    "proxy": True,
                    "configured": bool(API_KEY),
                    "model": DEFAULT_MODEL,
                    "fallbackModels": FALLBACK_MODELS,
                },
            )
            return

        if self.is_forbidden_path(self.path):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        if self.is_forbidden_path(self.path):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_HEAD()

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/api/gemini":
            self.send_error_json(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Endpoint non trovato.")
            return

        if not API_KEY:
            self.send_error_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "NO_KEY",
                "GEMINI_API_KEY non configurata. Copia .env.example in .env e inserisci la chiave, poi riavvia server.py.",
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
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
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

        # Prova il modello richiesto e, se ritirato/sovraccarico, i fallback.
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

        # Un tentativo per modello: se un modello è sovraccarico conviene
        # provarne subito un altro (ritentare lo stesso costa decine di secondi).
        # Alla fine della catena si ritenta una volta il modello predefinito.
        sequence = self.model_chain(model)
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
            attempt_started = time.monotonic()
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
                self.log_attempt(candidate, status, attempt_started)
                finished = True
            except urllib.error.HTTPError as error:
                status = error.code
                data = error.read()
                self.log_attempt(candidate, error.code, attempt_started)
                if error.code == 404 and candidate == model:
                    # Il modello scelto nelle impostazioni non esiste più:
                    # il ripiego su un altro modello è definitivo.
                    retired = True
                if error.code not in RETRYABLE_STATUS or error.code == 429:
                    # Errore definitivo (chiave, quota, richiesta non valida).
                    finished = True
            except (TimeoutError, urllib.error.URLError) as error:
                reason = getattr(error, "reason", error)
                if isinstance(error, urllib.error.URLError) and not isinstance(reason, TimeoutError):
                    network_error = str(reason)
                    self.log_attempt(candidate, "rete", attempt_started)
                else:
                    status = HTTPStatus.GATEWAY_TIMEOUT
                    data = b""
                    self.log_attempt(candidate, "timeout", attempt_started)
                finished = True
            except Exception as error:  # pragma: no cover - difesa finale
                self.send_error_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "PROXY_ERROR",
                    f"Errore del proxy locale: {error}",
                )
                return

        if network_error:
            self.send_error_json(
                HTTPStatus.BAD_GATEWAY,
                "NETWORK",
                f"Impossibile raggiungere Gemini: {network_error}. Controlla la connessione.",
            )
            return

        if status == HTTPStatus.GATEWAY_TIMEOUT:
            self.send_error_json(
                HTTPStatus.GATEWAY_TIMEOUT,
                "TIMEOUT",
                "Gemini non ha risposto in tempo. Riprova con una foto più piccola."
                if has_media
                else "Gemini non ha risposto in tempo. Riprova tra qualche secondo.",
            )
            return

        if not status:
            self.send_error_json(
                HTTPStatus.GATEWAY_TIMEOUT,
                "TIMEOUT",
                "Gemini non ha risposto in tempo. Riprova tra qualche secondo.",
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

    # Log essenziale, senza query string né dati sensibili.
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def log_attempt(self, model: str, status, started: float) -> None:
        elapsed = time.monotonic() - started
        sys.stderr.write(
            "[%s] proxy %s: %s in %.1fs\n"
            % (time.strftime("%H:%M:%S"), model, status, elapsed)
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Server locale per AI Sudoku Vision & Tutor")
    parser.add_argument("--host", default="127.0.0.1", help="Indirizzo di ascolto (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Porta (default: {DEFAULT_PORT})")
    parser.add_argument("--no-browser", action="store_true", help="Non aprire automaticamente il browser")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}/"
    server = ThreadingHTTPServer((args.host, args.port), SudokuVisionHandler)
    server.daemon_threads = True

    print("")
    print("  Sudoku Vision · AI Sudoku Vision & Tutor")
    print("  ----------------------------------------")
    print(f"  App:      {url}")
    print(f"  Modello:  {DEFAULT_MODEL}")
    print(f"  Fallback: {', '.join(model for model in FALLBACK_MODELS if model != DEFAULT_MODEL) or 'nessuno'}")
    print(f"  API key:  {'configurata (proxy attivo)' if API_KEY else 'NON configurata'}")
    if not API_KEY:
        print("")
        print("  Per abilitare OCR e tutor Gemini:")
        print("    1. copia .env.example in .env")
        print("    2. inserisci GEMINI_API_KEY=...")
        print("    3. riavvia questo server")
        print("")
        print("  Puoi comunque provare gli esempi e la griglia manuale.")
    print("")
    print("  Premi Ctrl+C per fermare il server.")
    print("")

    if not args.no_browser:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer fermato.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
