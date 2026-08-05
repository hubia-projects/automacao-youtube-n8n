"""Metadados estruturados por shot — Gemini Flash vision (ARCHITECTURE.md §6).

Mock mode: heurística por nome de ficheiro (determinística, para testes).
Prompt versionado em prompts/vision/shot_metadata.v1.md.
"""

from __future__ import annotations

import base64
import json
import logging
from pathlib import Path

import httpx
from pydantic import BaseModel, Field

from studio.config import Settings
from studio.llm.gemini import log_call

log = logging.getLogger("studio.metadata")

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Preços Gemini 2.5 Flash (aprox., para o ledger)
_USD_IN, _USD_OUT = 0.15 / 1e6, 0.60 / 1e6


class ShotAnalysisError(RuntimeError):
    """Vision devolveu output inutilizável — o shot é saltado (não o ficheiro)."""


class ShotMetadata(BaseModel):
    summary: str = ""
    places: list[str] = Field(default_factory=list)
    landmarks: list[str] = Field(default_factory=list)
    food_items: list[str] = Field(default_factory=list)
    objects: list[str] = Field(default_factory=list)
    ocr_text: str = ""
    shot_type: str = "medium"
    camera_motion: str = "static"
    time_of_day: str = "day"
    indoor_outdoor: str = "outdoor"
    people_present: bool = False
    quality: int = 5
    defects: list[str] = Field(default_factory=list)

    @property
    def has_food(self) -> bool:
        return bool(self.food_items)

    @property
    def has_landmark(self) -> bool:
        return bool(self.landmarks)


def _prompt(settings: Settings) -> str:
    return (settings.prompts_root / "vision" / "shot_metadata.v1.md").read_text("utf-8")


def _mock_metadata(keyframes: list[Path], source_hint: str = "") -> ShotMetadata:
    """Determinística por nome de ficheiro — só para testes/mock."""
    hint = (source_hint + " " + (keyframes[0].as_posix() if keyframes else "")).lower()
    meta = ShotMetadata(summary=f"mock shot from {hint}", quality=7)
    if "food" in hint or "pastel" in hint or "bacalhau" in hint:
        meta.food_items = ["mock dish"]
        meta.objects = ["plate", "table"]
        meta.shot_type = "close-up"
        meta.indoor_outdoor = "indoor"
    if "monument" in hint or "tower" in hint or "church" in hint:
        meta.landmarks = ["Mock Monument"]
        meta.shot_type = "wide"
    return meta


def analyze_shot(keyframes: list[Path], settings: Settings,
                 source_hint: str = "") -> tuple[ShotMetadata, float]:
    """Devolve (metadados, custo_usd). source_hint = nome do media original
    (usado apenas pelo mock determinístico)."""
    if settings.mock_mode or not settings.gemini_api_key:
        return _mock_metadata(keyframes, source_hint), 0.0

    parts: list[dict] = [{"text": _prompt(settings)}]
    for kf in keyframes:
        parts.append({
            "inline_data": {
                "mime_type": "image/jpeg",
                "data": base64.b64encode(kf.read_bytes()).decode(),
            }
        })

    total_cost = 0.0
    last_err: Exception | None = None
    for temperature in (0.1, 0.0):  # retry único a temp 0 se o JSON vier partido
        resp = httpx.post(
            GEMINI_URL.format(model=settings.model_flash),
            params={"key": settings.gemini_api_key},
            json={
                "contents": [{"parts": parts}],
                "generationConfig": {
                    "response_mime_type": "application/json",
                    "temperature": temperature,
                },
            },
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        usage = data.get("usageMetadata", {})
        prompt_tokens = usage.get("promptTokenCount", 0)
        output_tokens = usage.get("candidatesTokenCount", 0)
        step_cost = prompt_tokens * _USD_IN + output_tokens * _USD_OUT
        total_cost += step_cost
        log_call(settings, tag="library_vision", model=settings.model_flash,
                prompt_tokens=prompt_tokens, output_tokens=output_tokens,
                cost_usd=step_cost)
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        try:
            return ShotMetadata.model_validate(json.loads(text)), total_cost
        except (json.JSONDecodeError, ValueError) as exc:
            last_err = exc
            log.warning("metadados JSON inválido (temp=%s): %s", temperature, exc)
    raise ShotAnalysisError(f"JSON inválido após retry: {last_err}")
