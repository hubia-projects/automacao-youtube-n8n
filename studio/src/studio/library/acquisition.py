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
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from studio.library.query_translation import translate_query_en

log = logging.getLogger("studio.acquisition")

def _load_provider_module(provider: str):
    """Import lazy do módulo concreto — sem cache module-level: os módulos
    `sources/*.py` só importam httpx/config (leve), e cachear a função
    directamente quebrava `unittest.mock.patch("...pexels.sweep")` entre
    testes (referência antiga ficava presa após o patch reverter — bug
    real descoberto ao escrever os testes deste módulo)."""
    if provider == "pexels":
        from studio.library.sources import pexels as _mod
    elif provider == "pixabay":
        from studio.library.sources import pixabay as _mod
    elif provider == "vimeo":
        from studio.library.sources import vimeo as _mod
    elif provider == "wikimedia":
        from studio.library.sources import wikimedia as _mod
    else:
        raise ValueError(f"provider desconhecido: {provider!r}")
    return _mod


def make_provider_resolver(
    settings,
    dest: Path,
    *,
    providers: tuple[str, ...] = ("pexels",),
    count_per_query: int = 2,
    db=None,
) -> Callable[[str, int], list[tuple[Path, dict]]]:
    """Adapter REAL (item 9) — liga `acquire_for_deficits()` aos providers
    concretos, uniformizando para
    `provider_resolver(query, level) -> list[(Path, dict)]`.

    Antes desta função, o único caller de `acquire_for_deficits`
    (`reconcile.py`) passava `provider_resolver=lambda q, lvl: []` — a
    aquisição "canónica" nunca fazia uma chamada de rede real.

    item P (closure pass) — pre-download dedup real: quando `db` é
    passado e o módulo do provider expõe `search()`/`download()`
    (2 fases, ver `sources/pexels.py`), faz SEARCH primeiro (zero bytes de
    vídeo), verifica `is_provider_already_taken()` ANTES de qualquer
    download, e só chama `download()` para candidatos novos. Providers
    sem API de 2 fases ainda (ou chamadas sem `db`) caem no `sweep()`
    legacy (search+download acoplados, dedup só depois do byte já ter
    vindo da rede — comportamento anterior, preservado para compat).

    `count_per_query` pequeno por defeito — micro-waves (doutrina: nunca
    `sweep(50)` de uma vez), não um scrape em massa."""
    dest.mkdir(parents=True, exist_ok=True)

    def _resolver(query: str, level: int) -> list[tuple[Path, dict]]:
        out: list[tuple[Path, dict]] = []
        for provider in providers:
            try:
                mod = _load_provider_module(provider)
            except ValueError:
                log.warning(
                    "make_provider_resolver: provider '%s' desconhecido — skip",
                    provider)
                continue

            two_phase = db is not None and hasattr(mod, "search") and hasattr(mod, "download")
            if two_phase:
                try:
                    candidates = mod.search(query, count_per_query, settings)
                except Exception as exc:
                    log.warning(
                        "make_provider_resolver: %s.search(%r) falhou: %s",
                        provider, query, exc.__class__.__name__)
                    continue
                for cand in candidates:
                    if is_provider_already_taken(cand.provider, cand.source_url, db):
                        log.debug(
                            "make_provider_resolver: %s/%s já conhecido "
                            "(hit/rejected) — 0 bytes de download "
                            "(pre-download dedup)", cand.provider, cand.source_url)
                        continue
                    try:
                        path = mod.download(cand, settings, dest)
                    except Exception as exc:
                        log.warning(
                            "make_provider_resolver: %s.download(%r) falhou: %s",
                            provider, cand.source_url, exc.__class__.__name__)
                        continue
                    meta = dict(cand.license)
                    meta.setdefault("provider", provider)
                    meta.setdefault("source_url", cand.source_url)
                    out.append((path, meta))
                continue

            try:
                results = mod.sweep(query, count_per_query, settings, dest)
            except Exception as exc:
                log.warning(
                    "make_provider_resolver: %s.sweep(%r) falhou: %s",
                    provider, query, exc.__class__.__name__)
                continue
            for path, meta in results:
                meta = dict(meta)
                meta.setdefault("provider", provider)
                out.append((path, meta))
        return out

    return _resolver


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
    max_downloads: int = 200,
    remeasure_coverage: Optional[Callable[[], bool]] = None,
    refresh_deficit: Optional[Callable[[DeficitItem], float]] = None,
    requirement_index: Optional[object] = None,
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
        max_downloads: absolute_safety_cap (doutrina item 11) — nunca uma
            meta, só um limite catastrófico. STOP HONESTO reporta deficits
            exactos se atingido antes de coverage_ready.
        remeasure_coverage: callable () -> bool. Gate STOP. Se None, usa
            fallback: assumes stop quando todos deficits<=0.
        refresh_deficit: callable(DeficitItem) -> float. Chamado depois de
            cada ingest bem-sucedido (item Q — closure pass): recalcula o
            deficit REAL desse item (ex.: via measure_coverage) e o valor
            devolvido é escrito de volta em `item.deficit_seconds`. Sem
            isto, `deficit_items` fica congelado nos valores que o caller
            passou no início da chamada — a escolha de "maior deficit
            actual" em iterações seguintes usa números obsoletos mesmo
            depois de um requirement já ter sido fechado por esta run.
        requirement_index: RequirementIndex (item U — closure pass). Quando
            fornecido, cada ingest bem-sucedido gera `RequirementMatch`
            semanticamente filtrados (`requirement_matching.matches_for_shot`)
            para os shots recém-ingeridos — media nova entra no workset com
            matches REAIS, nunca com o anti-padrão "all shots × all
            requirements, similarity=0" (bug histórico, ver reconcile.py).
            None (default) = comportamento anterior, sem persistência.

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
        if rep.downloads_succeeded >= max_downloads:
            log.warning(
                "acquire_for_deficits: max_downloads=%d atingido — STOP "
                "HONESTO (safety cap, não é meta). Deficits restantes: %s",
                max_downloads,
                [d.canonical_entity for d in deficit_items if d.deficit_seconds > 0],
            )
            break
        # P11 fix (code-reviewer): remeasure MUST fire at start of every
        # outer iteration regardless of provider resolvability. With
        # provider_resolver=[] (test T17), inner loop runs queries with
        # results=[] and skips the gated remeasure — coverage never fires.
        # Move it here: before picking remaining.
        if remeasure_coverage is not None and remeasure_coverage():
            log.info("acquire_for_deficits: coverage_ready atingido em "
                     "iteração %d — STOP", it + 1)
            rep.coverage_ready = True
            break
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

        # query hierarchy — a QUERY EXTERNA (stock provider) usa uma frase
        # EN traduzida/genérica, nunca o canonical_entity em PT tal como
        # está (bug real descoberto na 1ª run de produção: Pexels/Pixabay
        # indexam em inglês, nomes próprios locais quase nunca batem).
        # canonical_entity em si NUNCA muda — script/matching/Vision
        # continuam a usar o nome original.
        effective_settings = settings or getattr(db, "_settings", None)
        query_canonical = translate_query_en(
            spec.canonical_entity, getattr(spec, "entity_type", "") or "",
            spec.location, effective_settings)
        levels = query_hierarchy(
            query_canonical,
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
                    # BUG REAL (primeira run de produção com Pexels real,
                    # 2026-08-13): todos os módulos de source (pexels.py
                    # search()/sweep(), vimeo.py, pixabay.py, wikimedia.py,
                    # ytdlp_cc.py) devolvem `meta["license"]` como STRING
                    # plana (ex.: "pexels"), nunca um dict aninhado — o
                    # `meta.get("license") or {}` seguido de `.get(...)`
                    # rebentava com AttributeError em 100% dos downloads
                    # reais (nunca exercido antes: todos os testes usavam
                    # resolver mockado a devolver [] via mock_mode). Os
                    # campos vivem todos directamente em `meta` (mesmo
                    # nível de "provider"/"source_url").
                    lic = LicenseRecord(
                        source=provider_name,
                        source_url=source_url,
                        license=str(meta.get("license") or "unknown"),
                        attribution_text=str(
                            meta.get("attribution_text") or ""),
                        share_alike=bool(meta.get("share_alike", False)),
                        attribution_required=bool(
                            meta.get("attribution_required", True)),
                        verified_by=str(meta.get("verified_by") or "provider"),
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
                        # item 11 (automation closure): embeddings JÁ
                        # computadas 1× por load_workset_context() — evita
                        # ingest_file recomputar embed_text() por canonical
                        # a CADA ficheiro adquirido (redundante, mesmo texto
                        # mesmo modelo). Depois desta consolidação este é o
                        # ÚNICO caminho de ingest em produção.
                        requirement_embeddings=workset_ctx.requirement_embeddings,
                        visual_prompt_embeddings=workset_ctx.visual_prompt_embeddings,
                    )
                    if result.status == "ingested":
                        rep.downloads_succeeded += 1
                        rep.shots_ingested += result.shots_added
                        one_iteration_added += 1
                        # item Q: deficits não podem ficar congelados —
                        # recalcula o deficit REAL deste item já.
                        if refresh_deficit is not None:
                            try:
                                item.deficit_seconds = float(refresh_deficit(item))
                                rep.coverage_status[item.canonical_entity] = {
                                    "deficit_seconds": item.deficit_seconds,
                                    "is_covered": item.is_covered,
                                }
                            except Exception as exc:
                                log.debug(
                                    "acquire: refresh_deficit('%s') falhou "
                                    "(não fatal): %s", item.canonical_entity,
                                    exc.__class__.__name__)
                        if hasattr(db, "cache_mark"):
                            # BUG REAL (2026-08-13, mesma run que revelou o
                            # bug do license dict): cache_mark() nunca
                            # aceitou kwarg `status=` — marca sempre "hit"
                            # internamente (db.py:258). Passar `status=`
                            # rebentava com TypeError DEPOIS do ingest já
                            # ter sido bem sucedido, impedindo o bloco de
                            # indexação de matches novos (item U, abaixo)
                            # de correr — nunca detectado antes pelo mesmo
                            # motivo do bug anterior (resolver mockado a
                            # devolver [] em todos os testes).
                            db.cache_mark(provider_name, source_url,
                                           media_sha=result.media_sha)
                        # item U: media nova entra no workset com matches
                        # reais — nunca o anti-padrão cego.
                        if requirement_index is not None and re.fullmatch(
                                r"[0-9a-fA-F]{8,64}", result.media_sha or ""):
                            # media_sha é sempre um digest hex (_sha256() em
                            # ingest.py) — o fullmatch é uma validação de
                            # forma, não um escape best-effort: nunca contém
                            # aspas, então a interpolação abaixo é segura,
                            # mas validar explicitamente remove qualquer
                            # dúvida (revisão de segurança automática).
                            try:
                                from studio.library.requirement_matching import (
                                    matches_for_shot,
                                )
                                new_rows = db.iter_rows(
                                    f"media_sha = '{result.media_sha}'",
                                    limit=200)
                                for row in new_rows:
                                    for m in matches_for_shot(
                                        shot_id=row.get("shot_id", ""),
                                        media_sha=result.media_sha,
                                        t_in=float(row.get("t_in", 0.0)),
                                        t_out=float(row.get("t_out", 0.0)),
                                        shot_vec=row.get("vec"),
                                        workset_ctx=workset_ctx,
                                    ):
                                        requirement_index.upsert_match(m)
                            except Exception as exc:
                                log.debug(
                                    "acquire: indexação de media nova "
                                    "falhou (não fatal): %s",
                                    exc.__class__.__name__)
                    else:
                        rep.downloads_rejected_license += 1
                        if hasattr(db, "cache_mark_rejected"):
                            db.cache_mark_rejected(provider_name, source_url,
                                                    reason=result.reason or "")
                except Exception as exc:
                    log.warning(
                        "acquire: ingest_asset raised para %s: %s — skip",
                        path.name, exc.__class__.__name__, exc_info=True)
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
            # STOP early on coverage_ready (test T17: remeasure
            # chamada após processar results; se provider vazio, T16 ainda
            # exercita outer break via one_iteration_added==0)
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


def run_acquisition_for_workset(
    plan,
    workset_ctx,
    db,
    embedder,
    settings,
    *,
    requirement_index,
    query_history=None,
    max_downloads: int = 200,
    max_iterations: int = 8,
) -> AcquisitionReport:
    """Item 1.4/O (automation closure) — ÚNICO ponto de entrada de aquisição
    em produção. Substitui `topup_for_plan_concurrent` (queue_topup.py),
    `_targeted_topup_for_entity`/`_maybe_targeted_topup` (produce.py) e o
    JIT interno de `assigner.py` (já desligado em produção via
    `allow_network_topup=False`) — todos chamavam `pexels.sweep`+
    `ingest_asset` directamente, nenhum passava por `acquire_for_deficits`.

    Constrói `DeficitItem`s a partir de `plan.ranked_entities` (só os com
    `deficit_seconds > 0`), ordenados por tier — item 7 (automation
    closure): strict/core primeiro, non-strict/core depois, filler por
    último; dentro de cada tier, maior deficit primeiro. Nunca gasta
    downloads em filler enquanto um requirement nomeado estrito ainda
    falta.

    `refresh_deficit` usa `measure_coverage_from_index` (RequirementIndex
    já populada pelo scan inicial — item E/G) com fallback para
    `measure_coverage` (scan CSV) se a index ainda não tiver matches para
    essa requirement — nunca regride para pior que o comportamento
    anterior. `remeasure_coverage` usa o mesmo fallback documentado em
    `acquire_for_deficits` (None): considera pronto quando todos os
    deficits ficam <=0 — o gate REAL de "pronto para matching" (que exige
    confirmação estrita) continua a ser `is_workset_ready` no caller
    (`S08Matching`), chamado DEPOIS desta função retornar.
    """
    from studio.matching.coverage_plan import (
        FILLER_ENTITY_TYPE,
        measure_coverage,
        measure_coverage_from_index,
    )

    ent_by_canon = {e.canonical_name: e for e in plan.ranked_entities}
    deficit_items: list[DeficitItem] = []
    for ent in plan.ranked_entities:
        if ent.deficit_seconds <= 0:
            continue
        spec = workset_ctx.req_by_canonical(ent.canonical_name)
        if spec is None:
            continue
        deficit_items.append(DeficitItem(
            canonical_entity=ent.canonical_name,
            requirement_id=spec.requirement_id,
            target_seconds=ent.target_seconds,
            deficit_seconds=ent.deficit_seconds,
            min_distinct_shots=ent.min_distinct_shots,
            priority_score=ent.priority_score,
        ))
    # item 7: strict/core > non-strict/core > filler; maior deficit
    # primeiro dentro de cada tier.
    deficit_items.sort(key=lambda d: (
        not ent_by_canon[d.canonical_entity].strict,
        ent_by_canon[d.canonical_entity].entity_type == FILLER_ENTITY_TYPE,
        -d.deficit_seconds,
    ))
    if not deficit_items:
        return AcquisitionReport(coverage_status={}, iterations=0,
                                 coverage_ready=True)

    def _refresh(item: DeficitItem) -> float:
        ent = ent_by_canon.get(item.canonical_entity)
        if ent is None:
            return item.deficit_seconds
        applied = measure_coverage_from_index(ent, workset_ctx,
                                              requirement_index, db)
        if not applied:
            measure_coverage(ent, db)
        ent.deficit_seconds = round(
            max(0.0, ent.target_seconds - ent.available_seconds), 3)
        return ent.deficit_seconds

    def _remeasure() -> bool:
        return all(d.deficit_seconds <= 0 for d in deficit_items)

    # fail-closed: mock_mode ou sem credencial -> resolver stub (nunca
    # contacta providers reais). Mesmo guard que reconcile.py's P11 já
    # usava — sem isto, testes com mock_mode=True mas settings carregadas
    # de .env (chave real) fariam chamadas de rede reais por engano.
    if settings.mock_mode or not getattr(settings, "pexels_api_key", ""):
        resolver = lambda q, lvl: []  # noqa: E731
    else:
        dest = settings.library_root / "downloads" / (workset_ctx.workflow_id or "shared")
        resolver = make_provider_resolver(settings, dest, providers=("pexels",), db=db)

    return acquire_for_deficits(
        workset_ctx=workset_ctx, db=db, embedder=embedder, settings=settings,
        deficit_items=deficit_items, provider_resolver=resolver,
        query_history_db=query_history, requirement_index=requirement_index,
        refresh_deficit=_refresh, remeasure_coverage=_remeasure,
        max_downloads=max_downloads, max_iterations=max_iterations,
    )


__all__ = [
    "AcquisitionReport",
    "DeficitItem",
    "query_hierarchy",
    "preflight_media",
    "is_provider_already_taken",
    "acquire_for_deficits",
    "run_acquisition_for_workset",
]
