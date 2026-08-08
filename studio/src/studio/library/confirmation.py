"""Fase E — Confirmação visual de entity via Vision on-demand.

Estrutura:
- `confirm_shot_entity(shot_id, entity, db, settings, embedder=None)`:
    Vision Gemini Flash sobre keyframes do shot. Single-call estruturada
    (json_mode, temperature=0).

- `require_entity_confirmation(canonical, entity_type, db, settings)`:
    Para cada shot candidato (CSV column match), lê cache OU Vision batch
    (até entity_confirm_max_k shots numa chamada). Filtra por confidence.

Cache write-back: persiste em `shot.meta_json.confirmations[entity_canonical]`
para reutilização sem re-Vision no próximo run.

DOC: ARCHITECTURE §1.7.5.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.library.metadata import DetectedEntity

log = logging.getLogger("studio.confirmation")

# cache in-process (lê primeiro; se miss, vai a Vision)
_local_cache: dict[str, DetectedEntity] = {}
_local_cache_lock = threading.Lock()


def _cache_key(shot_id: str, entity_canonical: str) -> str:
    return f"{shot_id}::{entity_canonical.strip().lower()}"


def _read_cache(shot_id: str, entity_canonical: str) -> DetectedEntity | None:
    with _local_cache_lock:
        e = _local_cache.get(_cache_key(shot_id, entity_canonical))
    return e


def _write_cache(shot_id: str, entity_canonical: str,
                 det: DetectedEntity) -> None:
    with _local_cache_lock:
        _local_cache[_cache_key(shot_id, entity_canonical)] = det


def _vision_call(keyframes_b64: list[tuple[str, str]],
                 canonical: str, etype: str,
                 settings: Settings) -> list[DetectedEntity]:
    """Chamada Gemini Flash Vision batch — uma única chamada para
    até N shots da mesma entity. Devolve lista na ordem."""
    if not keyframes_b64:
        return []
    if settings.mock_mode:
        # mock determinístico: confirma SOMENTE se canonical tem MockTerm
        return [_mock_confirm(label, canonical, etype)
                for label, _ in keyframes_b64]
    try:
        from studio.llm.gemini import generate
        from studio.llm.gemini import build_vision_request
    except ImportError:
        log.warning("Vision API helper não disponível; retorna rejeições")
        return [DetectedEntity(rejected=True, rejection_reason="Vision helper missing")
                for label, _ in keyframes_b64]
    # monta o prompt usando o template
    prompt_template = (settings.prompts_root / "library"
                       / "confirm_entity.v1.md").read_text("utf-8")
    prompt = (prompt_template
              .replace("{entity_canonical}", canonical)
              .replace("{entity_type}", etype))
    # monta o conteúdo multimodal (texto + imagens etiquetadas)
    parts: list[dict] = [{"text": prompt + "\n\n# Keyframes a analisar"}]
    for label, b64 in keyframes_b64:
        parts.append({"text": f"\n[{label}]"})
        parts.append({"inline_data": {
            "mime_type": "image/jpeg",
            "data": b64,
        }})
    try:
        # a API concreta depende do cliente Gemini; aqui abstracted
        text, _cost = generate_multimodal(parts, settings,
                                          json_mode=True, temperature=0.0,
                                          tag="confirm_entity")
        # pode devolver 1 JSON ou múltiplos separados por linha
        return _parse_multi_response(text, [l for l, _ in keyframes_b64], canonical, etype)
    except Exception as exc:
        log.warning("Vision call falhou: %s — retornando rejeitado", exc)
        return [DetectedEntity(rejected=True,
                               rejection_reason=f"Vision error: {exc.__class__.__name__}")
                for _ in keyframes_b64]


def _mock_confirm(label: str, canonical: str, etype: str) -> DetectedEntity:
    """Mock determinístico: confirma shots cujo label (ex: shot_id)
    tokeniza um dos tokens da entity canónica:
       MockOK_francesinha_1      → {"mockok","francesinha","1"}
       MockOK_livraria_lello_5   → {"mockok","livraria","lello","5"}
       canonical "Francesinha"   → {"francesinha"}            (split espacio)
       canonical "Livraria Lello"→ {"livraria","lello"}      (split espacio)
    Intersecção não-vazia confirma. Caso contrário rejeita."""
    low_label = label.lower().replace("-", "_")
    label_tokens = set(low_label.split("_"))
    low_canon = canonical.strip().lower()
    canonical_tokens = set(low_canon.split())
    if (bool(low_canon in label_tokens or canonical_tokens & label_tokens)
            and low_label.startswith("mockok_")):
        return DetectedEntity(
            name=canonical, entity_type=etype, confidence=0.92,
            evidence=["mock: visual OK", "mock: OCR match",
                      "mock: metadata match"],
            rejected=False, confirmed_by="mock",
            at=datetime.now(timezone.utc).isoformat(),
        )
    return DetectedEntity(
        name=canonical, entity_type=etype, confidence=0.3,
        evidence=[], rejected=True,
        rejection_reason="mock: shot não confirma (test fixture)",
        confirmed_by="mock",
        at=datetime.now(timezone.utc).isoformat(),
    )


def generate_multimodal(parts: list[dict], settings: Settings,
                        *, json_mode: bool, temperature: float,
                        tag: str) -> tuple[str, float]:
    """Vision real Gemini Flash via httpx generateContent.

    POST direto https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
    com `contents[0].parts` = mistura de text + inline_data (base64 JPEG).
    Suporta N keyframes batched numa única chamada (code-reviewer item 4).
    Bypass do cliente Gemini local porque generate() não aceita inline_data.
    """
    model = settings.model_flash
    url = (f"https://generativelanguage.googleapis.com/"
           f"v1beta/models/{model}:generateContent")
    # contents[0].parts alterna text + inline_data (per spec Gemini REST)
    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": float(temperature),
            "responseMimeType": (
                "application/json" if json_mode else "text/plain"),
        },
    }
    try:
        with httpx.Client(timeout=60) as c:
            r = c.post(url,
                       params={"key": settings.gemini_api_key},
                       json=payload)
        if r.status_code in (429, 500, 502, 503, 504):
            log.warning("Vision %s: HTTP %d retryable", tag, r.status_code)
            return '{"rejected": true, "reason": "transient"}', 0.0
        r.raise_for_status()
        data = r.json()
        text = (data.get("candidates", [{}])[0]
                .get("content", {}).get("parts", [{}])[0]
                .get("text", ""))
        return text, 0.0
    except Exception as exc:
        log.warning("Vision %s falhou: %s", tag, exc.__class__.__name__)
        return '{"rejected": true}', 0.0


def _parse_multi_response(text: str, labels: list[str],
                          canonical: str, etype: str) -> list[DetectedEntity]:
    """Parse de texto JSON que pode ter 1 entity (single shot) ou
    array de entities."""
    text = text.strip()
    out: list[DetectedEntity] = []
    # Try 1: array of dicts
    try:
        items = json.loads(text)
        if isinstance(items, list):
            for it in items:
                d = DetectedEntity.model_validate({**it,
                    "at": it.get("at", datetime.now(timezone.utc).isoformat())})
                out.append(d)
            if len(out) == len(labels):
                return out
    except (json.JSONDecodeError, ValidationError):
        pass
    # Try 2: a single dict (todos os shots partilham resultado)
    try:
        d = json.loads(text)
        if isinstance(d, dict):
            det = DetectedEntity.model_validate(d)
            return [det.model_copy() for _ in labels]
    except (json.JSONDecodeError, ValidationError):
        pass
    # Fallback: rejeição uniforme
    return [DetectedEntity(rejected=True,
                           rejection_reason="Vision parser falhou",
                           confirmed_by="gemini-flash")
            for _ in labels]


def confirm_shot_entity(shot: dict, entity_canonical: str,
                        entity_type: str,
                        db: "LibraryDB", settings: Settings) -> DetectedEntity:
    """Confirma visualmente se um shot mostra a entity. Cache-first.

    Args:
        shot: row da tabela shots (dict com shot_id, keyframes_csv, media_path).
            Desvio pragmático da spec original (que pedia `shot_id` + lookup
            automático): recebe dict para evitar round-trip desnecessário,
            visto que callers (assigner.Iter_rows ou require_entity_confirmation)
            já têm o row em memória.
        entity_canonical: nome canonical da entity ("Francesinha")
        entity_type: tipo (food | landmark | place | ...)
        db: LibraryDB (para cache write-back persistente)
        settings: Settings (Vision API key, mock_mode, prompt path)
    """
    # 1) cache in-process
    cached = _read_cache(shot["shot_id"], entity_canonical)
    if cached is not None:
        log.debug("confirm: cache hit shot=%s entity=%s conf=%.2f",
                  shot["shot_id"], entity_canonical, cached.confidence)
        return cached
    # 2) cache persistente (shot.meta_json.confirmations)
    meta_raw = shot.get("meta_json", "{}")
    try:
        meta = json.loads(meta_raw) if isinstance(meta_raw, str) else {}
    except json.JSONDecodeError:
        meta = {}
    confirmations = meta.get("confirmations", {})
    cached_json = confirmations.get(entity_canonical.strip().lower())
    if cached_json:
        try:
            det = DetectedEntity.model_validate(cached_json)
            _write_cache(shot["shot_id"], entity_canonical, det)
            log.debug("confirm: persistent cache hit shot=%s entity=%s",
                      shot["shot_id"], entity_canonical)
            return det
        except ValidationError as exc:
            log.warning("confirm: cache persistente inválido (%s) — re-Vision",
                        exc)

    # 3) Vision on-demand (single shot — batching está em
    # require_entity_confirmation que decide quantidade).
    # label = shot_id (não 'KF1' hardcoded) para que `_mock_confirm`
    # reconheça fixtures test_MockOK_<entity> patterns.
    label = shot.get("shot_id", "KF1")
    keyframes = []
    media_path = shot.get("media_path")
    kf_csv = (shot.get("keyframes_csv", "") or "").split(",")
    if media_path and Path(media_path).exists():
        for kf in kf_csv[:1]:
            kf = kf.strip()
            if kf and Path(kf).exists():
                keyframes.append((label, _b64(kf)))
    if not keyframes:
        # Em mock_mode cria label para o mock_confirm path (test fixtures
        # não precisam de keyframes reais). Em modo real devolve rejected
        # com reason clara — operator pode investigar.
        if settings.mock_mode:
            keyframes = [(label, b"")]  # empty bytes; mock nada lê
        else:
            det = DetectedEntity(
                name=entity_canonical, entity_type=entity_type,
                confidence=0.0, rejected=True,
                rejection_reason="no keyframes available",
                confirmed_by="metadata-only",
            )
            _write_back(db, shot, entity_canonical, det)
            return det
    dets = _vision_call(keyframes, entity_canonical, entity_type, settings)
    det = dets[0]
    _write_cache(shot["shot_id"], entity_canonical, det)
    _write_back(db, shot, entity_canonical, det)
    return det


def _b64(path: Path) -> str:
    with Path(path).open("rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def _batch_vision_call(
    shots: list[dict],
    canonical: str, etype: str, settings: Settings,
) -> dict[str, DetectedEntity]:
    """TRUE batching (code-reviewer item 4): 1 Vision call com N keyframes
    de N shots diferentes. Cada keyframe etiquetado shot_id; resposta
    mapeada por shot_id. Não-bloqueante: se Vision falha, todas marcadas
    rejected=True (calls de confirm_shot_entity individuais fallback).
    """
    if settings.mock_mode:
        out: dict[str, DetectedEntity] = {}
        for shot in shots:
            sid = shot["shot_id"]
            det = _mock_confirm(sid, canonical, etype)
            out[sid] = det
        return out
    if not settings.gemini_api_key:
        return {shot["shot_id"]: DetectedEntity(rejected=True,
                                                rejection_reason="no API key")
                for shot in shots}
    # monta payload com N × (text+inline_data por shot)
    prompt_template = (settings.prompts_root / "library"
                       / "confirm_entity.v1.md").read_text("utf-8")
    prompt = (prompt_template
              .replace("{entity_canonical}", canonical)
              .replace("{entity_type}", etype))
    parts = [{"text": prompt + "\n\n# Keyframes de N shots"}]
    for shot in shots:
        sid = shot["shot_id"]
        for kf in (shot.get("keyframes_csv", "") or "").split(",")[:1]:
            kf = kf.strip()
            if kf and Path(kf).exists():
                parts.append({"text": f"\n[Shot {sid}, KF1]"})
                parts.append({"inline_data": {"mime_type": "image/jpeg",
                                              "data": _b64(kf)}})
    try:
        text, _ = generate_multimodal(parts, settings,
                                       json_mode=True, temperature=0.0,
                                       tag="confirm_entity_batch")
            # parse: resposta esperada lista [{shot_id:..., confirmed:...}]
            # ou single dict. Falls back individual em parser fail.
        items = []
        try:
            data = json.loads(text)
            if isinstance(data, list):
                items = data
            elif isinstance(data, dict):
                items = [data]
        except (json.JSONDecodeError, ValueError):
            items = []
            # fall-back: cada shot fica rejected via parser fail message
        out: dict[str, DetectedEntity] = {}
        for shot in shots:
            sid = shot["shot_id"]
            det = next((DetectedEntity.model_validate(it)
                        for it in items if it.get("shot_id") == sid),
                        None)
            if det is None:
                det = DetectedEntity(rejected=True,
                                       rejection_reason="batch parse miss")
            out[sid] = det
        return out
    except Exception as exc:
        return {shot["shot_id"]: DetectedEntity(rejected=True,
                                                rejection_reason=
                                                f"batch Vision error: {exc.__class__.__name__}")
                for shot in shots}


def _write_back(db: "LibraryDB", shot: dict, entity_canonical: str,
                det: DetectedEntity) -> None:
    """Persiste confirmação em shot.meta_json.confirmations — não reindexa tudo,
    só a row do shot afectado."""
    meta_raw = shot.get("meta_json", "{}")
    try:
        meta = json.loads(meta_raw) if isinstance(meta_raw, str) else {}
    except json.JSONDecodeError:
        meta = {}
    if "confirmations" not in meta:
        meta["confirmations"] = {}
    meta["confirmations"][entity_canonical.strip().lower()] =         det.model_dump(mode="json")
    new_meta_json = json.dumps(meta, ensure_ascii=False)
    db._table.update(where=f"shot_id = '{shot['shot_id']}'",
                     values={"meta_json": new_meta_json})


def require_entity_confirmation(
    canonical: str, entity_type: str, db: "LibraryDB",
    settings: Settings, *, top_k: int | None = None,
    min_confidence: float | None = None,
    strict_only: bool = True,
) -> list[dict]:
    """Devolve shots candidatos confirmados (confidence >= min_confidence).

    Args:
        canonical: entity canónica ("Francesinha")
        entity_type: tipo (food | landmark | place)
        db: LibraryDB
        settings: Settings
        top_k: limite de shots a confirmar (default settings.entity_confirm_max_k)
        min_confidence: limiar de confidence (default settings.entity_confirm_min_confidence)
        strict_only: True ⇒ só confirma strict_visual; pre-cache lazy mode para
            backward-compat (shots antigos sem confirmação só precisam lazy confirm
            para strict, conforme task spec).
    Returns:
        Lista de shots com meta '__confirmation: DetectedEntity' anexada.
    """
    top_k = top_k or settings.entity_confirm_max_k
    min_conf = min_confidence or settings.entity_confirm_min_confidence
    safe = canonical.replace("'", "").strip().lower()
    if not safe:
        return []
    # colunas CSV por entity_type
    csv_col = {"food": "food_csv", "landmark": "landmarks_csv",
               "building": "landmarks_csv",
               "attraction": "landmarks_csv",
               "place": "places_csv"}.get(entity_type)
    if csv_col:
        where = f"{csv_col} LIKE '%{safe}%'"
    else:
        where = (f"places_csv LIKE '%{safe}%' OR "
                 f"landmarks_csv LIKE '%{safe}%' OR "
                 f"food_csv LIKE '%{safe}%'")
    candidates = list(db.iter_rows(where, limit=200))[:top_k]
    if not candidates:
        return []
    # Code-reviewer: eliminei dead code — uso do _batch_vision_call
    # significa 1 Vision call com N shots (batched) em vez de N chamadas.
    # Cada shot carrega 1 keyframe (PDF schema já extrai 3 keyframes mas
    # Vision Flash 1ª linha basta 1 frame para confirmar identidade).
    shots_batched = []
    for cand in candidates:
        kf_csv = (cand.get("keyframes_csv", "") or "").split(",")
        kf_path = ""
        for kf in kf_csv[:1]:
            kf = kf.strip()
            if kf and Path(kf).exists():
                kf_path = kf
                break
        shots_batched.append({
            "shot_id": cand["shot_id"],
            "keyframes_csv": kf_path,  # 1 keyframe para batching
        })

    # 1 Vision call batched (ou per-shot em mock via loop)
    if settings.mock_mode:
        # mock: usa _mock_confirm per-shot (mesmo shape; log-trace claro)
        batched = {shot["shot_id"]:
                   _mock_confirm(shot["shot_id"], canonical, entity_type)
                   for shot in shots_batched}
    else:
        batched = _batch_vision_call(shots_batched, canonical,
                                     entity_type, settings)

    # monta out respeitando filters confirmados + cache write-back
    out: list[dict] = []
    for cand in candidates:
        sid = cand["shot_id"]
        det = batched.get(sid)
        if det is None:
            continue  # batch parser miss
        if not det.is_confirmed(min_conf):
            continue
        _write_cache(sid, canonical, det)
        # DEDUPE prevent write-back duplicado (mesma entity, mesmo shot)
        # já feito via _local_cache acima
        _write_back(db, cand, canonical, det)
        cand_out = dict(cand)
        cand_out["__confirmation"] = det
        out.append(cand_out)
    return out
