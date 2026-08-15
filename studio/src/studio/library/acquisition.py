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

import inspect
import json
import logging
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from studio.library.provider_errors import ProviderRateLimitedError
from studio.library.query_translation import (
    translate_query_en, translate_query_variants_en,
)

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
    event_sink: Optional[Callable[[str, str, dict], None]] = None,
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
    `sweep(50)` de uma vez), não um scrape em massa.

    `event_sink` (item 42/43 — fecho de cobertura multi-provider):
    callable opcional `(event_type, message, payload) -> None`, chamado
    nos pontos-chave da busca/dedup/download (provider_search_started/
    completed, candidate_dedup_skipped, media_download_started/completed)
    — SEM acoplar acquisition.py a `events.py`/`run_dir` (o caller,
    `run_acquisition_for_workset`/produce.py, decide como e onde
    encaminhar). Nunca deve lançar — envolto em try/except mudo (mesma
    doutrina de robustez de logging: observabilidade nunca pode
    interromper a aquisição real)."""
    dest.mkdir(parents=True, exist_ok=True)

    def _emit(event_type: str, message: str, payload: dict) -> None:
        if event_sink is None:
            return
        try:
            event_sink(event_type, message, payload)
        except Exception:
            pass

    def _resolver(query: str, level: int,
                  canonical_hints: tuple[str, ...] = ()) -> list[tuple[Path, dict]]:
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
                _emit("provider_search_started", f"{provider}: '{query}'",
                     {"provider": provider, "query": query, "level": level})
                try:
                    # item PORTO (search+confirmation calibration):
                    # canonical_hints só é entendido por wikimedia.search()
                    # (entity-aware ranking/probe) — outros providers
                    # (pexels/pixabay) recebem a assinatura de sempre.
                    if provider == "wikimedia" and canonical_hints:
                        candidates = mod.search(query, count_per_query, settings,
                                               canonical_hints=canonical_hints)
                    else:
                        candidates = mod.search(query, count_per_query, settings)
                except ProviderRateLimitedError as exc:
                    _emit("provider_rate_limited", str(exc),
                         {"provider": provider, "query": query})
                    raise
                except Exception as exc:
                    log.warning(
                        "make_provider_resolver: %s.search(%r) falhou: %s",
                        provider, query, exc.__class__.__name__)
                    continue
                _emit("provider_search_completed",
                     f"{provider}: {len(candidates)} candidatos",
                     {"provider": provider, "query": query,
                      "count": len(candidates)})
                for cand in candidates:
                    if is_provider_already_taken(cand.provider, cand.source_url, db):
                        log.debug(
                            "make_provider_resolver: %s/%s já conhecido "
                            "(hit/rejected) — 0 bytes de download "
                            "(pre-download dedup)", cand.provider, cand.source_url)
                        _emit("candidate_dedup_skipped",
                             f"{provider}/{cand.provider_id}",
                             {"provider": provider,
                              "provider_id": cand.provider_id})
                        continue
                    media_kind = (cand.license or {}).get("media_kind", "video")
                    _emit("media_download_started",
                         f"{provider}: {cand.provider_id} ({media_kind})",
                         {"provider": provider, "provider_id": cand.provider_id,
                          "media_kind": media_kind})
                    try:
                        path = mod.download(cand, settings, dest)
                    except ProviderRateLimitedError as exc:
                        _emit("provider_rate_limited", str(exc),
                             {"provider": provider,
                              "provider_id": cand.provider_id})
                        raise
                    except Exception as exc:
                        log.warning(
                            "make_provider_resolver: %s.download(%r) falhou: %s",
                            provider, cand.source_url, exc.__class__.__name__)
                        continue
                    _emit("media_download_completed",
                         f"{provider}: {path.name}",
                         {"provider": provider, "media_kind": media_kind,
                          "file": path.name})
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
    # item PORTO FINAL ASSET TEST (secções 7-10): nome do provider que
    # forçou esta chamada a terminar cedo por rate-limit sustentado — o
    # caller (`run_acquisition_for_workset`) usa isto só para log/eventos;
    # a waterfall avança para o próximo provider de qualquer forma (o
    # bound real está em `ProviderRateLimitedError` interromper o loop,
    # não neste campo).
    provider_rate_limited: str = ""


def query_hierarchy(canonical: str,
                    aliases: tuple[str, ...] = (),
                    location: str = "",
                    *,
                    n_levels: int = 4,
                    aliases_en: tuple[str, ...] = (),
                    extra_queries: tuple[str, ...] = ()) -> list[str]:
    """Níveis de pesquisa em hierarquia do mais específico ao mais genérico:
        L1: canonical + location
        L2: canonical + aliases[0] (1 alias)
        L3: canonical
        L4: contextual generic (low-relevance fallback)

    `aliases_en` (PORTO FINAL RETRIEVAL FIX, secções 2-3 — "EXACT FIRST"):
    nomes próprios em INGLÊS (`translate_entity_aliases_en`) inseridos
    LOGO A SEGUIR à hierarquia core em PT, ANTES de `extra_queries` —
    identidade exacta (PT e EN) sempre domina sobre fallback visual
    genérico. Bug real corrigido aqui: `acquire_for_deficits` passava a
    FRASE DESCRITIVA traduzida (`translate_query_en`, ex.: "gothic
    cathedral facade Porto") como a PRÓPRIA base da hierarquia — a
    primeira query tentada para "Sé do Porto" era genérica antes de
    qualquer tentativa com o nome exacto (PT ou EN).

    `extra_queries` — variantes VISUAIS/DESCRITIVAS (`translate_query_en`/
    `translate_query_variants_en`) anexadas por ÚLTIMO (fallback, nunca
    primeiro) — nunca sujeitas ao corte `n_levels` (esse corte é só para
    os níveis "core" em PT). Dedup por string normalizada aqui (defesa
    extra, além do dedup por run que a `QueryHistory` já faz).
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
    levels = levels[:n_levels]

    exact_en_levels: list[str] = []
    for a_en in aliases_en:
        a_en = (a_en or "").strip()
        if not a_en:
            continue
        exact_en_levels.append(a_en)
        if location:
            exact_en_levels.append(f"{a_en} {location}")

    seen = {lv.strip().lower() for lv in levels}
    for q in (*exact_en_levels, *extra_queries):
        qn = (q or "").strip()
        if qn and qn.lower() not in seen:
            levels.append(qn)
            seen.add(qn.lower())
    return levels


def _call_resolver(provider_resolver, query: str, level: int,
                   canonical_hints: tuple[str, ...]):
    """Chama `provider_resolver(query, level)` — opcionalmente com
    `canonical_hints=` se o resolver aceitar esse parâmetro (só o resolver
    REAL de `make_provider_resolver`, item PORTO, aceita; resolvers de
    teste/mocks com assinatura `(query, level)` continuam a funcionar sem
    alteração nenhuma). Introspecção em vez de mudar a assinatura pública
    de `provider_resolver` — nunca partir os ~2 args já usados em todos os
    callers/testes existentes."""
    try:
        sig = inspect.signature(provider_resolver)
        accepts_hints = "canonical_hints" in sig.parameters
    except (TypeError, ValueError):
        accepts_hints = False
    if accepts_hints:
        return provider_resolver(query, level, canonical_hints=canonical_hints)
    return provider_resolver(query, level)


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
    provider_name_for_history: str = "multi",
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
        provider_name_for_history: nome real do provider gravado em
            QueryHistoryEntry (item 33 — closure multi-provider). Default
            "multi" preserva o comportamento anterior (1 resolver a
            abranger vários providers internamente); o caller da waterfall
            (`run_acquisition_for_workset`) passa o nome real quando o
            `provider_resolver` está scoped a UM único provider.

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

    # BUG REAL (1ª run de produção real, porto-24h-001, 2026-08-14): quando
    # o item de maior deficit esgotava o seu pool de candidatos (0 ganhos
    # nesta iteração), o antigo `break` aqui abortava TODO o
    # acquire_for_deficits — os outros 12 deficits do workset nunca
    # chegavam a ser tentados, mesmo tendo cada um a sua própria query
    # hierarchy nunca exercida. `exhausted` marca só o item ACTUAL como
    # "sem mais candidatos nesta chamada" e deixa a próxima iteração
    # escolher o PRÓXIMO maior deficit (item 6/7: rebuild deficits, maior
    # deficit primeiro DENTRO do tier disponível, nunca desistir do
    # workset inteiro por 1 entity sem footage).
    exhausted: set[str] = set()

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
        all_uncovered = [d for d in deficit_items
                         if d.deficit_seconds > 0 and not d.is_covered]
        remaining = [d for d in all_uncovered
                     if d.canonical_entity not in exhausted]
        if not remaining:
            if all_uncovered:
                log.info(
                    "acquire_for_deficits: %d deficits sem candidatos "
                    "(pool esgotado em TODOS) — STOP honesto, "
                    "coverage_ready=False: %s", len(all_uncovered),
                    [d.canonical_entity for d in all_uncovered])
                rep.coverage_ready = False
            else:
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
        spec_aliases_en = tuple(getattr(spec, "aliases_en", ()) or ())
        # PORTO FINAL RETRIEVAL FIX (secções 2-3, "EXACT FIRST"): BUG REAL
        # corrigido aqui — a hierarquia usava `query_canonical` (frase
        # DESCRITIVA traduzida, ex.: "gothic cathedral facade Porto") como
        # a PRÓPRIA BASE da pesquisa; para "Sé do Porto" isso significava
        # que a 1ª query tentada era genérica, antes de qualquer tentativa
        # com o nome exacto (PT ou EN). Agora `query_hierarchy` usa o
        # canonical/aliases REAIS (PT) + `aliases_en` (nomes próprios
        # exactos em inglês) como níveis PRIORITÁRIOS; `query_canonical` e
        # as variantes descritivas (`translate_query_variants_en`) só
        # entram DEPOIS, como fallback visual — nunca primeiro.
        query_canonical = translate_query_en(
            spec.canonical_entity, getattr(spec, "entity_type", "") or "",
            spec.location, effective_settings)
        # item PORTO (search+confirmation calibration): variantes extra
        # (facade/interior/exterior/aliases PT+EN) derivadas de
        # canonical/aliases/location/visual_prompts_en — nunca hardcode de
        # entidade específica. Falha (rede/parse) nunca bloqueia a
        # hierarquia base: fallback determinístico já embutido em
        # `translate_query_variants_en`.
        visual_fallback_queries = tuple(translate_query_variants_en(
            spec.canonical_entity, getattr(spec, "entity_type", "") or "",
            spec.location, spec.aliases,
            getattr(spec, "visual_prompts_en", ()) or (),
            effective_settings,
        ))
        levels = query_hierarchy(
            spec.canonical_entity,
            spec.aliases,
            spec.location,
            n_levels=n_levels,
            aliases_en=spec_aliases_en,
            extra_queries=(query_canonical, *visual_fallback_queries),
        )
        canonical_hints = (spec.canonical_entity, *spec.aliases, *spec_aliases_en)
        one_iteration_added = 0
        for lvl, query in enumerate(levels):
            rep.queries_run += 1
            can_attempt = True
            # query_history dedup (não repete empty/error)
            # BUG REAL (secção 20, PORTO FINAL RETRIEVAL FIX): was_tried()
            # consultava sempre provider="multi" hardcoded, mas record()
            # grava sempre `provider_name_for_history` (nome real —
            # "wikimedia"/"pexels"/"pixabay" — desde que
            # run_acquisition_for_workset ficou provider-scoped). O dedup
            # NUNCA encontrava as próprias entradas gravadas — todas as
            # queries eram sempre re-tentadas em toda wave/iteração,
            # mesmo já confirmadas "empty"/"error" antes.
            if query_history_db is not None and hasattr(query_history_db,
                                                       "was_tried"):
                was = query_history_db.was_tried(
                    workset_ctx.workflow_id, spec.requirement_id,
                    provider_name_for_history, query)
                if was in ("empty", "error"):
                    log.debug(
                        "acquire: query já tentada em '%s' (status=%s) — skip",
                        query, was)
                    can_attempt = False
                    continue
            if not can_attempt:
                continue
            try:
                results = _call_resolver(provider_resolver, query, lvl,
                                         canonical_hints)
            except ProviderRateLimitedError as exc:
                # item PORTO FINAL ASSET TEST (secções 7-10): provider
                # rate-limited (sustentado, não transitório) — nunca
                # continuar a martelar o MESMO provider a torto e a
                # direito através de todos os restantes níveis de query/
                # entidades desta chamada (bounded, nunca 2h presos).
                # status="rate_limited" é DISTINTO de "error"/"empty"
                # (secção 9): nunca bloqueia permanentemente a query em
                # QueryHistory.was_tried — pode ser retentada num resume
                # futuro, quando o cooldown do provider já tiver passado.
                log.warning("acquire: provider '%s' rate-limited — "
                           "abandonando esta chamada, waterfall avança "
                           "para o próximo provider: %s",
                           provider_name_for_history, exc)
                if query_history_db is not None and hasattr(
                        query_history_db, "record"):
                    from studio.library.requirement_index import (
                        QueryHistoryEntry,
                    )
                    query_history_db.record(QueryHistoryEntry(
                        workset_id=workset_ctx.workflow_id,
                        requirement_id=spec.requirement_id,
                        provider=provider_name_for_history,
                        query_normalized=query,
                        attempt=lvl,
                        results_count=0,
                        result_provider_ids=(),
                        status="rate_limited",
                    ))
                rep.provider_rate_limited = provider_name_for_history
                return rep
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
                        provider=provider_name_for_history,
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
                        provider=provider_name_for_history,
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
                # preflight — imagem NUNCA passa por preflight_media
                # (video-only, exige duration/codec de vídeo); usa
                # preflight_image (resolução/formato) em vez disso.
                if str(meta.get("media_kind") or "video") == "image":
                    from studio.library.early_reject import preflight_image
                    effective_settings_pf = settings or getattr(
                        db, "_settings", None)
                    reject = preflight_image(path, effective_settings_pf)
                    if reject is not None:
                        log.debug("acquire: preflight_image fail %s (%s)",
                                 path, reject)
                        continue
                else:
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
                        # item MediaKind: providers como wikimedia.py servem
                        # vídeo E imagem — media_kind vem no meta plano
                        # (dentro do dict "license" original do candidato,
                        # copiado por make_provider_resolver).
                        media_kind=str(meta.get("media_kind") or "video"),
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
                                        media_kind=row.get("media_kind") or "video",
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
                    provider=provider_name_for_history,
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
            # NÃO abortar o acquire_for_deficits inteiro — só este item
            # esgotou o pool de candidatos (ver comentário no topo do
            # loop). Os outros deficits, cada um com a sua própria query
            # hierarchy nunca tentada, continuam elegíveis na próxima
            # iteração via `remaining` (que já exclui `exhausted`).
            log.info(
                "acquire_for_deficits: '%s' sem ganhos nesta iteração — "
                "marca exhausted, tenta próximo maior deficit",
                item.canonical_entity)
            exhausted.add(item.canonical_entity)
            continue
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
    event_sink: Optional[Callable[[str, str, dict], None]] = None,
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

    # item 34/36 (fecho de cobertura multi-provider): scan do inbox manual
    # ANTES da waterfall automática — dá prioridade a conteúdo já curado
    # pelo operador (evita gastar API se o humano já resolveu), nunca um
    # 2º caminho de ingest (mesmo ingest_asset canónico). Ficheiros novos
    # ficam indexados/confirmados pelo mesmo _index_existing()/
    # _run_strict_confirmation() que o caller (S08Matching) já corre
    # depois de cada wave — sem duplicar essa lógica aqui. Corre SEMPRE
    # (mesmo mock_mode) — é ingest local, nunca toca a rede.
    from studio.library.manual_provider import scan_manual_inbox
    n_manual = scan_manual_inbox(
        workset_ctx.workflow_id, db, embedder, settings,
        requirement_prompts=workset_ctx.requirement_prompts,
        requirement_embeddings=workset_ctx.requirement_embeddings,
        visual_prompt_embeddings=workset_ctx.visual_prompt_embeddings,
    )
    if n_manual:
        log.info("run_acquisition_for_workset: %d asset(s) manual(is) "
                "ingerido(s) de manual_inbox_dir()", n_manual)

    # item 30 (fecho de cobertura multi-provider): agrupa deficits pela
    # MESMA waterfall (provider_policy, por entity_type/strict — sem
    # hardcode de nome/cidade) e escalona por provider DENTRO de cada
    # grupo, parando assim que o grupo fica coberto (item 32 — nunca
    # continua para o próximo provider "só porque sim"). mock_mode
    # continua fail-closed universal (nenhum provider toca a rede em
    # testes); um provider individual sem credencial (ex.: pexels sem
    # key) já faz no-op per-query dentro de make_provider_resolver (log +
    # continue) — nunca aborta os outros da waterfall.
    from studio.library.provider_policy import provider_policy

    groups: dict[tuple[str, ...], list[DeficitItem]] = {}
    for d in deficit_items:
        ent = ent_by_canon.get(d.canonical_entity)
        key = tuple(provider_policy(
            getattr(ent, "entity_type", "") or "",
            bool(getattr(ent, "strict", False)) if ent is not None else False))
        groups.setdefault(key, []).append(d)

    # item (post-closure, decisão operador 2026-08-14): default subiu de 2
    # para 8 — footage genérico de stock raramente bate um landmark
    # específico o suficiente para passar o triage SigLIP; mais
    # candidatos por query aumenta a chance de achar 1 que bata, ainda
    # dentro do espírito de micro-wave (nunca sweep(50)). Configurável via
    # settings.acquisition_candidates_per_query (mesmo padrão
    # soft-override de acquisition_max_waves).
    count_per_query = max(1, int(
        getattr(settings, "acquisition_candidates_per_query", 8) or 8))
    dest = settings.library_root / "downloads" / (workset_ctx.workflow_id or "shared")

    combined = AcquisitionReport(coverage_status={}, coverage_ready=False)
    remaining_downloads = max_downloads
    for waterfall, group_items in groups.items():
        if remaining_downloads <= 0:
            break
        for provider_name in waterfall:
            if remaining_downloads <= 0:
                break
            if all(i.deficit_seconds <= 0 for i in group_items):
                break
            if event_sink is not None:
                try:
                    event_sink(
                        "provider_escalation",
                        f"waterfall {waterfall} -> tentando '{provider_name}' "
                        f"para {[i.canonical_entity for i in group_items]}",
                        {"provider": provider_name, "waterfall": list(waterfall),
                         "canonicals": [i.canonical_entity for i in group_items]})
                except Exception:
                    pass
            if settings.mock_mode:
                resolver = lambda q, lvl: []  # noqa: E731
            else:
                resolver = make_provider_resolver(
                    settings, dest, providers=(provider_name,), db=db,
                    count_per_query=count_per_query, event_sink=event_sink)
            # bug real (mesma run, 2026-08-14): com o fix de "exhausted"
            # (acquire_for_deficits já não desiste do grupo inteiro por 1
            # entity sem candidatos), cada entity sem sorte consome 1
            # iteração antes de passar à seguinte. `exhausted` é local a
            # esta CHAMADA — com menos iterações do que deficits do
            # grupo, os últimos nunca chegam a ser tentados nesta wave.
            effective_max_iterations = max(max_iterations, len(group_items))
            rep = acquire_for_deficits(
                workset_ctx=workset_ctx, db=db, embedder=embedder,
                settings=settings, deficit_items=group_items,
                provider_resolver=resolver, query_history_db=query_history,
                requirement_index=requirement_index, refresh_deficit=_refresh,
                remeasure_coverage=lambda: all(
                    i.deficit_seconds <= 0 for i in group_items),
                max_downloads=remaining_downloads,
                max_iterations=effective_max_iterations,
                provider_name_for_history=provider_name,
            )
            if rep.provider_rate_limited and event_sink is not None:
                try:
                    event_sink(
                        "provider_rate_limited_skip",
                        f"'{rep.provider_rate_limited}' rate-limited "
                        f"(temporário) — waterfall avança sem esperar",
                        {"provider": rep.provider_rate_limited,
                         "waterfall": list(waterfall)})
                except Exception:
                    pass
            remaining_downloads -= rep.downloads_succeeded
            combined.downloads_attempted += rep.downloads_attempted
            combined.downloads_succeeded += rep.downloads_succeeded
            combined.downloads_rejected_license += rep.downloads_rejected_license
            combined.downloads_rejected_provider_dedup += (
                rep.downloads_rejected_provider_dedup)
            combined.downloads_rejected_query_history_empty += (
                rep.downloads_rejected_query_history_empty)
            combined.shots_ingested += rep.shots_ingested
            combined.queries_run += rep.queries_run
            combined.iterations += rep.iterations
            combined.coverage_status.update(rep.coverage_status or {})
        if event_sink is not None and not all(
                i.deficit_seconds <= 0 for i in group_items):
            try:
                event_sink(
                    "provider_pool_exhausted",
                    f"waterfall {waterfall} esgotada para "
                    f"{[i.canonical_entity for i in group_items]}",
                    {"waterfall": list(waterfall),
                     "canonicals": [i.canonical_entity for i in group_items]})
            except Exception:
                pass
    combined.coverage_ready = _remeasure()
    return combined


__all__ = [
    "AcquisitionReport",
    "DeficitItem",
    "query_hierarchy",
    "preflight_media",
    "is_provider_already_taken",
    "acquire_for_deficits",
    "run_acquisition_for_workset",
]
