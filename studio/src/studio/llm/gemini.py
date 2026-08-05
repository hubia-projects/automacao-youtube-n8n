"""Cliente Gemini (REST via httpx). Custo devolvido para o ledger."""

from __future__ import annotations

import json
import time

import httpx

from studio.config import Settings

URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

# USD por token (aprox., tier de contexto normal — acima de _LARGE_CONTEXT_TOKENS
# a Gemini pode cobrar um tier mais caro; log_call marca essas chamadas para
# conferência manual em vez de arriscar um número errado)
_PRICES = {"pro": (1.25 / 1e6, 10.0 / 1e6), "flash": (0.15 / 1e6, 0.60 / 1e6)}
_LARGE_CONTEXT_TOKENS = 200_000


def _price(model: str) -> tuple[float, float]:
    return _PRICES["pro"] if "pro" in model else _PRICES["flash"]


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
             temperature: float = 0.7, timeout: float = 180.0,
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

    resp = httpx.post(URL.format(model=model), params={"key": settings.gemini_api_key},
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
