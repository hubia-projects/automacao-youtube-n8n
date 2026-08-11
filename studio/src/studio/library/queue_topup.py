"""Pass 5 — Producer/Consumer queue entre downloads Pexels e ingest pipeline.

Substitui o loop sequencial de `topup_for_plan()` em modo real (não-mock)
por:
- **Coordinator** (main thread): dedupe queries + enfileira `TopupJob`s.
- **N download workers** (`settings.topup_dl_workers=2`): correm `sweep()`
  em paralelo. I/O bound (rede) → threading funciona (GIL libertado em I/O).
- **QUEUE bounded** (`settings.topup_queue_max=32`): backpressure automática.
  Downloaders pausam quando ingest worker lento.
- **1 ingest worker** (`settings.topup_ingest_workers=1` FORÇADO por
  determinismo LanceDB): corre `preflight` + `ingest_file`. Single-writer
  da LanceDB mantém ordem canónica de inserção.

Determinismo + concorrência controlada:
- `seen_queries` set é populado SÓ pelo Coordinator no main thread
  (sem race — downloaders não tocam).
- `state.total_cost` é incrementado SÓ pelo ingest worker (single-writer
  via cost_lock; race evitada pela própria arquitetura).
- `threading.Event(budget_exceeded)`: ingest worker dispara quando
  cost >= budget; downloaders verificam ANTES de cada network call
  (graceful degradation, não abrupt kill).
- Sentinel `None`: marca fim de jobs — cada worker verifica e sai.

Mock mode (settings.mock_mode=True) BYPASSA a queue e usa o
`topup_for_plan()` sequencial legado (mesmo comportamento pré-Pass 5).
DOC: ARCHITECTURE §1.7.5 + FASE 2 Optimização Studio §5.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from queue import Queue
from typing import Optional

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.library.early_reject import preflight as preflight_check
from studio.library.embed import Embedder
# P3 (2026-08-11): queue_topup migrado de ingest_file → ingest_asset.
# import lazy dentro-de-função para preservar arranque do módulo com
# `python -m` sem venv activo; canonical wrapper passa a ser ingest_asset.
# import ingest_asset é lazy no call site para acelerar arranque.
from studio.library.sources.pexels import sweep
from studio.library.topup import (
    TopupPerEntity,
    TopupReport,
    micro_batch_count,
    topup_for_plan as _legacy_topup_for_plan,
)
from studio.matching.coverage_plan import (
    CoveragePlan,
    build_query_hierarchy,
    measure_coverage,
)
from studio.perf import Profiler

log = logging.getLogger("studio.queue_topup")


# ---------------------------------------------------------------------------
# Tipos partilhados (jobs + assets) — ordem preservada via `index`
# ---------------------------------------------------------------------------
@dataclass
class TopupJob:
    """Unit of work para download workers. `index` = monotonic insertion
    order (por entity, ronda); preservado em `DownloadedAsset.index` para
    que ingest worker escreva em LanceDB em ordem canónica.

    Equity entre downloaders é FIFO da `job_queue` — coordinator enfileira
    por ordem de entity/ronda. Dentro da mesma entity/ronda, downloads
    podem completar fora de ordem, mas a fila por-DOWNLOADER preserva
    ordem intra-job (Pexels sweep usa ThreadPoolExecutor interno, ordem
    preservada por executor.map).
    """
    entity: str
    entity_type: str
    query: str
    dest: Path
    count: int
    round_idx: int
    entity_idx: int   # monotonic por entity (0..N_entities-1)
    strict: bool = False


@dataclass
class DownloadedAsset:
    """Unit of work para ingest worker. Preserva metadata do job mãe."""
    path: Path
    license: dict
    entity: str
    entity_idx: int
    round_idx: int
    query: str


# Sentinel value para shutdown gracioso dos workers (qualquer coisa que
# não seja TopupJob|DownloadedAsset funciona; usamos um object token).
_SHUTDOWN = "__shutdown__"


def _is_shutdown(token: object) -> bool:
    return token is _SHUTDOWN


# ---------------------------------------------------------------------------
# Estado partilhado (single-writer onde possível)
# ---------------------------------------------------------------------------
class _SharedState:
    """Estado partilhado entre workers. Decisões sobre single-writer:

    - `seen_queries`: SÓ Coordinator escreve (main thread; sem lock
      porque o set é "owned" por main). Workers verificam já-populated.
    - `budget/budget_exceeded`: Coordinator inicializa; ingest worker
      WRITE `set()` quando cost >= budget; downloaders READ via
      `Event.is_set()` (lock-free, thread-safe).
    - `total_cost`: SÓ ingest worker escreve (cost_lock protege
      check-then-act entre múltiplas ingest runs simultâneas — safety
      defensiva embora só exista 1 ingest worker).
    - `error_event`: qualquer worker pode `set()`; Coordinator verifica.
    """

    def __init__(self, budget: float):
        self.budget = budget
        self.total_cost = 0.0
        self.cost_lock = threading.Lock()
        self.seen_queries: set[str] = set()
        self.seen_lock = threading.Lock()     # Coordinator só — defensivo
        self.budget_exceeded = threading.Event()
        self.error_event = threading.Event()
        self.ingested_count = 0
        self.rejected_preflight = 0
        self.ingest_failures = 0
        self.sweep_failures = 0


# ---------------------------------------------------------------------------
# Worker functions
# ---------------------------------------------------------------------------
def _worker_download(
    worker_id: int,
    job_queue: "Queue",
    asset_queue: "Queue",
    state: _SharedState,
    settings: Settings,
) -> None:
    """Consumer: pega `TopupJob`, corre `sweep()`, enfileira `DownloadedAsset`."""
    log.debug("worker[dl-%d]: start", worker_id)
    while True:
        token = job_queue.get()
        try:
            if _is_shutdown(token):
                log.debug("worker[dl-%d]: shutdown ok (jobs=%d ingested_seen=%d)",
                          worker_id, state.ingested_count, state.ingest_failures)
                break
            if state.error_event.is_set():
                break
            if state.budget_exceeded.is_set():
                log.debug("worker[dl-%d]: budget exceeded — exit early", worker_id)
                break
            job: TopupJob = token  # type: ignore[assignment]
            log.info("coverage: %s dl-%d start '%s' (count=%d)",
                     job.entity, worker_id, job.query, job.count)
            t0 = time.perf_counter()
            try:
                downloaded = sweep(job.query, count=job.count,
                                   settings=settings, dest=job.dest)
            except Exception as exc:
                state.sweep_failures += 1
                log.warning("worker[dl-%d]: sweep '%s' falhou: %s",
                            worker_id, job.query, exc.__class__.__name__)
                continue
            Profiler.record("pexels_search", time.perf_counter() - t0,
                            items=len(downloaded))
            for path, lic in downloaded:
                if not path.exists():
                    continue
                asset_queue.put(DownloadedAsset(
                    path=path, license=lic or {},
                    entity=job.entity,
                    entity_idx=job.entity_idx,
                    round_idx=job.round_idx,
                    query=job.query,
                ))
        finally:
            job_queue.task_done()


def _worker_ingest(
    asset_queue: "Queue",
    state: _SharedState,
    db: LibraryDB,
    settings: Settings,
    embedder: Embedder,
    report: TopupReport,
    per_entity_map: dict[str, TopupPerEntity],
) -> None:
    """Consumer: pega `DownloadedAsset`, corre `preflight`+`ingest_file`.

    Single-writer do `state.total_cost` e do `TopupReport` (definido na
    config como ingest_workers=1, enforced). Isto garante queries em
    LanceDB deterministas via inserção sequencial.
    """
    log.debug("worker[ingest]: start")
    while True:
        # NIT-1 (correctness, code-reviewer Pass 5): sai do loop IMEDIATO
        # quando budget já foi excedido. Sem isto, com 32 items pendentes
        # na queue, o worker consumia-os todos com preflight+ingest
        # no-op até o Coordinator enviar _SHUTDOWN. CPU spin sem
        # progresso útil.
        if state.budget_exceeded.is_set():
            log.debug("worker[ingest]: budget_exceeded set — drain sem trabalho")
            break
        token = asset_queue.get()
        try:
            if _is_shutdown(token):
                log.debug("worker[ingest]: shutdown ok (ingested=%d, "
                          "preflight_reject=%d, ingest_fail=%d)",
                          state.ingested_count, state.rejected_preflight,
                          state.ingest_failures)
                break
            asset: DownloadedAsset = token  # type: ignore[assignment]
            if state.error_event.is_set():
                continue
            # Budget check (single-writer evita race; lock é defensive)
            with state.cost_lock:
                if state.total_cost >= state.budget:
                    state.budget_exceeded.set()
                    log.warning("worker[ingest]: budget $%.4f atingido — skip",
                                state.total_cost)
                    continue
            # Preflight (Pass 2) ANTES de ingest_file — fail-fast em ficheiros
            # sub-2s/sub-720p/heuristic watermarks.
            try:
                rej = preflight_check(asset.path, settings)
            except Exception as exc:
                log.warning("worker[ingest]: preflight '%s' exception (%s) — "
                            "deixa ingest tentar",
                            asset.path.name, exc.__class__.__name__)
                rej = None
            if rej is not None:
                state.rejected_preflight += 1
                try:
                    db.cache_mark_rejected(
                        "pexels",
                        (asset.license.get("source_url", "") if asset.license
                         else "") or "",
                        str(rej),
                    )
                except Exception as exc:
                    log.debug("cache_mark_rejected falhou (nao fatal): %s",
                              exc.__class__.__name__)
                if asset.entity in per_entity_map:
                    per_entity_map[asset.entity].notes.append(
                        f"preflight reject: {asset.path.name} ({rej.code})"
                    )
                log.info("worker[ingest]: preflight reject: %s (%s)",
                         asset.path.name, rej.code)
                continue
            try:
                # P3 (2026-08-11): ingest_asset canónico.
                from studio.library.ingest_asset import ingest_asset
                r, _asset_state = ingest_asset(
                    asset.path, asset.license, db, settings, embedder,
                    source_id=getattr(asset, "source_id", None),
                    video_id=getattr(asset, "video_id", None),
                )
            except Exception as exc:
                state.ingest_failures += 1
                log.warning("worker[ingest]: ingest '%s' falhou: %s",
                            asset.path.name, exc.__class__.__name__)
                if asset.entity in per_entity_map:
                    per_entity_map[asset.entity].notes.append(
                        f"ingest failed: {asset.path.name}"
                    )
                continue
            if r.status == "ingested":
                with state.cost_lock:
                    state.total_cost += r.cost_usd
                    state.ingested_count += r.shots_added
                pe = per_entity_map.get(asset.entity)
                if pe is not None:
                    pe.shots_added += r.shots_added
                    pe.cost_usd += r.cost_usd
                report.total_cost_usd = round(state.total_cost, 4)
                if state.total_cost >= state.budget:
                    state.budget_exceeded.set()
                log.info("worker[ingest]: %s ingested (shots=%d cost=$%.4f)",
                         asset.path.name, r.shots_added, r.cost_usd)
        finally:
            asset_queue.task_done()


# ---------------------------------------------------------------------------
# Coordinator (main thread)
# ---------------------------------------------------------------------------
def topup_for_plan_concurrent(
    plan: CoveragePlan,
    db: LibraryDB,
    settings: Settings,
    embedder: Embedder,
    *,
    max_rounds: int = 2,
    cost_budget_usd: Optional[float] = None,
    run_id: Optional[str] = None,
) -> TopupReport:
    """Queue-based concurrent top-up — substituto directo de
    `topup_for_plan()` em modo real (não-mock).

    Mesma assinatura e mesmo `TopupReport` — back-compat drop-in. S08
    decide se chama este ou o sequencial via mock_mode.

    Lifecycle:
      1. Pre-computar per_entity_map (só entities com deficit>0).
      2. Spawn N downloaders + 1 ingest worker.
      3. Coordinator enfileira TopupJobs (dedupe em main thread,
         cache_get check, micro_batch_count).
      4. Coordinator envia N shutdown tokens aos downloaders
         (1 por worker).
      5. asset_queue.join() espera ingest drenar a queue
         (download jobs já terminados não perdem em mid-air).
      6. asset_queue recebe 1 shutdown token (ingest worker exit).
      7. Re-measure coverage (post-ingest) + marca satisfied/unsatisfied.

    Failure modes:
      - SIGTERM: threads daemonized, Coordinator termina → SIGKILL do
        processo. Para shutdown graceful, basta receber SIGINT (adicionar
        signal_handler se necessário; out-of-scope Pass 5).
      - Sweep exception: worker continue (log warning). Não crasha
        Coordinator.
      - Ingest exception: log warning + asset descartado (não reentrega).
      - Budget exceeded: ingest worker sinaliza; downloaders verificam
        antes de cada sweep e param early.
    """
    report = TopupReport()

    if settings.mock_mode or not settings.pexels_api_key:
        # Pass 5: mock_mode BYPASSA a queue (tests determinísticos sem rede).
        # `not pexels_api_key` também cai aqui (back-compat topup.py).
        # Module-level import (aliasado `_legacy_topup_for_plan`) permite
        # tests fazer monkeypatch via setattr directamente em
        # `queue_topup._legacy_topup_for_plan` (sem late-import fragility).
        return _legacy_topup_for_plan(plan, db, settings, embedder,
                                      max_rounds=max_rounds,
                                      cost_budget_usd=cost_budget_usd,
                                      run_id=run_id)

    budget = cost_budget_usd if cost_budget_usd is not None \
        else settings.budget_usd_per_run
    state = _SharedState(budget)

    # job_queue between Coordinator → downloaders: unbounded (Coordinator
    # enfileira rápido; download é lento, mas backpressure vem da asset_queue).
    job_queue: Queue = Queue(maxsize=max(8, settings.topup_dl_workers * 4))
    # asset_queue between downloaders → ingest worker: bounded por
    # `settings.topup_queue_max` para backpressure (downloaders pausam se
    # ingest trava).
    asset_queue: Queue = Queue(maxsize=settings.topup_queue_max)

    # Pre-computar per_entity_map (ingest single-writer mutates este map;
    # Coordinator SÓ lê).
    per_entity_map: dict[str, TopupPerEntity] = {}
    for ent in plan.ranked_entities:
        if ent.deficit_seconds <= 0:
            report.satisfied_count += 1
            log.info("coverage: %s deficit=0 -- skip (satisfied total=%d)",
                     ent.canonical_name, report.satisfied_count)
            continue
        pe = TopupPerEntity(
            entity=ent.canonical_name,
            entity_type=ent.entity_type,
            deficit_before=ent.deficit_seconds,
            deficit_after=ent.deficit_seconds,
        )
        per_entity_map[ent.canonical_name] = pe
        report.per_entity.append(pe)

    if not per_entity_map:
        return report  # nada a fazer → 0 sweeps

    # Spawn workers
    dl_workers = max(1, int(settings.topup_dl_workers))
    ingest_workers = 1   # ENFORCED por Settings.topup_ingest_workers=1

    downloaders: list[threading.Thread] = []
    for w_id in range(dl_workers):
        t = threading.Thread(
            target=_worker_download,
            args=(w_id, job_queue, asset_queue, state, settings),
            name=f"topup-dl-{w_id}",
            daemon=True,
        )
        t.start()
        downloaders.append(t)

    ingesters: list[threading.Thread] = []
    for w_id in range(ingest_workers):
        t = threading.Thread(
            target=_worker_ingest,
            args=(asset_queue, state, db, settings, embedder, report,
                  per_entity_map),
            name=f"topup-in-{w_id}",
            daemon=True,
        )
        t.start()
        ingesters.append(t)

    # Coordinator (main thread) — enfileira jobs com dedupe + cache check.
    run_subdir = run_id or "shared"
    n_jobs = 0
    try:
        for entity_idx, ent in enumerate(plan.ranked_entities):
            if ent.canonical_name not in per_entity_map:
                continue  # skip satisfeitos
            ent_obj = ent
            pe = per_entity_map[ent_obj.canonical_name]
            levels = (settings.query_levels - 1) if ent_obj.strict \
                else settings.query_levels
            queries = build_query_hierarchy(
                ent_obj.canonical_name,
                location=ent_obj.location or "",
                entity_type=ent_obj.entity_type,
                features=[],
                levels=levels,
            )
            for rnd in range(1, max_rounds + 1):
                if state.error_event.is_set() or state.budget_exceeded.is_set():
                    break
                # Choose query (dedupe em main thread; Coordinator é
                # single-owner de seen_queries).
                q: Optional[str] = None
                with state.seen_lock:
                    for cand in queries:
                        if cand.lower() in state.seen_queries:
                            continue
                        # Cache_get check (Pass 3): skip se cached-rejected.
                        try:
                            cached = db.cache_get("pexels", cand.lower())
                        except Exception as exc:
                            log.debug("cache_get falhou (skip): %s",
                                      exc.__class__.__name__)
                            cached = None
                        if cached and cached.get("status") == "rejected":
                            state.seen_queries.add(cand.lower())
                            pe.notes.append(f"round={rnd}: skipped cached-rejected '{cand}'")
                            log.info("topup: skip cached-rejected query '%s'", cand)
                            continue
                        q = cand
                        state.seen_queries.add(q.lower())
                        break
                if q is None:
                    pe.notes.append(f"round={rnd}: all queries cached-rejected "
                                    f"or already tried")
                    break
                count = micro_batch_count(
                    pe.deficit_after,
                    getattr(settings, "topup_asset_useful_s_default", 5.0),
                )
                if count == 0:
                    pe.notes.append(f"round={rnd}: deficit=0 -> stop")
                    log.info("coverage: %s round=%d deficit=0 -> stop",
                             ent_obj.canonical_name, rnd)
                    break
                dest = (settings.library_root / "downloads"
                        / run_subdir
                        / ent_obj.canonical_name.replace(" ", "_"))
                job = TopupJob(
                    entity=ent_obj.canonical_name,
                    entity_type=ent_obj.entity_type,
                    query=q,
                    dest=dest,
                    count=count,
                    round_idx=rnd,
                    entity_idx=entity_idx,
                    strict=ent_obj.strict,
                )
                job_queue.put(job)
                n_jobs += 1
                report.total_rounds += 1
                pe.rounds += 1
                pe.queries_used.append(q)
                log.info("coverage: %s round=%d enqueued '%s' (count=%d)",
                         ent_obj.canonical_name, rnd, q, count)
    finally:
        # Send N shutdown tokens para downloaders (1 por worker).
        for _ in range(dl_workers):
            job_queue.put(_SHUTDOWN)
        # Espera cada downloader drainer (job_queue.join() espera todos
        # task_done counts atingidos).
        job_queue.join()
        # Send 1 shutdown token para ingest worker (já drena items
        # órfãos na asset_queue via loop interno antes de checar sentinel).
        asset_queue.put(_SHUTDOWN)
        asset_queue.join()
        # Join workers (max 5 min cada; daemon=True cobre caso de timeout).
        for t in downloaders:
            t.join(timeout=300)
        for t in ingesters:
            t.join(timeout=300)

        # Re-measure coverage post-ingest (recalcula deficit_seconds pelos
        # shots adicionados em cada round).
        for ent in plan.ranked_entities:
            if ent.canonical_name in per_entity_map:
                measure_coverage(ent, db)
                ent.deficit_seconds = round(
                    max(0.0, ent.target_seconds - ent.available_seconds), 3)
                pe = per_entity_map[ent.canonical_name]
                pe.deficit_after = ent.deficit_seconds
                pe.satisfied = pe.deficit_after <= 0

        report.total_cost_usd = round(state.total_cost, 4)
        if state.budget_exceeded.is_set():
            report.skipped_due_to_budget = True
        log.info("topup_concurrent: jobs=%d ingested=%d preflight_reject=%d "
                 "sweep_fail=%d ingest_fail=%d rounds=%d cost=$%.4f "
                 "budget_stop=%s",
                 n_jobs, state.ingested_count, state.rejected_preflight,
                 state.sweep_failures, state.ingest_failures,
                 report.total_rounds, state.total_cost,
                 report.skipped_due_to_budget)
        return report
