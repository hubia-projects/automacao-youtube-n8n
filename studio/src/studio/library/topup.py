"""Top-up inteligente baseado em deficit — Fase D do Sprint Optimização.

Lê `CoveragePlan` (Fase C) e, para cada entity com `deficit_seconds > 0`,
busca footage dirigida pelas queries hierárquicas (N1 → N2 → N3 → N4)
em ordem decrescente de prioridade. Buying strategy:

1. Itera `plan.ranked_entities` por priority decrescente.
2. Para cada entity deficitária:
     * até `max_rounds` (=2) rondas de busca+ingest+remeasure
     * dedupe de queries URIs cross-entity (5 cenas Lello → 1 busca Pexels)
     * dedupe de media_sha cross-entity (cross-library dedupe nativo)
     * STOP quando deficit <= 0 OU cost + c > budget_remaining
3. Re-mede cobertura APÓS cada ingestion round para decidir se continua.
4. Logs estruturados:
     coverage: Francesinha round=1 before=12s after=43s satisfied
5. Idempotência: re-chamar produz zero extra (media_exists_denied).
6. Mock mode: topup_for_plan retorna TopupReport vazio (smoke test sem rede).

DOC: ARCHITECTURE §1.7.4.
"""

from __future__ import annotations

import json
import logging
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.library.embed import Embedder
from studio.library.early_reject import preflight as preflight_check
from studio.perf import Profiler
from studio.matching.coverage_plan import (
    CoveragePlan,
    EntityCoverage,
    build_query_hierarchy,
    measure_coverage,
)

log = logging.getLogger("studio.topup")


# --------- modelo de saída ---------
@dataclass
class TopupPerEntity:
    entity: str
    entity_type: str
    deficit_before: float
    deficit_after: float
    rounds: int = 0
    queries_used: list[str] = field(default_factory=list)
    shots_added: int = 0
    cost_usd: float = 0.0
    satisfied: bool = False
    notes: list[str] = field(default_factory=list)


@dataclass
class TopupReport:
    per_entity: list[TopupPerEntity] = field(default_factory=list)
    total_rounds: int = 0
    total_cost_usd: float = 0.0
    skipped_due_to_budget: bool = False
    skipped_due_to_mock: bool = False
    # Pass 3 close-out (3a via): counter de entities ja saturadas antes
    # do top-up (deficit_seconds <= 0 na entrada). Mantem contract
    # "per_entity = so entities que precisaram accao" e ao mesmo tempo
    # expone observability via metadata (evita poluir payload).
    satisfied_count: int = 0

    def aggregate_dict(self) -> dict:
        return {
            "per_entity": [
                {"entity": p.entity,
                 "entity_type": p.entity_type,
                 "deficit_before": p.deficit_before,
                 "deficit_after": p.deficit_after,
                 "rounds": p.rounds,
                 "shots_added": p.shots_added,
                 "queries_used": p.queries_used,
                 "satisfied": p.satisfied,
                 "cost_usd": p.cost_usd,
                 "notes": p.notes}
                for p in self.per_entity
            ],
            "total_rounds": self.total_rounds,
            "total_cost_usd": round(self.total_cost_usd, 4),
            "skipped_due_to_budget": self.skipped_due_to_budget,
            "skipped_due_to_mock": self.skipped_due_to_mock,
            # Pass 3 observability via metadata (NAO polui per_entity).
            "satisfied_count": self.satisfied_count,
        }


# --------- micro-batch helper (Pass 2) ---------
def micro_batch_count(deficit_seconds: float, useful_per_asset_s: float,
                      hard_max: int = 5) -> int:
    """Tamanho do micro-batch dimensionado pelo deficit.

    Formula: clamp(ceil(deficit / useful_per_asset), 1, hard_max).
    Quando deficit <= 0 devolve 0 (caller deve early-return sem pedir nada).

    Defaults calibrados com vídeos 8 min produzidos 2026-07: cada asset
    Pexels cobre em media ~5s no timeline apos demais cenas cobertas.
    """
    if deficit_seconds <= 0:
        return 0  # deficit zero -> NAO pedir nada
    if useful_per_asset_s <= 0:
        return hard_max  # defensivo (evitar divisao por 0)
    return max(1, min(hard_max, math.ceil(deficit_seconds / useful_per_asset_s)))


# --------- função principal ---------
def topup_for_plan(
    plan: CoveragePlan,
    db: LibraryDB,
    settings: Settings,
    embedder: Embedder,
    *,
    max_rounds: int = 2,
    cost_budget_usd: float | None = None,
    run_id: str | None = None,
) -> TopupReport:
    """Top-up inteligente baseado em deficit.

    Args:
        run_id: (Fase D fix) usado para scoping do diretório de downloads
            — evita colisão cross-runs paralelos sobre a mesma entity.
            Default None usa 'shared' subdir (legado).
    """
    """Itera ranked_entities (priority desc) e, para cada deficit, faz até
    `max_rounds` rondas de Pexels-sweep → ingest → remeasure.

    Args:
        plan: CoveragePlan da Fase C.
        db: LibraryDB para scan + ingest.
        settings: Settings (mock_mode, pexels keys, library_root).
        embedder: SiglipEmbedder para ingest (não usado em mock_mode).
        max_rounds: limite de iterações por entity (default 2 — bias para
            não esticar timings em séries longas).
        cost_budget_usd: limite global; None = settings.budget_usd_per_run.
    """
    report = TopupReport()
    if settings.mock_mode:
        report.skipped_due_to_mock = True
        log.info("topup: mock_mode=True — relatório vazio (sem rede/GPU)")
        # Mesmo assim preenchemos per_entity com diagnóstico (deficit_before
        # + deficit_after após re-measure) sem I/O — útil para diagnóstico.
        for ent in plan.ranked_entities:
            if ent.deficit_seconds <= 0:
                continue
            measure_coverage(ent, db)
            report.per_entity.append(TopupPerEntity(
                entity=ent.canonical_name,
                entity_type=ent.entity_type,
                deficit_before=ent.deficit_seconds,
                deficit_after=ent.deficit_seconds,
                shots_added=0,
                satisfied=False,
                notes=["mock_mode sem rede — top-up não executou"],
            ))
        return report

    if not settings.pexels_api_key:
        log.info("topup: pexels_api_key ausente — pula")
        return report

    budget = cost_budget_usd if cost_budget_usd is not None \
        else settings.budget_usd_per_run
    # P3 (2026-08-11): migrate topup de ingest_file → ingest_asset.
    # ingest_asset é o ÚNICO caminho de ingest canónico com state machine,
    # DB verify (P6), e empty_media defence (A1). ingest_file deixa de ser
    # exposto a callers production (whitelist reduzido a ingest.py para
    # definição e ingest_asset.py para o wrapper canonical).
    from studio.library.ingest_asset import ingest_asset
    from studio.library.sources.pexels import sweep

    # Dedupe cross-entity de queries (priority desc loop).
    # Mesmo nome já explora; N avançadas e aliases também.
    seen_queries: set[str] = set()

    for ent in plan.ranked_entities:
        if ent.deficit_seconds <= 0:
            # Pass 3 close-out (3a via): manter contract "per_entity = so
            # entities que precisaram de accao" (test_topup.py invariantes
            # TestTopupEarlyReturn + TestTopupNoDeficit). Observability
            # exposta via counter TopupReport.satisfied_count + log
            # estruturado (sem poluir payload de per_entity).
            report.satisfied_count += 1
            log.info(
                "coverage: %s deficit=0 -- skip search (ja saturado; total_satisfied=%d)",
                ent.canonical_name, report.satisfied_count,
            )
            continue
        if report.total_cost_usd >= budget:
            report.skipped_due_to_budget = True
            log.info("topup: budget $%.2f atingido — parando antes de '%s'",
                     report.total_cost_usd, ent.canonical_name)
            break

        per = TopupPerEntity(
            entity=ent.canonical_name,
            entity_type=ent.entity_type,
            deficit_before=ent.deficit_seconds,
            deficit_after=ent.deficit_seconds,
        )
        # Phase D queries: re-construir com tipo correto + entity name,
        # até settings.query_levels, com strict skipping último nível.
        levels = (settings.query_levels - 1) if ent.strict \
            else settings.query_levels
        # Fase D fix-2: usa location persistida no plano (não hardcoded "")
        # para construir N2 (entity+location) das query hierarchy.
        candidate_queries = build_query_hierarchy(
            ent.canonical_name,
            location=ent.location,
            entity_type=ent.entity_type,
            features=[],
            levels=levels,
        )

        for rnd in range(1, max_rounds + 1):
            if per.deficit_after <= 0:
                break
            if report.total_cost_usd >= budget:
                report.skipped_due_to_budget = True
                break
            available_q = []
            for q in candidate_queries:
                if q.lower() in seen_queries:
                    continue
                # Pass 3: provider cache wired — skip queries já cached-
                # rejected (TTL via Settings.negative_cache_ttl_days).
                try:
                    cached = db.cache_get("pexels", q.lower())
                except Exception as exc:
                    log.debug("topup: cache_get falhou (skip): %s", exc)
                    cached = None
                if cached and cached.get("status") == "rejected":
                    per.notes.append(
                        f"round={rnd}: skip cached-rejected query '{q}'"
                    )
                    log.info("topup: skip cached-rejected query '%s'", q)
                    seen_queries.add(q.lower())  # no retry
                    continue
                available_q.append(q)
            if not available_q:
                per.notes.append(
                    f"round={rnd}: todas as queries já tentadas ou cached-rejected"
                )
                break
            q = available_q[0]
            seen_queries.add(q.lower())
            per.queries_used.append(q)

            log.info("coverage: %s round=%d deficit=%.1fs search=%s",
                     ent.canonical_name, rnd, per.deficit_after, q)
            # FIX 1 (code-reviewer): dest inclui run_id para evitar colisão
            # cross-runs sobre mesma entity.
            run_subdir = run_id or "shared"
            dest = (settings.library_root / "downloads"
                    / run_subdir / ent.canonical_name.replace(" ", "_"))
            # Pass 2: micro-batch dimensionado pelo deficit (evita pedir
            # 5 quando deficit=10s).
            count = micro_batch_count(
                per.deficit_after,
                getattr(settings, "topup_asset_useful_s_default", 5.0),
            )
            if count == 0:
                per.notes.append(f"round={rnd}: deficit=0 -> skip search")
                log.info("coverage: %s round=%d deficit=0 -> stop",
                         ent.canonical_name, rnd)
                break
            t0_search = time.perf_counter()
            try:
                downloaded = sweep(q, count=count, settings=settings, dest=dest)
            except Exception as exc:
                per.notes.append(
                    f"round={rnd} sweep falhou: {exc.__class__.__name__}")
                log.warning("topup sweep '%s' falhou: %s", q, exc)
                continue
            else:
                # `else` corre SÓ em sucesso do try (não no except); items
                # = nº de vídeos devolvidos pelo provider para esta query.
                Profiler.record(
                    "pexels_search",
                    time.perf_counter() - t0_search,
                    items=len(downloaded) if isinstance(downloaded, list) else 0,
                )

            round_added = 0
            round_cost = 0.0
            for path, lic in downloaded:
                if not path.exists():
                    continue
                # Pass 2: early rejection ANTES de ingest_file. ffprobe
                # (~0.1s) vs SceneDetect+SigLIP+Vision (~30s+). Reject e
                # gravado em provider_cache (negative cache wired em Pass 3
                # tera este read-side automtico).
                try:
                    reject = preflight_check(path, settings)
                except Exception as exc:
                    log.warning("topup preflight falhou para %s: %s",
                                path.name, exc.__class__.__name__)
                    reject = None  # fail-soft: deixa ingest tentar
                if reject is not None:
                    try:
                        db.cache_mark_rejected(
                            "pexels",
                            (lic.get("source_url") if lic else "") or "",
                            str(reject),
                        )
                    except Exception as exc:
                        log.warning("cache_mark_rejected falhou: %s", exc)
                    per.notes.append(f"round={rnd} preflight reject: {reject.code}")
                    log.info("topup: %s preflight reject (%s) - skip ingest",
                             path.name, reject.code)
                    continue
                try:
                    # P3 (2026-08-11): ingest_asset devolve (IngestResult,
                    # AssetStateRecord). topup só precisa dos campos do
                    # IngestResult (status, shots_added, cost_usd).
                    src_url = ((lic or {}).get("source_url", "")
                               if isinstance(lic, dict)
                               else getattr(lic, "source_url", "")
                               or path.name)
                    r, _asset_state = ingest_asset(
                        path, lic, db, settings, embedder,
                        source_id=src_url,
                        video_id=run_id,
                    )
                except Exception as exc:
                    per.notes.append(
                        f"round={rnd} ingest falhou: {exc.__class__.__name__}")
                    log.warning("topup ingest '%s' falhou: %s",
                                path.name, exc)
                    continue
                if r.status == "ingested":
                    round_added += r.shots_added
                    round_cost += r.cost_usd

            # remeasure após ingestion
            measure_coverage(ent, db)
            ent.deficit_seconds = round(
                max(0.0, ent.target_seconds - ent.available_seconds), 3)
            per.deficit_after = ent.deficit_seconds
            per.shots_added += round_added
            per.cost_usd += round_cost
            per.rounds = rnd
            report.total_cost_usd += round_cost
            report.total_rounds += 1
            log.info("coverage: %s round=%d added=%d before=%.1fs "
                     "after=%.1fs", ent.canonical_name, rnd, round_added,
                     per.deficit_before, per.deficit_after)

        per.satisfied = per.deficit_after <= 0
        if not per.satisfied and not per.notes:
            per.notes.append("deficit persistente após max_rounds")
        report.per_entity.append(per)

    return report


def write_topup_log(report: TopupReport, out_path: Path) -> Path:
    out_path.write_text(
        json.dumps(report.aggregate_dict(), ensure_ascii=False, indent=2),
        "utf-8",
    )
    return out_path
