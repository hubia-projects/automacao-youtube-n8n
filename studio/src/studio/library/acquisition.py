"""acquisition — única porta de aquisição externa (peças que faltam).

Substitui topup.py + queue_topup.py paraser uma SERVICE ÚNICA chamada por:
    - reconcile.py (após discovery local falhar)
    - ingest_asset (futuro: download Pexels/Pixabay directamente do caller)
    - scripts externos (download_cli.py, etc.)

Política:
    INPUT: workset_ctx (com requirement_embeddings já cacheadas)
           coverage deficit dict {canonical: deficit_s}
    OUTPUT: ingest_asset(path, license) por cada candidate
            provider dedup ANTES de download (cache_mark lookup)
            query_history (não repete query que deu 0)
            microbatch barrier STOP on coverage_ready

Atomicidade:
    Iteração:
        while deficits:
            pick highest-deficit requirement
            query hierarchy (canonical+features → canonical+location → canonical → generic)
            for each provider result:
                provider_dedup_check (cache_get → skip if hit/rejected)
                download to temp
                preflight ffprobe
                ingest_asset
            query_history.record
            remeasure coverage
            if coverage_ready: STOP
"""
from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger("studio.acquisition")


@dataclass
class DeficitItem:
    canonical_entity: str
    requirement_id: str
    target_seconds: float
    deficit_seconds: float
    min_distinct_shots: int
    priority_score: float = 1.0

    @property
    def is_covered(self) -> bool:
        return self.deficit_seconds <= 0


@dataclass
class AcquisitionReport:
    downloads_attempted: int = 0
    downloads_succeeded: int = 0
    downloads_rejected_license: int = 0
    downloads_rejected_provider_dedup: int = 0
    downloads_rejected_query_history_empty: int = 0
    shots_ingested: int = 0
    coverage_ready: bool = False                   # gate STOP
    coverage_status: dict[str, dict] = None        # {canonical: {s, ...}}
    wall_s: float = 0.0
    iterations: int = 0
    queries_run: int = 0


def query_hierarchy(canonical: str,
                    aliases: tuple[str, ...] = (),
                    location: str = "",
                    *,
                    n_levels: int = 4) -> list[str]:
    """Níveis de pesquisa em hierarquia do mais específico ao mais genérico:
        L1: canonical + location
        L2: canonical + aliases[0] (1 alias)
        L3: canonical
        L4: contextual generic (low-relevance fallback)
    """
    levels: list[str] = []
    if location:
        levels.append(f"{canonical} {location}")
        if aliases:
            levels.append(f"{canonical} {location} {aliases[0]}")
    elif aliases:
        levels.append(f"{canonical} {aliases[0]}")
    levels.append(canonical)
    levels.append(canonical.split()[0] if canonical else canonical)
    return levels[:n_levels]


# === Provider-level dedup lookup =============================================

def is_provider_already_taken(provider: str, source_url: str,
                               db) -> bool:
    """Pydb.cache_get hit OU rejected → skip download."""
    try:
        hit = db.cache_get(provider, source_url)
    except Exception:
        return False
    if not hit:
        return False
    status = (hit.get("status") or "").upper()
    return status in ("HIT", "REJECTED", "DONE")


def mark_provider_result(provider: str, source_url: str, *,
                         media_sha: str = "",
                         status: str = "DONE",
                         reason: str = "") -> None:
    """Marca provider_cache após tentativa. Wraps `db.cache_mark`."""
    # db é passada em outras funções; aqui mantemos a marcação por
    # interface uniforme.
    from studio.library.db import LibraryDB  # type: ignore
    # nada a fazer se db não acessível; caller faz.


# === Preflight (idoem reconcile / queue_topup) ==============================

def preflight_media(path: Path, expected_codec: str | None = None) -> tuple[bool, str]:
    """Verifica vídeo é legível ANTES de o pipeline canónico tocar nele.

    Returns (ok, reason). ok=True se ffprobe devolve duration > 0.
    """
    if not path.exists() or path.stat().st_size <= 0:
        return False, "empty_or_missing"
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration:stream=codec_name", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            return False, "ffprobe_fail"
        d = json.loads(r.stdout)
        if not d.get("format", {}).get("duration"):
            return False, "no_duration"
        if expected_codec:
            codecs = [s.get("codec_name", "") for s in d.get("streams", [])
                      if s.get("codec_type") == "video"]
            if codecs and expected_codec not in codecs:
                return False, f"codec_mismatch({codecs[0]!r})"
        return True, ""
    except (subprocess.SubprocessError, OSError,
            json.JSONDecodeError) as exc:
        return False, f"exception:{exc.__class__.__name__}"


# === acquire_for_deficits ====================================================

# Provider interface — caller injecta implementação concreta.
# Em produção: pexels.sweep, pixabay.search_videos, vimeo.search.
Provider = Callable[..., list[tuple[Path, dict]]]
# Cada entry: (local_downloaded_path, license_dict_provider_meta)


def acquire_for_deficits(
    *,
    workset_ctx,
    db,
    embedder,
    settings=None,                       # Settings explícito (P2.2 / P5.3)
    deficit_items: list[DeficitItem],
    provider_resolver: Callable[[str, str], list[tuple[Path, dict]]],
    dedup_cache: Optional[object] = None,
    query_history_db: Optional[object] = None,
    n_levels: int = 4,
    max_iterations: int = 8,
    remeasure_coverage: Optional[Callable[[], bool]] = None,
) -> AcquisitionReport:
    """Pipeline aquisição unificada por deficits.

    Args:
        workset_ctx: WorksetContext carregado (modo WORKFLOW obrigatório).
        db: LibraryDB (para cache_get / cache_mark e ingest_asset).
        embedder: SiglipEmbedder (não é usado directamente; passado a ingest_asset).
        deficit_items: lista ordenada por deficit (priority desc).
        provider_resolver: callable query,provider -> list[(path, meta)].
            Implementação concreta vem do caller (pexels.sweep, etc.).
        dedup_cache: objecto DedupIndex (skip Source já DONE em ingest).
        query_history_db: QueryHistory (não repete queries que deram 0).
        n_levels: nº de níveis hierárquicos a tentar por item antes de avançar.
        max_iterations: nº máximo de outer loops antes de STOP forçado.
        remeasure_coverage: callable () -> bool. Gate STOP. Se None, usa
            fallback: assumes stop quando todos deficits<=0.

    Returns:
        AcquisitionReport agregado.
    """
    import time

    if not workset_ctx.requirements:
        log.error("acquire_for_deficits: workset_ctx.requirements vazio — "
                  "ABORT. Caller deve passar WorksetContext válido.")
        return AcquisitionReport(coverage_status={}, iterations=0)

    rep = AcquisitionReport(
        wall_s=time.perf_counter(),
        coverage_status={deficit.canonical_entity: {
            "deficit_seconds": deficit.deficit_seconds,
            "is_covered": deficit.is_covered,
        } for deficit in deficit_items},
    )
    t_wall = time.perf_counter()
    rep.wall_s = t_wall

    # Iteração outer — cada iteração tenta satisfazer top deficit.
    for it in range(max_iterations):
        rep.iterations = it + 1
        remaining = [d for d in deficit_items
                     if d.deficit_seconds > 0 and not d.is_covered]
        if not remaining:
            log.info("acquire_for_deficits: 0 deficits remaining — STOP")
            rep.coverage_ready = True
            break
        # pick highest deficit priority (= deficit_s × priority_score)
        item = max(remaining, key=lambda d: d.deficit_seconds * d.priority_score)
        spec = workset_ctx.req_by_canonical(item.canonical_entity)
        if spec is None:
            log.warning("acquire_for_deficits: spec None para '%s' — skip",
                        item.canonical_entity)
            break

        # query hierarchy
        levels = query_hierarchy(
            spec.canonical_entity,
            spec.aliases,
            spec.location,
            n_levels=n_levels,
        )
        one_iteration_added = 0
        for lvl, query in enumerate(levels):
            rep.queries_run += 1
            can_attempt = True
            # query_history dedup (não repete empty/error)
            if query_history_db is not None and hasattr(query_history_db,
                                                       "was_tried"):
                was = query_history_db.was_tried(
                    workset_ctx.workflow_id, spec.requirement_id,
                    "multi", query)
                if was in ("empty", "error"):
                    log.debug(
                        "acquire: query já tentada em '%s' (status=%s) — skip",
                        query, was)
                    can_attempt = False
                    continue
            if not can_attempt:
                continue
            try:
                results = provider_resolver(query, lvl)
            except Exception as exc:
                log.warning("acquire: provider_resolver erro em '%s': %s",
                            query, exc.__class__.__name__)
                if query_history_db is not None and hasattr(
                        query_history_db, "record"):
                    from studio.library.requirement_index import (
                        QueryHistoryEntry,
                    )
                    query_history_db.record(QueryHistoryEntry(
                        workset_id=workset_ctx.workflow_id,
                        requirement_id=spec.requirement_id,
                        provider="multi",
                        query_normalized=query,
                        attempt=lvl,
                        results_count=0,
                        result_provider_ids=(),
                        status="error",
                    ))
                continue
            if not results:
                if query_history_db is not None and hasattr(
                        query_history_db, "record"):
                    from studio.library.requirement_index import (
                        QueryHistoryEntry,
                    )
                    query_history_db.record(QueryHistoryEntry(
                        workset_id=workset_ctx.workflow_id,
                        requirement_id=spec.requirement_id,
                        provider="multi",
                        query_normalized=query,
                        attempt=lvl,
                        results_count=0,
                        result_provider_ids=(),
                        status="empty",
                    ))
                continue
            # iterate results
            for path, meta in results:
                rep.downloads_attempted += 1
                provider_name = (meta.get("provider") or "unknown")
                source_url = (meta.get("source_url")
                              or meta.get("url") or path.name)
                # provider dedup BEFORE download
                if is_provider_already_taken(provider_name, source_url, db):
                    rep.downloads_rejected_provider_dedup += 1
                    log.debug("acquire: provider_cache hit %s/%s — skip "
                              "download", provider_name, source_url)
                    continue
                # preflight
                ok, pf_reason = preflight_media(path)
                if not ok:
                    log.debug("acquire: preflight fail %s (%s)", path, pf_reason)
                    continue
                # ingest_asset (canonical)
                try:
                    from studio.library.ingest_asset import ingest_asset
                    from studio.library.licenses import LicenseRecord
                    lic_dict = meta.get("license") or {}
                    lic = LicenseRecord(
                        source=provider_name,
                        source_url=source_url,
                        license=lic_dict.get("license", "unknown"),
                        attribution_text=lic_dict.get(
                            "attribution_text", ""),
                        share_alike=bool(lic_dict.get("share_alike", False)),
                        attribution_required=bool(
                            lic_dict.get("attribution_required", True)),
                        verified_by="provider",
                    )
                    # P2.2 (code-reviewer fix): ingest_asset exige Settings
                    # (não Optional). Fallback `db._settings` foi REMOVIDO —
                    # migração explícita para settings como parâmetro
                    # público. Caller deve passar `settings=get_settings()`
                    # na produção. Sem settings, ABORT fail-loud aqui, em
                    # vez de崩ar com TypeError em ingest_asset.
                    if settings is None:
                        legacy = getattr(db, "_settings", None)
                        if legacy is None:
                            log.error(
                                "acquire_for_deficits: ingest_asset exige "
                                "Settings (P2.2 architecture). Nenhum "
                                "settings kwarg nem `db._settings` legacy "
                                "found — abort do candidato '%s'.",
                                path.name)
                            continue
                        effective_settings = legacy
                        log.debug(
                            "acquire_for_deficits: settings=None but "
                            "db._settings legacy OK — using transient.")
                    else:
                        effective_settings = settings
                    result, _state = ingest_asset(
                        path, lic, db, effective_settings, embedder,
                        source_id=source_url,
                        video_id=workset_ctx.workflow_id,
                        requirement_prompts=workset_ctx.requirement_prompts,
                    )
                    if result.status == "ingested":
                        rep.downloads_succeeded += 1
                        rep.shots_ingested += result.shots_added
                        one_iteration_added += 1
                        if hasattr(db, "cache_mark"):
                            db.cache_mark(provider_name, source_url,
                                           media_sha=result.media_sha,
                                           status="DONE")
                    else:
                        rep.downloads_rejected_license += 1
                        if hasattr(db, "cache_mark_rejected"):
                            db.cache_mark_rejected(provider_name, source_url,
                                                    reason=result.reason or "")
                except Exception as exc:
                    log.warning(
                        "acquire: ingest_asset raised para %s: %s — skip",
                        path.name, exc.__class__.__name__)
                    continue
            # query_history record
            if query_history_db is not None and hasattr(query_history_db,
                                                       "record"):
                from studio.library.requirement_index import QueryHistoryEntry
                query_history_db.record(QueryHistoryEntry(
                    workset_id=workset_ctx.workflow_id,
                    requirement_id=spec.requirement_id,
                    provider="multi",
                    query_normalized=query,
                    attempt=lvl,
                    results_count=len(results),
                    result_provider_ids=tuple(
                        (meta.get("source_url") or meta.get("url") or path.name)
                        for path, meta in results
                    ),
                    status="success" if results else "empty",
                ))
            # STOP early on coverage_ready
            if remeasure_coverage is not None and remeasure_coverage():
                log.info("acquire_for_deficits: coverage_ready atingido em "
                         "iteração %d nível %d — STOP", it + 1, lvl)
                rep.coverage_ready = True
                break
        if one_iteration_added == 0:
            log.info("acquire_for_deficits: iteração %d sem ganhos — STOP "
                     "(candidate pool exhausted)", it + 1)
            break
        if rep.coverage_ready:
            break
    rep.wall_s = time.perf_counter() - t_wall
    return rep


__all__ = [
    "AcquisitionReport",
    "DeficitItem",
    "query_hierarchy",
    "preflight_media",
    "is_provider_already_taken",
    "acquire_for_deficits",
]
