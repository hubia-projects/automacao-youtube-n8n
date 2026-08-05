"""Cliente OpenAI (REST via httpx) — usado no passe humanize (ADR: família
de modelo diferente quebra monocultura estilística)."""

from __future__ import annotations

import httpx

from studio.config import Settings

URL = "https://api.openai.com/v1/chat/completions"
_PRICES = {"gpt-4o": (2.50 / 1e6, 10.0 / 1e6), "gpt-4o-mini": (0.15 / 1e6, 0.60 / 1e6)}


def chat(prompt: str, settings: Settings, *, model: str = "gpt-4o",
         temperature: float = 0.8, timeout: float = 180.0) -> tuple[str, float]:
    resp = httpx.post(
        URL,
        headers={"Authorization": f"Bearer {settings.openai_api_key}"},
        json={"model": model, "temperature": temperature,
              "messages": [{"role": "user", "content": prompt}]},
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    text = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    p_in, p_out = _PRICES.get(model, _PRICES["gpt-4o"])
    cost = usage.get("prompt_tokens", 0) * p_in + usage.get("completion_tokens", 0) * p_out
    return text, cost
