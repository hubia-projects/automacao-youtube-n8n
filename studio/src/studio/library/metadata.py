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


# ============== Fase 2C — Batched metadata analysis ==============
# CRITICAL UPSTREAM-CHANGE 2026-08-11:
#   antes: per-shot analyze_shot() → 1 Gemini call por shot (8 min/call
#     em benchmark 2026-08-09 / conta Gemini throttled).
#   depois: analyze_shots_batch(shots[]) → 1 Gemini call com N shots
#     etiquetados [shot_id=...], resposta parseada em dict[shot_id, metadata].
#
# FALLBACKS garantidos:
#   - mock_mode → per-shot analyze_shot() (compat)
#   - Gemini HTTP/JSON fail → per-shot analyze_shot() (graceful degrade)
#   - parcial: shot não devolvido na resposta → None (METADATA_INCOMPLETE),
#     NUNCA copiar metadata de outro shot (prompt explicit + parser enforce).
#
# COSTO: 1 chamada Gemini custa o mesmo em tokens para N shots (ligeira
#   subida de output_tokens por N entradas) — verificar com benchmark TEST 20
#   antes de abandonar o batching.
def analyze_shots_batch(
    shots: list[tuple[str, list[Path]]],
    settings: Settings,
    *,
    source_hint: str = "",
) -> dict[str, tuple[ShotMetadata | None, float]]:
    """Batched metadata analysis — 1 Gemini call com N shots etiquetados.

    Args:
        shots: lista de (shot_id, keyframes). shot_id etiqueta cada item na resposta.
        settings: Settings (mock_mode, gemini_api_key).
        source_hint: nome do media — só usado em mock determinístico.

    Returns:
        dict[shot_id -> (ShotMetadata|None, cost_usd)].

        None no valor significa METADATA_INCOMPLETE para esse shot
        (Gemini não respondeu — NÃO copiamos metadata de outro shot).
    """
    out: dict[str, tuple[ShotMetadata | None, float]] = {}
    if not shots:
        return out

    # mock_mode → compat: per-shot mock (já é determinístico)
    if settings.mock_mode or not settings.gemini_api_key:
        return _per_shot_fallback(shots, settings, source_hint)

    prompt_text = (
        _prompt(settings)
        + "\n\nFor EACH [shot_id=...] block below, output ONE JSON object\n"
        + "(all inside a single JSON array). Required keys per object:\n"
        + "  shot_id: string,\n"
        + "  summary, places[], landmarks[], food_items[], objects[],\n"
        + "  ocr_text, shot_type, camera_motion, time_of_day,\n"
        + "  indoor_outdoor, people_present (bool), quality (int 1-10),\n"
        + "  defects[].\n\n"
        + "CRITICAL: do NOT copy metadata from one shot to another. If a shot\n"
        + "is unreadable or you cannot analyse it, return only that entry\n"
        + 'with summary = "METADATA_INCOMPLETE".\n\n'
        + "Image order matches [shot_id=...]:\n"
    )
    parts: list[dict] = [{"text": prompt_text}]
    for sid, kfs in shots:
        parts.append({"text": f"\n[shot_id={sid}]"})
        for kf in kfs:
            parts.append({
                "inline_data": {
                    "mime_type": "image/jpeg",
                    "data": base64.b64encode(kf.read_bytes()).decode(),
                }
            })

    try:
        resp = httpx.post(
            GEMINI_URL.format(model=settings.model_flash),
            params={"key": settings.gemini_api_key},
            json={
                "contents": [{"parts": parts}],
                "generationConfig": {
                    "response_mime_type": "application/json",
                    "temperature": 0.1,
                },
            },
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        usage = data.get("usageMetadata", {})
        prompt_tokens = int(usage.get("promptTokenCount", 0))
        output_tokens = int(usage.get("candidatesTokenCount", 0))
        total_cost = prompt_tokens * _USD_IN + output_tokens * _USD_OUT
        log_call(settings, tag="library_vision_batch", model=settings.model_flash,
                 prompt_tokens=prompt_tokens, output_tokens=output_tokens,
                 cost_usd=total_cost,
                 shots_in_batch=len(shots))
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        try:
            items = json.loads(text)
        except (json.JSONDecodeError, ValueError) as exc:
            log.warning(
                "analyze_shots_batch (%d shots): JSON parse falhou (%s) — "
                "fallback per-shot", len(shots), exc.__class__.__name__)
            return _per_shot_fallback(
                shots, settings, source_hint, original_exc=exc)
        if isinstance(items, dict):
            items = [items]   # tolerate single-entry shape
        if not isinstance(items, list):
            log.warning(
                "analyze_shots_batch: tipo inesperado %s — fallback per-shot",
                type(items).__name__)
            return _per_shot_fallback(
                shots, settings, source_hint, original_exc="type_unexpected")
        shot_ids = [sid for sid, _ in shots]
        matched = 0
        for entry in items:
            if not isinstance(entry, dict):
                continue
            sid = str(entry.get("shot_id") or entry.get("id") or "")
            if not sid or sid not in shot_ids:
                continue
            try:
                # UPSTREAM-FIX (code-reviewer #3): Pydantic-defaults silent
                # trap — model_validate aceita entry com summary vazio e
                # listas vazias porque tudo tem default. Marcamos
                # METADATA_INCOMPLETE quando summary vazio OU sem
                # qualquer evidence entre places/landmarks/food/objects.
                summary_v = (entry.get("summary") or "").strip()
                evidence_v = any([
                    entry.get("places") or [],
                    entry.get("landmarks") or [],
                    entry.get("food_items") or [],
                    entry.get("objects") or [],
                ])
                if summary_v == "METADATA_INCOMPLETE" or not summary_v:
                    out[sid] = (None, 0.0)
                    continue
                meta = ShotMetadata.model_validate(entry)
                # ainda faltando conteúdo real: trata como incomplete
                if not evidence_v:
                    out[sid] = (None, 0.0)
                    continue
                # cost proporcional ao nº de shots matched (best-effort)
                out[sid] = (meta, round(total_cost / max(len(shot_ids), 1), 6))
                matched += 1
            except Exception as exc:
                log.debug("analyze_shots_batch: validate '%s' falhou (%s) — "
                          "METADATA_INCOMPLETE para esse shot",
                          sid, exc.__class__.__name__)
                out[sid] = (None, 0.0)
        # shots não devolvidos na resposta → METADATA_INCOMPLETE explícito
        # NÃO copiar metadata de outro shot (regra de segurança).
        for sid in shot_ids:
            if sid not in out:
                out[sid] = (None, 0.0)
        return out
    except (httpx.HTTPError, KeyError, IndexError) as exc:
        log.warning(
            "analyze_shots_batch (%d shots): Gemini HTTP/JSON falhou (%s) — "
            "fallback per-shot", len(shots), exc.__class__.__name__)
        return _per_shot_fallback(shots, settings, source_hint, original_exc=exc)


def _per_shot_fallback(
    shots: list[tuple[str, list[Path]]],
    settings: Settings,
    source_hint: str,
    *,
    original_exc=None,
) -> dict[str, tuple[ShotMetadata | None, float]]:
    """Fallback gracioso: per-shot analyze_shot(), partilhado entre mock_mode
    e falhas do batch. Logs do motivo original se presente."""
    out: dict[str, tuple[ShotMetadata | None, float]] = {}
    if original_exc is not None:
        log.info("_per_shot_fallback activado (motivo: %s / %s) — %d shots",
                 original_exc.__class__.__name__ if hasattr(original_exc, "__class__") else type(original_exc).__name__,
                 str(original_exc)[:120], len(shots))
    for sid, kfs in shots:
        try:
            sm, cost = analyze_shot(kfs, settings, source_hint=source_hint)
            out[sid] = (sm, cost)
        except Exception as exc:
            log.debug("_per_shot_fallback: '%s' falhou (%s) — METADATA_INCOMPLETE",
                      sid, exc.__class__.__name__)
            out[sid] = (None, 0.0)
    return out


# ============== Fase E — Metadata Confidence ==============
class DetectedEntity(BaseModel):
    """Resultado estruturado de Vision Gemini Flash sobre keyframes.

    confidence: 0..1 (≥ settings.entity_confirm_min_confidence → confirmado).
    evidence: lista de strings ("OCR: 'Lello'", "visual: iconic staircase",
               "metadata: Exif date 2025"). Mínimo 3 evidências para high conf.
    rejected: True ⇒ confirm_shot_entity() rejeitou (motivo em rejection_reason).
    """
    name: str = ""
    entity_type: str = ""
    confidence: float = 0.0
    evidence: list[str] = Field(default_factory=list)
    rejected: bool = False
    rejection_reason: str = ""
    confirmed_by: str = ""  # "gemini-flash" / "metadata-only" / "cache"
    at: str = ""  # ISO timestamp

    def is_confirmed(self, threshold: float) -> bool:
        return (not self.rejected
                and self.confidence >= threshold
                and bool(self.name))
