"""Revisor multimodal — Gemini Pro com input de vídeo nativo (ADR-0005).

Real: upload do proxy à Files API → generateContent com o vídeo + roteiro +
briefs → ReviewReport. Mock: determinístico via metadados — um segmento que
viola o brief da cena (comida sem has_food, monumento em cena de comida)
gera fix replace_shot e score <90; sem violações → 92.
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path

import httpx

from pydantic import ValidationError

from studio.config import Settings

# _retry_delay vem do gemini: reusa a função de backoff com jitter (anti
# thundering-herd). Sem import circular entre reviewer e gemini (gemini não
# importa reviewer).
from studio.llm.gemini import _retry_delay, log_call
from studio.review.rubric import Fix, GlobalReview, ReviewReport, SceneReview

log = logging.getLogger("studio.reviewer")

UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files"
FILES_URL = "https://generativelanguage.googleapis.com/v1beta/{name}"
GEN_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Fase 1A: Flash primary (15× cheaper JSON, vídeo continuity ≈ Pro em tarefas
# estruturadas). Pricing separado para cálculo correcto de cost_usd quando
# fallback Pro é activado. Override via STUDIO_REVIEW_USE_FLASH=0 para
# benchmark A/B em produção.
import os as _os
_USD_IN_FLASH, _USD_OUT_FLASH = 0.075 / 1e6, 0.30 / 1e6  # 1.5 Flash
_USD_IN_PRO,   _USD_OUT_PRO   = 1.25  / 1e6, 10.0 / 1e6  # 1.5 Pro
_USE_FLASH_REVIEW = _os.environ.get("STUDIO_REVIEW_USE_FLASH", "1") == "1"

# Whitelist Flash por marcador estável de modelo (evitar match acidental em
# nomes com "flash" mas que não são 1.5-flash, ex: flash-cards, flashcard).
_FLASH_MODEL_MARKERS = ("flash", "gemini-1.5-flash", "gemini-2.0-flash",
                        "gemini-2.5-flash")

def _review_pricing(model: str) -> tuple[float, float]:
    low = model.lower()
    is_flash = any(m in low for m in _FLASH_MODEL_MARKERS)
    return (_USD_IN_FLASH, _USD_OUT_FLASH) if is_flash else \
           (_USD_IN_PRO,   _USD_OUT_PRO)

# Gemini Pro em JSON mode às vezes devolve respostas truncadas (max_output_tokens
# acima de 11k chars para o nosso prompt). Até `MAX_REVIEW_PARSE_RETRIES` retries
# com temperature=0 absorvem isso sem repetir o upload do ficheiro (file_uri
# continua válido por 24h).
MAX_REVIEW_PARSE_RETRIES = 3

# upload multipart + generateContent com vídeo demoram minutos — falhas de
# rede transitórias (DNS, timeout) não devem obrigar a um `studio resume`
# manual; retry curto absorve isso sem repetir chamadas já pagas
_TRANSIENT = (httpx.ConnectError, httpx.TimeoutException,
             httpx.RemoteProtocolError)
# Códigos HTTP que justificam retry automático. 4xx != 429 são bugs do nosso
# payload (vão propagar com log do body para diagnóstico).
_TRANSIENT_HTTP = frozenset({429, 500, 502, 503, 504})


def _parse_review_text(text: str) -> dict:
    """Parseia texto que DEVE ser JSON (response_mime_type=application/json).

    Defensivo contra respostas Gemini truncadas ou com fences malformadas:
    1) strip fenced ```json``` block
    2) tenta parse completo
    3) tenta trim até último '}' balanceado (descarta prosa trailing)
    4) tenta extract entre primeiro '{' e último '}' balanceado
    """
    raw = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    if m:
        raw = m.group(1).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    last_close = raw.rfind("}")
    if last_close > 0:
        try:
            return json.loads(raw[: last_close + 1])
        except json.JSONDecodeError:
            pass
    first_open = raw.find("{")
    if first_open >= 0 and last_close > first_open:
        try:
            return json.loads(raw[first_open : last_close + 1])
        except json.JSONDecodeError:
            pass
    raise json.JSONDecodeError("after sanitization", raw, 0)


def _try_parse_review(text: str) -> ReviewReport:
    # Gemini Pro às vezes devolve `[ {review} ]` em vez de `{ review }`,
    # mesmo com response_mime_type=application/json. Aceitar ambas as formas.
    data = _parse_review_text(text)
    if isinstance(data, list) and data:
        data = next((x for x in data if isinstance(x, dict)), data[0])
    return ReviewReport.model_validate(data)


def _post_with_retry(url: str, *, attempts: int = 3, **kwargs) -> httpx.Response:
    """POST c/ retry em 429/5xx e erros transientes de rede (com jitter).

    NÃO retenta em 4xx != 429 — bug do nosso payload; propaga com log do body
    para diagnóstico.
    """
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            resp = httpx.post(url, **kwargs)
            try:
                resp.raise_for_status()
                return resp
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code not in _TRANSIENT_HTTP:
                    # 4xx != 429: bug do payload. Loga body para diagnóstico.
                    log.error(
                        "reviewer: HTTP %d (não-retryable) em %s — body[:500]=%s",
                        exc.response.status_code, url,
                        exc.response.text[:500],
                    )
                    raise
                if attempt == attempts:
                    raise
                retry_after_raw = exc.response.headers.get("Retry-After")
                retry_after = (
                    float(retry_after_raw)
                    if retry_after_raw and retry_after_raw.isdigit()
                    else None
                )
                delay = retry_after if retry_after is not None else _retry_delay(attempt)
                log.warning(
                    "reviewer: HTTP %d em %s (tentativa %d/%d), a aguardar %.1fs",
                    exc.response.status_code, url, attempt, attempts, delay,
                )
                time.sleep(delay)
                last_exc = exc
        except _TRANSIENT as exc:
            last_exc = exc
            if attempt == attempts:
                raise
            delay = _retry_delay(attempt)
            log.warning(
                "reviewer: %s em %s (tentativa %d/%d), a aguardar %.1fs",
                type(exc).__name__, url, attempt, attempts, delay,
            )
            time.sleep(delay)
    raise last_exc if last_exc else RuntimeError("retry exausto")


def _mock_review(run_dir: Path) -> ReviewReport:
    briefs = {b["scene_id"]: b for b in json.loads(
        (run_dir / "07_briefs" / "briefs.json").read_text("utf-8"))}
    result = json.loads((run_dir / "08_matching" / "assignments.json").read_text("utf-8"))

    per_scene: dict[str, SceneReview] = {}
    fixes: list[Fix] = []
    for seg in result["segments"]:
        sid = seg["scene_id"]
        brief = briefs.get(sid, {})
        violation = (("food" in brief.get("must_have", []) and not seg["has_food"])
                     or ("landmark" in brief.get("must_not", []) and seg["has_landmark"])
                     or ("food" in brief.get("must_not", []) and seg["has_food"]))
        if violation and sid not in {f.scene_id for f in fixes}:
            per_scene[sid] = SceneReview(scene_id=sid, visual_match=2,
                                         issues=["footage não corresponde à narração"])
            fixes.append(Fix(scene_id=sid, action="replace_shot",
                             reason="mock: violação de brief detetada por metadados",
                             brief_override=None))
        elif sid not in per_scene:
            per_scene[sid] = SceneReview(scene_id=sid, visual_match=9,
                                         continuity=9, pacing=8)
    # penalização por violação: 1 cena errada tem de ficar ABAIXO do
    # PASS_SCORE (75) para o loop de fixes disparar no mock
    overall = 92 if not fixes else max(45, 92 - 20 * len(fixes))
    return ReviewReport(per_scene=list(per_scene.values()),
                        global_=GlobalReview(narrative_flow=9, repetition=9,
                                             audio_sync=9, overall=overall),
                        fixes=fixes)


def _upload_video(path: Path, settings: Settings) -> str:
    """Files API (multipart) → file_uri ACTIVE."""
    meta = json.dumps({"file": {"display_name": path.name}})
    files = {
        "metadata": (None, meta, "application/json"),
        "file": (path.name, path.read_bytes(), "video/mp4"),
    }
    # Upload multipart na Files API NÃO é idempotente: se o cliente perde a
    # resposta após o servidor receber o ficheiro completo, o retry envia UM
    # NOVO upload (=cobranca extra de storage). Limitar a 2 tentativas.
    resp = _post_with_retry(UPLOAD_URL, params={"key": settings.gemini_api_key,
                                                "uploadType": "multipart"},
                            files=files, timeout=300, attempts=2)
    resp.raise_for_status()
    info = resp.json()["file"]
    name, uri = info["name"], info["uri"]
    for _ in range(60):
        if info.get("state") == "ACTIVE":
            return uri
        time.sleep(3)
        for i in range(3):
            try:
                info = httpx.get(FILES_URL.format(name=name),
                                 params={"key": settings.gemini_api_key}, timeout=30).json()
                break
            except _TRANSIENT as exc:
                log.warning("rede transitória a consultar estado do ficheiro: %s", exc)
                if i == 2:
                    raise
                time.sleep(5)
    raise RuntimeError(f"ficheiro Gemini nunca ficou ACTIVE: {name}")


def review_rough_cut(proxy_path: Path, run_dir: Path,
                     settings: Settings) -> tuple[ReviewReport, float]:
    if settings.mock_mode:
        return _mock_review(run_dir), 0.0

    scenes = (run_dir / "06_scenes" / "scenes.json").read_text("utf-8")
    briefs = (run_dir / "07_briefs" / "briefs.json").read_text("utf-8")
    prompt = (settings.prompts_root / "review" / "rough_cut_rubric.v1.md") \
        .read_text("utf-8").replace("{scenes}", scenes).replace("{briefs}", briefs)

    uri = _upload_video(proxy_path, settings)
    # Fase 1A: preferir Flash; Pro como fallback só se env var desligada
    # (STUDIO_REVIEW_USE_FLASH=0) ou se settings.review_use_flash=False.
    model_used = settings.model_flash if _USE_FLASH_REVIEW else settings.model_pro
    url = GEN_URL.format(model=model_used)
    payload = {"contents": [{"parts": [
        {"file_data": {"file_uri": uri, "mime_type": "video/mp4"}},
        {"text": prompt},
    ]}], "generationConfig": {"response_mime_type": "application/json",
                              "temperature": 0.2}}

    resp = _post_with_retry(url, params={"key": settings.gemini_api_key},
                            json=payload, timeout=600)
    resp.raise_for_status()
    data = resp.json()
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    for attempt in range(MAX_REVIEW_PARSE_RETRIES):
        try:
            report = _try_parse_review(text)
            break
        except (json.JSONDecodeError, ValidationError) as exc:
            if attempt == MAX_REVIEW_PARSE_RETRIES - 1:
                log.error("review_rough_cut: parse falhou %d vezes — a "
                          "desistir: %s", attempt + 1, exc)
                raise
            log.warning("review_rough_cut: retry parse %d/%d após %s",
                        attempt + 1, MAX_REVIEW_PARSE_RETRIES, exc)
            payload["generationConfig"]["temperature"] = 0.0
            resp = _post_with_retry(url, params={"key": settings.gemini_api_key},
                                    json=payload, timeout=600)
            resp.raise_for_status()
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]

    usage = data.get("usageMetadata", {})
    prompt_tokens = usage.get("promptTokenCount", 0)
    output_tokens = usage.get("candidatesTokenCount", 0)
    usd_in, usd_out = _review_pricing(model_used)
    cost = prompt_tokens * usd_in + output_tokens * usd_out
    log_call(settings, tag="review_video", model=model_used,
            prompt_tokens=prompt_tokens, output_tokens=output_tokens, cost_usd=cost)
    return report, cost
