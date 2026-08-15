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
from urllib.parse import unquote, urlparse

import httpx
from pydantic import ValidationError

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.library.metadata import DetectedEntity
from studio.library.rate_limit import get_gemini_limiter
from studio.library.text_match import distinctive_words

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
        return [DetectedEntity(rejected=True, infra_failure=True,
                               rejection_reason="Vision helper missing")
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
        return [DetectedEntity(rejected=True, infra_failure=True,
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
    # item 21 (Gemini Vision único): esta função nunca passava pelo
    # GeminiRateLimiter partilhado com metadata.py — cada caller (batch
    # de metadados vs confirmação de entidades) hamartelava a API
    # independentemente, e o próprio docstring de rate_limit.py já listava
    # esta função como consumer esperado. Fail-fast (sem HTTP) se o
    # circuit-breaker estiver aberto, tal como metadata.py.
    limiter = get_gemini_limiter(settings)
    if not limiter.acquire(timeout=30.0):
        log.warning("Vision %s: circuit breaker open — fail-fast", tag)
        return ('{"rejected": true, "infra_failure": true, '
                '"rejection_reason": "circuit_breaker_open"}', 0.0)
    try:
        with httpx.Client(timeout=60) as c:
            r = c.post(url,
                       params={"key": settings.gemini_api_key},
                       json=payload)
        if r.status_code in (429, 500, 502, 503, 504):
            log.warning("Vision %s: HTTP %d retryable", tag, r.status_code)
            return ('{"rejected": true, "infra_failure": true, '
                    '"rejection_reason": "transient"}', 0.0)
        r.raise_for_status()
        data = r.json()
        text = (data.get("candidates", [{}])[0]
                .get("content", {}).get("parts", [{}])[0]
                .get("text", ""))
        return text, 0.0
    except Exception as exc:
        log.warning("Vision %s falhou: %s", tag, exc.__class__.__name__)
        return ('{"rejected": true, "infra_failure": true, '
                '"rejection_reason": "vision_call_exception"}', 0.0)


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
    return [DetectedEntity(rejected=True, infra_failure=True,
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
        return {shot["shot_id"]: DetectedEntity(rejected=True, infra_failure=True,
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

        # BUG REAL (microvalidação real, 2026-08-14): quando Gemini julga
        # os shots do batch visualmente consistentes o suficiente para
        # dar 1 veredicto único (ex.: 2 fotos claramente da MESMA
        # entidade), devolve 1 dict SEM "shot_id" — nunca um array por
        # shot. Sem isto, o `it.get("shot_id") == sid` abaixo nunca batia
        # e o batch INTEIRO ficava "batch parse miss" mesmo com
        # confirmação clara e confidence=1.0 real (confirmado ao vivo:
        # Livraria Lello, evidence real — texto OCR "LELLO & IRMÃO",
        # vitral "DECUS IN LABORE" — descartado por este bug de parsing,
        # não por Vision ter dito não). Mesma semântica de
        # `_parse_multi_response()` (linha ~207-212): 1 dict sem shot_id
        # aplica-se a TODOS os shots do batch.
        single_verdict: DetectedEntity | None = None
        if len(items) == 1 and "shot_id" not in items[0]:
            try:
                single_verdict = DetectedEntity.model_validate(items[0])
            except ValidationError:
                single_verdict = None

        out: dict[str, DetectedEntity] = {}
        for shot in shots:
            sid = shot["shot_id"]
            if single_verdict is not None:
                out[sid] = single_verdict.model_copy()
                continue
            det = next((DetectedEntity.model_validate(it)
                        for it in items if it.get("shot_id") == sid),
                        None)
            if det is None:
                det = DetectedEntity(rejected=True, infra_failure=True,
                                       rejection_reason="batch parse miss")
            out[sid] = det
        return out
    except Exception as exc:
        return {shot["shot_id"]: DetectedEntity(rejected=True, infra_failure=True,
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


def _confirm_batch(
    batch: list[dict], canonical: str, entity_type: str, settings: Settings,
) -> dict[str, DetectedEntity]:
    """1 Vision call batched (ou per-shot em mock) para `batch`. Extraído
    de `require_entity_confirmation` (item K/L) para ser chamado em
    micro-batches progressivos em vez de uma única chamada."""
    shots_batched = []
    for cand in batch:
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
    if settings.mock_mode:
        return {shot["shot_id"]:
               _mock_confirm(shot["shot_id"], canonical, entity_type)
               for shot in shots_batched}
    return _batch_vision_call(shots_batched, canonical, entity_type, settings)


# item PORTO (search+confirmation calibration): zona de corroboração —
# Vision entre 0.70 e o threshold global (min_conf, tipicamente 0.85) NÃO
# confirma nem rejeita de imediato; só confirma como
# CS_CONFIRMED_CORROBORATED se houver >=2 famílias de evidência
# INDEPENDENTES (fontes/campos diferentes) coerentes com a entidade. O piso
# 0.70 é fixo (doutrina explícita do pedido), independente de min_conf.
_CORROBORATION_FLOOR = 0.70


def _source_title(source_url: str) -> str:
    """Extrai título legível do `source_url` já existente na tabela shots
    (ex: URL de página Wikimedia contém o nome do ficheiro) — zero schema
    novo, só parsing do que já lá está."""
    if not source_url:
        return ""
    stem = urlparse(source_url).path.rsplit("/", 1)[-1]
    stem = stem.rsplit(".", 1)[0] if "." in stem else stem
    return unquote(stem).replace("_", " ").replace("-", " ")


def _corroboration_families(
    det: DetectedEntity, shot: dict, canonical: str,
    aliases: tuple[str, ...],
) -> set[str]:
    """Famílias de evidência INDEPENDENTES (não-Vision) corroborando
    `canonical`/`aliases` — usadas só na zona borderline (ver
    `_CORROBORATION_FLOOR`). Cada família vem de um campo/fonte distinto:
    `OCR_EXACT` (texto lido na imagem pelo próprio Vision call, campo
    estruturado `ocr_text_found`) e `SOURCE_TITLE_MATCH` (metadata do
    provider já persistida em `source_url`, nunca gerada pelo Vision) —
    nunca contar duas vezes o mesmo campo/origem como duas famílias."""
    name_words: set[str] = set()
    for n in (canonical, *aliases):
        name_words |= distinctive_words(n)
    if not name_words:
        return set()

    families: set[str] = set()
    if any(distinctive_words(t) & name_words for t in (det.ocr_text_found or ())):
        families.add("OCR_EXACT")
    if distinctive_words(_source_title(shot.get("source_url", ""))) & name_words:
        families.add("SOURCE_TITLE_MATCH")
    return families


def require_entity_confirmation(
    canonical: str, entity_type: str, db: "LibraryDB",
    settings: Settings, *, top_k: int | None = None,
    min_confidence: float | None = None,
    strict_only: bool = True,
    target_seconds: float | None = None,
    min_distinct_shots: int | None = None,
    requirement_id: str | None = None,
    workset_id: str | None = None,
    requirement_index: object | None = None,
    max_batches: int = 5,
    aliases: tuple[str, ...] = (),
) -> list[dict]:
    """Devolve shots candidatos confirmados (confidence >= min_confidence).

    Args:
        canonical: entity canónica ("Francesinha")
        entity_type: tipo (food | landmark | place)
        db: LibraryDB
        settings: Settings
        top_k: limite de shots por MICRO-BATCH Vision (default
            settings.entity_confirm_max_k). Sem `target_seconds`/
            `min_distinct_shots`, é também o limite TOTAL de candidatos
            (comportamento legacy: 1 único micro-batch).
        min_confidence: limiar de confidence (default settings.entity_confirm_min_confidence)
        strict_only: True ⇒ só confirma strict_visual; pre-cache lazy mode para
            backward-compat (shots antigos sem confirmação só precisam lazy confirm
            para strict, conforme task spec).
        target_seconds / min_distinct_shots: item K/L (closure pass) — quando
            fornecidos, activa modo PROGRESSIVO: confirma micro-batches de
            `top_k` shots (nunca todos os candidatos numa só chamada Vision)
            e PARA assim que a soma de durações confirmadas atingir
            `target_seconds` E o nº de shots distintos confirmados atingir
            `min_distinct_shots` — ou quando os candidatos/`max_batches`
            se esgotarem primeiro (safety cap, nunca Vision ilimitado).
        requirement_id / workset_id / requirement_index: item K/L — quando
            fornecidos (RequirementIndex real), dois efeitos: (1) shots já
            `CS_CONFIRMED`/`CS_REJECTED` nesta requirement são EXCLUÍDOS do
            próximo batch (nunca re-Vision o mesmo shot); (2) cada resultado
            (confirmado OU rejeitado) é sincronizado de volta via
            `ri.upsert_match` com o `confirmation_status` REAL — não só o
            cache local/`meta_json` (que só guarda os confirmados).
        aliases: nomes alternativos da mesma entidade (de
            `EntityCoverage.aliases`) — usados só na zona de corroboração
            (confidence entre `_CORROBORATION_FLOOR` e min_conf) para
            `_corroboration_families`; nunca afecta zona A (>=min_conf) nem
            zona C (<0.70).
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
    candidates_all = list(db.iter_rows(where, limit=200))
    if not candidates_all:
        return []

    progressive = target_seconds is not None or min_distinct_shots is not None
    ri_active = (requirement_index is not None and workset_id
                and requirement_id)

    known_status: set[str] = set()
    if ri_active:
        try:
            from studio.library.requirement_index import (
                CS_CONFIRMED, CS_CONFIRMED_CORROBORATED, CS_REJECTED,
            )
            _known = (CS_CONFIRMED, CS_CONFIRMED_CORROBORATED, CS_REJECTED)
            for m in requirement_index.list_for_requirement(
                    workset_id, requirement_id):
                if m.confirmation_status in _known:
                    known_status.add(m.shot_id)
        except Exception as exc:
            log.debug("require_entity_confirmation: RequirementIndex "
                     "lookup falhou (não fatal): %s", exc.__class__.__name__)

    candidates = [c for c in candidates_all
                 if c.get("shot_id") not in known_status]
    if not progressive:
        # legacy exacto: 1 único micro-batch, top_k é o limite TOTAL.
        candidates = candidates[:top_k]

    out: list[dict] = []
    confirmed_seconds = 0.0
    confirmed_distinct = 0
    batches_run = 0
    idx = 0
    while idx < len(candidates):
        if progressive:
            secs_ok = confirmed_seconds >= (target_seconds or 0.0)
            shots_ok = confirmed_distinct >= (min_distinct_shots or 0)
            if secs_ok and shots_ok:
                break
            if batches_run >= max_batches:
                break
        batch = candidates[idx:idx + top_k]
        idx += top_k
        batches_run += 1

        batched = _confirm_batch(batch, canonical, entity_type, settings)

        for cand in batch:
            sid = cand["shot_id"]
            det = batched.get(sid)
            if det is None:
                continue  # batch parser miss

            # item PORTO (search+confirmation calibration): decisão em
            # camadas — zona A (>=min_conf) confirma puro, threshold
            # global INTOCADO; zona B (0.70..min_conf) só confirma como
            # CORROBORATED com >=2 famílias de evidência independentes
            # (nunca por rigidez artificial nem por facilitismo); zona C
            # (<0.70) rejeita sempre, sem excepção.
            zone_a = (not det.rejected and bool(det.name)
                     and det.confidence >= min_conf)
            corroborated = False
            families: set[str] = set()
            if (not zone_a and not det.rejected and bool(det.name)
                    and _CORROBORATION_FLOOR <= det.confidence < min_conf):
                families = _corroboration_families(det, cand, canonical, aliases)
                corroborated = len(families) >= 2
            confirmed = zone_a or corroborated

            if ri_active:
                try:
                    from studio.library.requirement_index import (
                        CS_CONFIRMED, CS_CONFIRMED_CORROBORATED,
                        CS_FAILED_RETRYABLE, CS_REJECTED, RequirementMatch,
                    )
                    dur = max(0.0, float(cand.get("t_out", 0.0))
                             - float(cand.get("t_in", 0.0)))
                    # item 15 (automation closure): infra_failure distingue
                    # "Vision genuinely disse não" (CS_REJECTED, nunca mais
                    # re-tentado) de "não conseguimos nem perguntar" (rede,
                    # parse, circuit breaker, sem API key) — esse caso vai
                    # para CS_FAILED_RETRYABLE, elegível para retry em runs
                    # futuras (known_status acima só exclui CONFIRMED/
                    # CORROBORATED/REJECTED, nunca FAILED_RETRYABLE).
                    if zone_a:
                        status = CS_CONFIRMED
                    elif corroborated:
                        status = CS_CONFIRMED_CORROBORATED
                    elif det.infra_failure:
                        status = CS_FAILED_RETRYABLE
                    else:
                        status = CS_REJECTED
                    # similarity=0.0: esta match vem de Vision (ground
                    # truth), não de SigLIP — o sinal real está em
                    # confirmation_status/confidence/evidence, não aqui.
                    # Diferente do anti-padrão corrigido no bug 2 (que
                    # usava similarity=0 SEM nenhuma evidência real).
                    extra_evidence = (
                        tuple(f"corroboration:{f}" for f in sorted(families))
                        if corroborated else ()
                    )
                    requirement_index.upsert_match(RequirementMatch(
                        workset_id=workset_id, requirement_id=requirement_id,
                        shot_id=sid, media_sha=cand.get("media_sha", ""),
                        similarity=0.0, duration=dur,
                        confirmation_status=status,
                        confirmation_confidence=float(det.confidence),
                        strict_eligible=True,
                        evidence=tuple(det.evidence or ()) + extra_evidence,
                    ))
                except Exception as exc:
                    log.debug("require_entity_confirmation: upsert_match "
                             "falhou (não fatal): %s", exc.__class__.__name__)

            if not confirmed:
                continue
            _write_cache(sid, canonical, det)
            _write_back(db, cand, canonical, det)
            cand_out = dict(cand)
            cand_out["__confirmation"] = det
            out.append(cand_out)
            if progressive:
                confirmed_seconds += max(
                    0.0, float(cand.get("t_out", 0.0))
                    - float(cand.get("t_in", 0.0)))
                confirmed_distinct += 1
    return out
