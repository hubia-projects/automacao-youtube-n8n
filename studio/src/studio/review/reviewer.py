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
from studio.llm.gemini import log_call
from studio.review.rubric import Fix, GlobalReview, ReviewReport, SceneReview

log = logging.getLogger("studio.reviewer")

UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files"
FILES_URL = "https://generativelanguage.googleapis.com/v1beta/{name}"
GEN_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_USD_IN, _USD_OUT = 1.25 / 1e6, 10.0 / 1e6  # pro

# Gemini Pro em JSON mode às vezes devolve respostas truncadas (max_output_tokens
# acima de 11k chars para o nosso prompt). Até `MAX_REVIEW_PARSE_RETRIES` retries
# com temperature=0 absorvem isso sem repetir o upload do ficheiro (file_uri
# continua válido por 24h).
MAX_REVIEW_PARSE_RETRIES = 3

# upload multipart + generateContent com vídeo demoram minutos — falhas de
# rede transitórias (DNS, timeout) não devem obrigar a um `studio resume`
# manual; retry curto absorve isso sem repetir chamadas já pagas
_TRANSIENT = (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout,
             httpx.RemoteProtocolError)


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
    last_exc: Exception | None = None
    for i in range(attempts):
        try:
            return httpx.post(url, **kwargs)
        except _TRANSIENT as exc:
            last_exc = exc
            log.warning("rede transitória (tentativa %d/%d) em %s: %s",
                       i + 1, attempts, url, exc)
            if i < attempts - 1:
                time.sleep(5)
    raise last_exc  # type: ignore[misc]


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
    resp = _post_with_retry(UPLOAD_URL, params={"key": settings.gemini_api_key,
                                                "uploadType": "multipart"},
                            files=files, timeout=300)
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
    url = GEN_URL.format(model=settings.model_pro)
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
    cost = prompt_tokens * _USD_IN + output_tokens * _USD_OUT
    log_call(settings, tag="review_video", model=settings.model_pro,
            prompt_tokens=prompt_tokens, output_tokens=output_tokens, cost_usd=cost)
    return report, cost
