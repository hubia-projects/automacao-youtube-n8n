"""Phase 4 v2 — Wrapper canónico em volta de ingest_file (PRINCIPLE 5).

Esta é a ÚNICA função que callers externos devem usar para colocar media
na biblioteca. Replaces as múltiplas implementações paralelas detectadas
no audit (ingest_file + _process_one):

    - download Pexels/Pixabay/Vimeo (futuro P5 consumer)
    - cli `studio ingest <file>`
    - reconcile.py (orphan path)
    - topup.py (vai migrar de ingest_file → ingest_asset em Phase 6)
    - targeted micro-batch (futuro P9)

Responsabilidades ADICIONAIS ao ingest_file (P5 P6 P16):

    1. AssetState tracking (DISCOVERED → … → DONE) via sidecar JSON
       em data/library/states/<media_sha>.json (atómico tmp+rename).
    2. DB write verification P6: depois de ingest_file, db.get_shot()
       readback confirma que o LanceDB recebeu a row. Sem verify →
       FAILED_RETRYABLE (transient — vamos tentar de novo).
    3. Empty-media defence A1: se ingest_file devolve shots_added==0,
       em vez de loop infinito via DB verify fail, marcamos directamente
       FAILED_PERMANENT("empty_media"). Esses ficheiros devem sair do
       caminho. (Code-review ALTA apontado.)
    4. SHA único (A2): o sidecar JSON usa APENAS result.media_sha
       (computed por ingest_file._sha256 sobre todo o ficheiro). Não
       usamos um sha_pre de 64KB porque diverge em colisões raras.
       Para casos em que ingest_file rejeita antes de calcular SHA
       (LicenseError), usamos um identifier determinístico baseado em
       path+size para o sidecar.

DOC: 20-principles library plan §P5 P6.
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Optional, Union

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.library.embed import Embedder
from studio.library.ingest import IngestResult, ingest_file
from studio.library.licenses import LicenseError, LicenseRecord, validate_license
from studio.library.models import (
    AssetState,
    AssetStateRecord,
    AssetStateStore,
)

log = logging.getLogger("studio.library.ingest_asset")


def _path_based_id(path: Path) -> str:
    """Identifier determinístico para o sidecar quando ainda não temos
    media_sha real (rejected antes de ingest_file._sha256 correr).

    Formato: orphan:<name>|<size> — operacional e pesquisável. NÃO conflita
    com media_sha real porque SHA real é hexadecimal 64-char e este é
    prefixado "orphan:".
    """
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    return f"orphan:{path.name}|{size}"


def make_orphan_license(*, source_id: str = "",
                         attribution_text: str = "") -> LicenseRecord:
    """Synthetic LicenseRecord para órfãos (Phase 6 do plano architecture).

    `source='orphan'` é bypass em validate_license (não exige source_url
    obrigatório, aceita license='unknown', força share_alike=False). Usado
    pelo reconcile quando processa mp4 sem proveniência Pexels/Pixabay
    conhecida — e.g., os 908 órfãos herdados de runs anteriores.

    Args:
        source_id: id opaco (`pexels_12345` etc.) usado como proxy de URL
            para uniqueness do dedup cache. NÃO consulta o URL real.
        attribution_text: free-text registado em `ingest_log.jsonl` (audit).

    Returns:
        LicenseRecord validada — passou pelo branch orphan de validate_license.
    """
    lic = LicenseRecord(
        source="orphan",
        source_url=source_id or "orphan:unknown",
        license="unknown",
        attribution_text=attribution_text or
                        "orphan mp4 (no provenance verified)",
        share_alike=False,
        attribution_required=False,
        verified_by="manual",
    )
    return validate_license(lic)


def _verify_registered(sha: str, db: LibraryDB,
                       expected_min: int = 1) -> tuple[bool, int]:
    """Confirma que pelo menos `expected_min` rows existem em LanceDB
    para este media_sha. Devolve (ok, rows_found).

    DB verify é o pivot do P6: sem ele, DONE pode ser FALSO (LanceDB
    falhou a receber silenciosamente). O caller identifica FAILED_RETRYABLE
    e o resume automático re-tenta na próxima run.
    """
    if not sha or sha.startswith("orphan:"):
        return False, 0
    try:
        rows = (db._table.search()
                .where(f"media_sha = '{sha}'")
                .limit(max(50, expected_min * 5))
                .to_list())
        return len(rows) >= expected_min, len(rows)
    except Exception as exc:
        log.warning("ingest_asset.verify_registered failed (sha=%s): %s",
                    sha[:12], exc)
        # Fail-soft: assume not registered; caller pode retry.
        return False, 0


def ingest_asset(
    path: Path,
    license_raw: Union[dict, LicenseRecord, None],
    db: LibraryDB,
    settings: Settings,
    embedder: Embedder,
    *,
    source_id: Optional[str] = None,
    video_id: Optional[str] = None,
    expected_shots: int = 1,
    state_store: Optional[AssetStateStore] = None,
    requirement_prompts: Optional[dict] = None,
) -> tuple[IngestResult, AssetStateRecord]:
    """Wrapper canónico de ingest_file com P5+P6 invariantes.

    Args:
        path:                ficheiro local (.mp4 / .mov / etc.)
        license_raw:         dict OU LicenseRecord OU None
        db / settings / embedder: como ingest_file
        source_id:           pexels_12345 etc. persistido no sidecar JSON
        video_id:            se ingest foi para um workset específico
        expected_shots:      nº mínimo esperado de shots adicionados (>=1)
        state_store:         override (para tests); default = AssetStateStore()
        requirement_prompts: dict[canonical_entity -> text_en] para SigLIP
            triage pré-Gemini (HOT path real §P5 2026-08-11). None →
            legacy fallback per-shot analyze_shot.

    Returns:
        (IngestResult, AssetStateRecord). Caller usa `record.state` para
        saber estado final:
          - AssetState.DONE               → asset na library, verificado
          - AssetState.FAILED_RETRYABLE   → retry em runs futuras
          - AssetState.FAILED_PERMANENT   → não insistir (licença/empty/corrupted)
          - outros estados                → caller decide
    """
    store = state_store or AssetStateStore()
    fallback_id = _path_based_id(path)

    # === Hot path: ingest_file does the real work. =============================
    try:
        # PROPOGA requirement_prompts para ingest_file (HOT path real). None
        # mantém compat legacy (per-shot analyze_shot).
        result = ingest_file(
            path, license_raw, db, settings, embedder,
            requirement_prompts=requirement_prompts,
        )
    except LicenseError as exc:
        # Permanent failure — license invalid; retry will not change outcome.
        rec = store.transition(
            fallback_id, AssetState.FAILED_PERMANENT,
            source_path=str(path), source_id=source_id, video_id=video_id,
            error=f"license: {exc}",
        )
        log.warning("ingest_asset: rejected (license) %s — %s",
                    path.name, exc)
        return IngestResult(status="rejected", reason=str(exc)), rec
    except Exception as exc:
        # Transient — network/OOM/timeout may resolve on retry. Use fallback
        # identifier because real SHA ainda não existe (ingest_file raised
        # before _sha256 ran).
        rec = store.transition(
            fallback_id, AssetState.FAILED_RETRYABLE,
            source_path=str(path), source_id=source_id, video_id=video_id,
            error=f"transient: {exc.__class__.__name__}: {exc}",
        )
        log.warning("ingest_asset: transient exception %s — %s",
                    path.name, exc)
        return IngestResult(status="rejected", reason=str(exc)), rec

    # === Skipped duplicate (already registered, no work to re-do) ============
    if result.status == "skipped_duplicate":
        sha = result.media_sha
        if sha:
            # force=True aqui é LEGÍTIMO: skipped significa que ESTE
            # media_sha já estava DONE antes; transitionamos para DONE
            # do estado actual (que pode ser INGESTING, etc.). Não usa
            # force em transições normais (ver success path abaixo).
            try:
                rec = store.transition(
                    sha, AssetState.DONE,
                    source_path=str(path), source_id=source_id,
                    video_id=video_id, force=True,
                )
            except Exception as exc:
                # Se transition falhar (lock contention), devolve o que temos
                log.debug("skipped_duplicate transition raised: %s", exc)
                rec = store.get(sha) or AssetStateRecord(
                    media_sha=sha, source_path=str(path),
                    state=AssetState.DONE,
                )
        else:
            rec = AssetStateRecord(
                media_sha=fallback_id, source_path=str(path),
                state=AssetState.DONE,
            )
        return result, rec

    # === ingest_file returned "rejected" without raising — license short-circuit
    if result.status == "rejected":
        sha = result.media_sha or fallback_id
        rec = store.transition(
            sha, AssetState.FAILED_PERMANENT,
            source_path=str(path), source_id=source_id, video_id=video_id,
            error=result.reason or "license rejected (silent)",
        )
        return result, rec

    # === ingest_file says "ingested" (sem exception). Validação P6 ============
    if not result.media_sha:
        rec = store.transition(
            fallback_id, AssetState.FAILED_RETRYABLE,
            source_path=str(path), source_id=source_id, video_id=video_id,
            error="ingest_file returned ingested sem media_sha",
        )
        log.error("ingest_asset: ingested sem SHA — fail-safe FAILED_RETRYABLE")
        return result, rec

    sha = result.media_sha   # AUTHORITATIVE — ingest_file._sha256 (full file)

    # ---- A1: empty media (0 shots detectados) → FAILED_PERMANENT --------------
    # Sem cenas detectadas, o ficheiro não tem footage utilizável. Loop
    # infinito em retries via DB verify fail; marcamos permanente para
    # triage humano futuro.
    if result.shots_added == 0:
        rec = store.transition(
            sha, AssetState.FAILED_PERMANENT,
            source_path=str(path), source_id=source_id, video_id=video_id,
            error="empty_media: 0 shots detectados (SceneDetect vazio)",
        )
        log.warning(
            "ingest_asset: empty media %s (sha=%s) — FAILED_PERMANENT",
            path.name, sha[:12],
        )
        return result, rec

    # ---- happy path: REGISTERED → VERIFIED → DONE -----------------------------
    # NOTA A3: NÃO usamos force=True aqui. REGISTERED→VERIFIED→DONE são
    # todas transições válidas; force=True mascararia bugs futuros que
    # saltassem VERIFIED.
    try:
        store.transition(
            sha, AssetState.REGISTERED,
            source_path=str(path), source_id=source_id, video_id=video_id,
        )
    except Exception as exc:
        log.error("ingest_asset: REGISTERED transition raise: %s", exc)
        # Se mesmo esta transição falha, marcar FAIL_RETRYABLE para re-tentar.
        rec = store.transition(
            sha, AssetState.FAILED_RETRYABLE,
            source_path=str(path), source_id=source_id, video_id=video_id,
            error=f"REGISTERED transition raise: {exc}",
        )
        return result, rec

    ok, rows_found = _verify_registered(sha, db, expected_min=expected_shots)
    if not ok:
        # LanceDB silently rejected/dropped the writes — fail-closed!
        # (P6: state=DONE without get_shot verify is FORBIDDEN).
        rec = store.transition(
            sha, AssetState.FAILED_RETRYABLE,
            source_path=str(path), source_id=source_id, video_id=video_id,
            error=f"DB verify failed: rows_found={rows_found} "
                  f"expected_min={expected_shots}",
        )
        log.error(
            "ingest_asset: DB verify FAILED para sha=%s (rows=%d expected=%d) — "
            "LanceDB não reflecte a row; FAILED_RETRYABLE",
            sha[:12], rows_found, expected_shots,
        )
        return result, rec

    # VERIFIED → DONE (no force, since both transitions are valid)
    rec_verified = store.transition(
        sha, AssetState.VERIFIED,
        source_path=str(path), source_id=source_id, video_id=video_id,
    )
    rec_final = store.transition(
        sha, AssetState.DONE,
        source_path=str(path), source_id=source_id, video_id=video_id,
    )
    log.info(
        "ingest_asset: DONE %s shots=%d cost=$%.4f sha=%s",
        path.name, result.shots_added, result.cost_usd,
        sha[:12],
    )
    return result, rec_final


__all__ = ["ingest_asset"]
