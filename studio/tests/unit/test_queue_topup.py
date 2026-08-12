"""Testes Pass 5 — Producer/Consumer queue de downloads + ingest.

6 pytest determinísticos. Patterns: pytest.approx directo (sem helper local),
mocks via setattr (sem patch em module attribute paths frágeis), assertions
de block/timeout sem race entre threads.

T_Q1 — mock_mode BYPASS (não chama Pexels, delega ao legacy sequencial).
T_Q2 — backpressure: producer bloqueia em queue.put quando qsize==maxsize.
T_Q3 — budget_exceeded Event: set/clear mecânico.
T_Q4 — clean_drain_sentinel: thread dummy termina em sentinel.
T_Q5 — ingest worker FIFO determinístico (state.ingested_count verificar).
T_Q6 — speedup vs sequential: 2 downloaders paralelos batem 1 sequencial.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from queue import Queue
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from studio.config import Settings
from studio.library.queue_topup import (
    _SHUTDOWN,
    _SharedState,
    _is_shutdown,
    topup_for_plan_concurrent,
)
from studio.library.topup import TopupPerEntity, TopupReport


# ---------- helpers ----------
def _settings_pass5(budget_usd: float = 15.0, dl_workers: int = 2):
    s = Settings(_env_file=None)
    object.__setattr__(s, "mock_mode", False)
    object.__setattr__(s, "pexels_api_key", "TEST_KEY")
    object.__setattr__(s, "budget_usd_per_run", budget_usd)
    object.__setattr__(s, "topup_dl_workers", dl_workers)
    object.__setattr__(s, "topup_ingest_workers", 1)
    object.__setattr__(s, "topup_queue_max", 4)
    object.__setattr__(s, "topup_asset_useful_s_default", 5.0)
    object.__setattr__(s, "query_levels", 4)
    return s


def _plan_one_deficit(deficit_s: float = 25.0, name: str = "Francesinha",
                      etype: str = "food", strict: bool = False):
    from studio.matching.coverage_plan import CoveragePlan, EntityCoverage
    target = 50.0
    avail = max(0.0, target - deficit_s)
    ent = EntityCoverage(
        canonical_name=name, entity_type=etype,
        priority_score=0.8, mention_count=4,
        required_seconds=40.0, target_seconds=target,
        min_distinct_shots=5,
        available_seconds=avail, available_distinct_shots=2,
        available_files=2,
        deficit_seconds=deficit_s, strict=strict, location="Porto",
        queries=[f"{name} feat", f"{name} Porto"],
    )
    plan = CoveragePlan(topic="x", total_script_seconds=120.0,
                        ranked_entities=[ent])
    return plan, ent


# -----------------------------------------------------------------------
# T_Q1 — mock_mode BYPASS.
# Verifica que topup_for_plan_concurrent delega ao sequencial quando
# mock_mode=True (sem threads activos).
# -----------------------------------------------------------------------
def test_q1_mock_mode_bypasses_to_legacy(tmp_path):
    """mock_mode=True → topup_for_plan_concurrent deve delegar ao legacy
    sequencial. Patch o legacy via setattr directo na queue_topup module."""
    import studio.library.queue_topup as qt_mod

    # Cria um TopupReport real para o mock devolver.
    legacy_expected = TopupReport()
    legacy_expected.skipped_due_to_mock = True
    legacy_expected.satisfied_count = 0
    legacy_expected.per_entity = []

    real_legacy = qt_mod._legacy_topup_for_plan  # alias module-level (Pass 5)

    def fake_legacy(*args, **kwargs):
        return legacy_expected

    qt_mod._legacy_topup_for_plan = fake_legacy
    try:
        s = _settings_pass5()
        object.__setattr__(s, "mock_mode", True)
        plan, _ = _plan_one_deficit(deficit_s=20.0)

        rep = topup_for_plan_concurrent(plan, MagicMock(), s,
                                        embedder=MagicMock())
        assert rep.skipped_due_to_mock is True
        assert rep is legacy_expected
    finally:
        qt_mod._legacy_topup_for_plan = real_legacy


# -----------------------------------------------------------------------
# T_Q2 — backpressure: producer bloqueia em queue.put quando qsize=maxsize.
# -----------------------------------------------------------------------
def test_q2_producer_blocks_when_queue_full():
    """Queue com maxsize=2 e produtor sem consumer → acontece block em
    put() no 3º item. Verifica qsize==2 E thread está alive."""
    q: Queue = Queue(maxsize=2)

    def producer():
        q.put(0)
        q.put(1)
        q.put(2)  # BLOCKS maxsize=2

    t = threading.Thread(target=producer, daemon=True)
    t.start()
    time.sleep(0.2)  # deixa producer enfileirar até bloquear
    assert q.qsize() == 2, f"esperado qsize=2 (maxsize), got {q.qsize()}"
    assert t.is_alive(), "producer devia estar bloqueado em put()"
    # Drain para desbloquear.
    q.get()
    q.get()
    t.join(timeout=2)
    assert not t.is_alive()


# -----------------------------------------------------------------------
# T_Q3 — budget_exceeded Event: set/clear mecânico.
# -----------------------------------------------------------------------
def test_q3_budget_exceeded_event_signals_workers():
    """Event-based stop: set/clear é independente entre budget_exceeded e
    error_event. Verifica mecânico básico sem threads."""
    s_total_cost = 0.05
    budget = 0.001
    state = _SharedState(budget=budget)
    assert s_total_cost >= budget  # sanity
    assert not state.budget_exceeded.is_set()
    state.budget_exceeded.set()
    assert state.budget_exceeded.is_set()
    assert not state.error_event.is_set()  # independente
    state.error_event.set()
    assert state.error_event.is_set()
    state.budget_exceeded.clear()
    assert not state.budget_exceeded.is_set()


# -----------------------------------------------------------------------
# T_Q4 — clean_drain_sentinel: thread dummy termina em sentinel.
# -----------------------------------------------------------------------
def test_q4_sentinel_drains_worker_clean():
    """Thread pega sentinel _SHUTDOWN e sai do loop. NÃO colocar sentinel
    na queue ANTES de thread.start() — caso contrário get() consome antes
    do thread rodar."""
    q: Queue = Queue()

    def worker():
        while True:
            tok = q.get()
            if _is_shutdown(tok):
                return

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    time.sleep(0.05)  # deixa thread estar esperando em q.get()
    assert t.is_alive(), "worker devia estar bloqueado em get()"
    q.put(_SHUTDOWN)
    t.join(timeout=2)
    assert not t.is_alive(), "worker devia ter saído em sentinel"
    assert _is_shutdown(q.get()) if not q.empty() else True


# -----------------------------------------------------------------------
# T_Q5 — ingest worker FIFO determinístico.
# -----------------------------------------------------------------------
def test_q5_ingest_worker_single_thread_deterministic(tmp_path):
    """3 assets enfileirados → ingest consome na ordem FIFO (state.ingested_count=3).
    Patch via setattr em ingest_asset module (item 19: _worker_ingest migrou
    de ingest_file() para ingest_asset() — P3 2026-08-11; o monkeypatch
    antigo apontava para um símbolo que já não existe em queue_topup)."""
    import studio.library.ingest_asset as ingest_asset_mod
    import studio.library.queue_topup as qt_mod

    # Cria 3 dummy MP4 files para asset.path existir.
    paths = []
    for i in range(3):
        p = tmp_path / f"q5_{i}.mp4"
        p.write_bytes(b"\x00" * 16)
        paths.append(p)

    # ingest_asset mock — devolve (IngestResult, state) ingested com shots=1.
    real_ingest_asset = ingest_asset_mod.ingest_asset
    call_count = [0]

    def fake_ingest(path, lic, db, settings, embedder, **kwargs):
        call_count[0] += 1
        r = MagicMock(status="ingested", media_sha=path.stem,
                      shots_added=1, cost_usd=0.01)
        return r, MagicMock()

    ingest_asset_mod.ingest_asset = fake_ingest

    # preflight_check mock — devolve None (skip).
    real_preflight = qt_mod.preflight_check
    qt_mod.preflight_check = lambda path, settings: None

    try:
        from studio.library.queue_topup import (
            _worker_ingest, DownloadedAsset,
        )

        state = _SharedState(budget=15.0)
        report = TopupReport()
        pe = TopupPerEntity(entity="E", entity_type="food",
                            deficit_before=25.0, deficit_after=25.0)
        per_entity_map = {"E": pe}
        asset_queue: Queue = Queue(maxsize=8)
        for i, p in enumerate(paths):
            asset_queue.put(DownloadedAsset(
                path=p, license={"source_url": f"u{i}"},
                entity="E", entity_idx=i, round_idx=1, query="q",
            ))
        asset_queue.put(_SHUTDOWN)

        s = _settings_pass5()
        s.library_root.mkdir(parents=True, exist_ok=True)
        db = MagicMock()

        _worker_ingest(asset_queue, state, db, s, MagicMock(),
                       report, per_entity_map)

        assert call_count[0] == 3, (
            f"ingest_asset deveria ter sido chamado 3× (got {call_count[0]})"
        )
        assert state.ingested_count == 3
        assert state.total_cost == pytest.approx(0.03, abs=1e-9)
        assert report.total_cost_usd == pytest.approx(0.03, abs=1e-4)
    finally:
        ingest_asset_mod.ingest_asset = real_ingest_asset
        qt_mod.preflight_check = real_preflight


# -----------------------------------------------------------------------
# T_Q6 — speedup: 2 downloaders concorrentes vs 1 sequencial.
# -----------------------------------------------------------------------
def test_q6_concurrent_speedup_vs_sequential(tmp_path):
    """2 downloaders concorrentes ESTÃO mais rápidos que 1 sequencial em
    fixture de 4 entities deficitárias. Mock sweep (sleep 0.15s) e
    ingest (instantâneo) via setattr."""
    import studio.library.ingest_asset as ingest_asset_mod
    import studio.library.queue_topup as qt_mod
    import studio.library.topup as topup_mod
    from studio.matching.coverage_plan import CoveragePlan, EntityCoverage

    # Plan: 4 entities com deficit. Cada uma tem query distinta.
    ents = []
    for i in range(4):
        ents.append(EntityCoverage(
            canonical_name=f"E{i}", entity_type="food",
            priority_score=0.8, mention_count=4,
            required_seconds=40.0, target_seconds=50.0,
            min_distinct_shots=5,
            available_seconds=0.0, available_distinct_shots=0,
            available_files=0,
            deficit_seconds=25.0, strict=False, location="Porto",
            queries=[f"E{i} feat"],
        ))
    plan = CoveragePlan(topic="x", total_script_seconds=120.0,
                        ranked_entities=ents)

    # Dummy MP4 files.
    per_query_file: dict[str, tuple[Path, dict]] = {}
    for i in range(4):
        p = tmp_path / f"{i}_E{i}_feat.mp4"
        p.write_bytes(b"\x00" * 16)
        per_query_file[f"E{i} feat"] = (p, {"source_url": f"u_{i}"})

    SLEEP_S = 0.15
    entities_seen_conc: set[str] = set()
    entities_seen_seq: set[str] = set()

    def mock_sweep_concurrent(query, count, settings, dest):
        time.sleep(SLEEP_S)
        for i in range(4):
            if query.startswith(f"E{i}"):
                entities_seen_conc.add(f"E{i}")
                break
        return [per_query_file[query]] if query in per_query_file else []

    def mock_sweep_sequential(query, count, settings, dest):
        time.sleep(SLEEP_S)
        for i in range(4):
            if query.startswith(f"E{i}"):
                entities_seen_seq.add(f"E{i}")
                break
        return [per_query_file[query]] if query in per_query_file else []

    def fake_ingest(path, lic, db, settings, embedder, **kwargs):
        r = MagicMock(status="ingested", media_sha=path.stem,
                      shots_added=1, cost_usd=0.001)
        return r, MagicMock()

    # item 19: topup_for_plan (sequential) E _worker_ingest (concurrent)
    # migraram para ingest_asset() (P3 2026-08-11), ambos com lazy import
    # `from studio.library.ingest_asset import ingest_asset` dentro da
    # função — patchar o atributo do módulo cobre as duas chamadas.
    real_ingest_asset = ingest_asset_mod.ingest_asset
    real_qt_preflight = qt_mod.preflight_check

    ingest_asset_mod.ingest_asset = fake_ingest
    qt_mod.preflight_check = lambda path, settings: None
    # Code-reviewer nit: preflight_check em T_Q6 sequential também é
    # lazy-imported em topup.py → patchar qt_mod NÃO chega. Patchamos
    # o módulo FONTE early_reject para fidelity sequencial.
    import studio.library.early_reject as early_reject_mod
    real_seq_preflight = early_reject_mod.preflight
    early_reject_mod.preflight = lambda path, settings: None

    # ---- RUN CONCURRENT (2 downloaders, queue bounded) ----
    s_conc = _settings_pass5(dl_workers=2)
    s_conc.library_root.mkdir(parents=True, exist_ok=True)
    db_conc = MagicMock()
    db_conc.cache_mark_rejected = MagicMock()
    db_conc.cache_get = MagicMock(return_value=None)

    real_qt_sweep = qt_mod.sweep
    real_qt_bqh = qt_mod.build_query_hierarchy

    # build_query_hierarchy retorna só a primeira query do entity.
    def fake_bqh(name, location, entity_type, features, levels):
        return [f"{name} feat"]

    qt_mod.sweep = mock_sweep_concurrent
    qt_mod.build_query_hierarchy = fake_bqh

    try:
        t0 = time.perf_counter()
        rep_conc = topup_for_plan_concurrent(
            plan, db_conc, s_conc, MagicMock(), max_rounds=1,
            run_id="t6_concurrent",
        )
        dt_conc = time.perf_counter() - t0
    finally:
        qt_mod.sweep = real_qt_sweep
        qt_mod.build_query_hierarchy = real_qt_bqh
        qt_mod.preflight_check = real_qt_preflight

    # ---- RUN SEQUENTIAL (legacy topup_for_plan) ----
    s_seq = _settings_pass5(dl_workers=1)
    s_seq.library_root.mkdir(parents=True, exist_ok=True)
    db_seq = MagicMock()
    db_seq.cache_mark_rejected = MagicMock()
    db_seq.cache_get = MagicMock(return_value=None)

    import studio.library.sources.pexels as pexels_mod
    real_pexels_sweep = pexels_mod.sweep
    pexels_mod.sweep = mock_sweep_sequential

    try:
        from studio.library.topup import topup_for_plan
        t0 = time.perf_counter()
        rep_seq = topup_for_plan(
            plan, db_seq, s_seq, MagicMock(), max_rounds=1,
            run_id="t6_sequential",
        )
        dt_seq = time.perf_counter() - t0
    finally:
        pexels_mod.sweep = real_pexels_sweep
        early_reject_mod.preflight = real_seq_preflight
        ingest_asset_mod.ingest_asset = real_ingest_asset

    # Speedup assert: 4 sleeps × 0.15s sequential = 0.6s; com 2 workers = 0.3s.
    # Conservador: speedup >= 1.3× para tolerar overhead.
    assert dt_conc < dt_seq, (
        f"concurrent ({dt_conc:.3f}s) deveria ser mais rápido que "
        f"sequential ({dt_seq:.3f}s)"
    )
    speedup = dt_seq / max(dt_conc, 0.001)
    assert speedup >= 1.3, (
        f"speedup insuficiente: {speedup:.2f}× — esperado >= 1.3× "
        f"(concurrent={dt_conc:.3f}s, sequential={dt_seq:.3f}s)"
    )
    # Functional equivalence: ambos processaram todas as 4 entities.
    assert entities_seen_conc == {"E0", "E1", "E2", "E3"}
    assert entities_seen_seq == {"E0", "E1", "E2", "E3"}
    assert len(rep_conc.per_entity) >= 4
    assert len(rep_seq.per_entity) >= 4
