"""Cliente Gemini (REST via httpx). Custo devolvido para o ledger."""

from __future__ import annotations

import json
import logging
import random
import time

import httpx

from studio.config import Settings

URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

log = logging.getLogger("studio.llm.gemini")

# USD por token (aprox., tier de contexto normal — acima de _LARGE_CONTEXT_TOKENS
# a Gemini pode cobrar um tier mais caro; log_call marca essas chamadas para
# conferência manual em vez de arriscar um número errado)
_PRICES = {"pro": (1.25 / 1e6, 10.0 / 1e6), "flash": (0.15 / 1e6, 0.60 / 1e6)}
_LARGE_CONTEXT_TOKENS = 200_000


def _price(model: str) -> tuple[float, float]:
    return _PRICES["pro"] if "pro" in model else _PRICES["flash"]


# Timeouts estruturados: connect curto (15s mata hangs em DNS/TLS), read largo
# (180s cobre Gemini com vídeo no generateContent), write/pool separados para
# evitar que um upload multipart lento bloqueie leituras subsequentes.
_TIMEOUT_STRUCT = httpx.Timeout(connect=15.0, read=180.0, write=30.0, pool=30.0)
_RETRYABLE_HTTP = frozenset({429, 500, 502, 503, 504})


def _retry_delay(attempt: int, base: float = 2.0, cap: float = 30.0) -> float:
    """Backoff exponencial com jitter; cap em 30s (anti thundering-herd)."""
    return min(cap, base * (2 ** (attempt - 1)) + random.uniform(0, 1))


def _parse_retry_after(value):
    """Retry-After RFC 7231: Google envia quase sempre delta-seconds (digitos).
    Se vier HTTP-date, devolvemos None e cai no backoff exponencial."""
    if value and str(value).isdigit():
        return float(value)
    return None


def _http_with_retry(url: str, *, max_attempts: int = 3, **kwargs) -> httpx.Response:
    """POST c/ retry em 429/5xx e erros transientes de rede (connect/read/write/
    pool timeout, RemoteProtocolError). Respeita Retry-After quando vier em
    segundos. NÃO retenta em 4xx != 429 (bug do payload, propaga)."""
    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = httpx.post(url, **kwargs)
            if resp.status_code in _RETRYABLE_HTTP:
                if attempt == max_attempts:
                    resp.raise_for_status()
                retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
                delay = retry_after if retry_after is not None else _retry_delay(attempt)
                log.warning(
                    "gemini: HTTP %d em %s (tentativa %d/%d), a aguardar %.1fs",
                    resp.status_code, url, attempt, max_attempts, delay,
                )
                time.sleep(delay)
                continue
            resp.raise_for_status()
            return resp
        except (httpx.ConnectError, httpx.TimeoutException,
                httpx.RemoteProtocolError) as exc:
            last_exc = exc
            if attempt == max_attempts:
                raise
            delay = _retry_delay(attempt)
            log.warning(
                "gemini: %s em %s (tentativa %d/%d), a aguardar %.1fs",
                type(exc).__name__, url, attempt, max_attempts, delay,
            )
            time.sleep(delay)
    raise last_exc if last_exc else RuntimeError("retry exausto sem exceção")




def log_call(settings: Settings, *, tag: str, model: str, prompt_tokens: int,
            output_tokens: int, cost_usd: float) -> None:
    """Regista CADA chamada Gemini real (não mock) em data/gemini_calls.jsonl —
    auditoria de custo por solicitação, com contagem real de tokens da API."""
    line = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tag": tag or "untagged",
        "model": model,
        "prompt_tokens": prompt_tokens,
        "output_tokens": output_tokens,
        "cost_usd_estimate": round(cost_usd, 6),
    }
    if prompt_tokens > _LARGE_CONTEXT_TOKENS:
        line["note"] = ("contexto >200k tokens — Gemini pode cobrar tier mais caro; "
                        "confirmar valor real em ai.studio/spend")
    settings.data_root.mkdir(parents=True, exist_ok=True)
    with (settings.data_root / "gemini_calls.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(line, ensure_ascii=False) + "\n")


def generate(prompt: str, settings: Settings, *, model: str | None = None,
             json_mode: bool = False, search_grounding: bool = False,
             temperature: float = 0.7, timeout: httpx.Timeout = _TIMEOUT_STRUCT,
             tag: str = "") -> tuple[str, float]:
    model = model or settings.model_flash
    body: dict = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature},
    }
    if json_mode:
        body["generationConfig"]["response_mime_type"] = "application/json"
    if search_grounding:
        body["tools"] = [{"google_search": {}}]

    resp = _http_with_retry(URL.format(model=model),
                            params={"key": settings.gemini_api_key},
                            json=body, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()

    parts = data["candidates"][0]["content"]["parts"]
    text = "".join(p.get("text", "") for p in parts)
    usage = data.get("usageMetadata", {})
    p_in, p_out = _price(model)
    prompt_tokens = usage.get("promptTokenCount", 0)
    output_tokens = usage.get("candidatesTokenCount", 0)
    cost = prompt_tokens * p_in + output_tokens * p_out
    log_call(settings, tag=tag, model=model, prompt_tokens=prompt_tokens,
            output_tokens=output_tokens, cost_usd=cost)
    return text, cost
