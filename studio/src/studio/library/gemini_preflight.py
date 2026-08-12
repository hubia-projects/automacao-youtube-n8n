"""gemini_preflight.py — item N (closure pass): validar a credencial Gemini
ANTES de qualquer confirmação Vision/aquisição longa.

Doutrina explícita: "DO NOT spend the session trying the same invalid key
repeatedly" — 1 única chamada barata (GET /v1beta/models, sem generation
billed) em vez de descobrir a credencial inválida a meio de N batches de
confirmação (cada um já fail-fast via metadata.py, mas só depois de MUITAS
cenas já processadas).
"""
from __future__ import annotations

import logging

from studio.config import Settings

log = logging.getLogger("studio.gemini_preflight")

GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"

CREDENTIALS_INVALID = "GEMINI_CREDENTIALS_INVALID"
CREDENTIALS_MISSING = "GEMINI_CREDENTIALS_MISSING"


def preflight_gemini_credentials(settings: Settings) -> tuple[bool, str]:
    """Devolve (ok, reason). reason == "" quando ok.

    mock_mode ou sem `gemini_api_key` configurada → (True, "") — nada a
    validar (fail-open: não bloqueia runs mock/dev sem credencial real).
    Falha de REDE (não de credencial) também é fail-soft — infra
    instável não deve impedir o run só por causa deste preflight barato.
    """
    if getattr(settings, "mock_mode", False):
        return True, ""
    key = getattr(settings, "gemini_api_key", "") or ""
    if not key:
        return False, f"{CREDENTIALS_MISSING}: settings.gemini_api_key vazio"

    import httpx

    try:
        resp = httpx.get(GEMINI_MODELS_URL, params={"key": key}, timeout=10)
    except Exception as exc:
        log.warning("preflight_gemini_credentials: rede falhou (%s) — "
                    "não bloqueante, assume-se válida", exc.__class__.__name__)
        return True, ""
    if resp.status_code in (401, 403):
        return False, f"{CREDENTIALS_INVALID}: HTTP {resp.status_code}"
    return True, ""
