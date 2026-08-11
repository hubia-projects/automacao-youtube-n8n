"""Testes Pass 3 Fase 2 - provider_cache wired + negative_cache auto + TTL prune.

8 testes cobrindo a spec do user + 2 bonus:

1. cache_hit_skip_sweep (Pass 3.2 wired): query cached-rejected
   -> sweep NAO e' chamado em topup.
2. topup_ends_early_quando_coverage_suficiente (Pass 3.2 invariant):
   entity com deficit=0 -> topup termina sem sweep.
3. cache_mark_rejected_em_vision_low_confidence (Pass 3.3 wiring):
   analyze_shot sparse meta -> cache_mark_rejected chamado com
   reason "vision_low_confidence=0.00".
4. cache_prune_by_ttl_apaga_rows_velhas (Pass 3.4): insert antiga
   (40d) + recente (5d) -> prune(30d) -> antiga removida, recente OK;
   pytest.skip se LanceDB nao tiver `.delete()` (CI sem suporte).
5. cache_get_distinguishes_hit_vs_rejected (Pass 3.4 invariant):
   mesma URL com cache_mark + cache_mark_rejected -> 2 rows distintas.
6. cross_provider_isolation_persiste (Pass 3.1 invariant): cache_mark
   em pexels NAO fica visivel em cache_get com pixabay (e vice-versa).
7. cache_iter_rows_scan_basico (bonus): scan simples funciona.
8. coverage_plan_negative_cache_age_seconds (bonus): measure_coverage
   computa negative_cache_age_seconds correctamente via cache scan.

Estrategia: monkeypatch para ffprobe / analyze_shot / sweep / cache_iter_rows;
real LanceDB em tmp_path (Pass 1 validou lock + cache table).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


# ---- helpers ----


def _make_test_settings_for_pass3(**overrides):
    from studio.config import Settings
    base = dict(
        mock_mode=False,
        pexels_api_key="test_key",
        budget_usd_per_run=15.0,
        early_reject_min_duration_s=2.0,
        early_reject_min_resolution=720,
        topup_asset_useful_s_default=5.0,
        entity_confirm_min_confidence=0.85,
        negative_cache_ttl_days=90,
        coverage_buffer=1.25,
        min_shots_by_duration=8.0,
        query_levels=4,
        topup_ingest_workers=1,
    )
    base.update(overrides)
    return Settings(**base)


def _make_stub_embedder():

    class _Stub:
        dim = 768

        def embed_images(self, paths):
            try:
                import numpy as np
                return np.zeros((len(paths), 768), dtype=np.float32)
            except ImportError:
                return [[0.0] * 768] * len(paths)

    return _Stub()


def _make_entity_coverage_p3(default_deficit_seconds: float = 25.0):
    from studio.matching.coverage_plan import EntityCoverage
    return EntityCoverage(
        canonical_name="Francesinha",
        entity_type="food",
        priority_score=0.85,
        mention_count=1,
        required_seconds=20.0,
        target_seconds=default_deficit_seconds,
        min_distinct_shots=max(1, -(-int(default_deficit_seconds) // 8)),
        available_seconds=0.0,
        available_distinct_shots=0,
        available_files=0,
        deficit_seconds=default_deficit_seconds,
        strict=False,
        queries=["francesinha porto sandwich"],
        location="Porto",
    )


def _plan_for(entity):
    from studio.matching.coverage_plan import CoveragePlan
    return CoveragePlan(ranked_entities=[entity])


@pytest.fixture
def db(tmp_path: Path):
    from studio.library.db import LibraryDB
    return LibraryDB(tmp_path)


# ============================================================
# Pass 3.2 - provider_cache wired em topup
# ============================================================


def test_1_cache_hit_skip_sweep_em_topup(tmp_path, monkeypatch):
    """Query cached-rejected -> sweep NAO e' chamado em topup."""
    from studio.library.db import LibraryDB
    from studio.library.topup import topup_for_plan
    import studio.library.topup as topup_mod

    db_p3 = LibraryDB(tmp_path)
    db_p3.cache_mark_rejected(
        "pexels", "francesinha porto sandwich",
        "old vision_low_confidence=0.10",
    )

    plan = _plan_for(_make_entity_coverage_p3(25.0))
    s = _make_test_settings_for_pass3(library_root=tmp_path)

    # Mock build_query_hierarchy para devolver string exacta cached-rejected
    # (sem este mock, hierarchy devolve "francesinha food dish meal" e NAO
    # bate com "francesinha porto sandwich" cached).
    monkeypatch.setattr(
        "studio.library.topup.build_query_hierarchy",
        lambda *a, **kw: ["francesinha porto sandwich"],
    )
    # Pass 3 close-out fix code-reviewer: sweep e lazy-import em
    # topup.py (from studio.library.sources.pexels import sweep dentro
    # de topup_for_plan) => topup_mod.sweep NAO existe. Patch na FONTE.
    monkeypatch.setattr(
        "studio.library.sources.pexels.sweep",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError(
            "sweep NAO devia ser chamado - query cached-rejected"
        )),
    )
    monkeypatch.setattr(
        "studio.library.ingest.ingest_file",
        lambda *a, **kw: (_ for _ in ()).throw(
            AssertionError("ingest_file NAO devia ser chamado")),
    )
    # preflight OK para que candidate_queries avancem sem mais rejects
    import studio.library.early_reject as er
    monkeypatch.setattr(topup_mod, "preflight_check", lambda p, s: None)

    report = topup_for_plan(plan, db_p3, s, _make_stub_embedder(), max_rounds=1)
    per = report.per_entity[0]
    notes_str = " | ".join(per.notes)
    assert "skip cached-rejected query" in notes_str, \
        f"esperado cache-rejected skip em notes; obtido: {notes_str!r}"


def test_2_topup_ends_early_quando_coverage_suficiente(
    tmp_path, monkeypatch,
):
    """Entity com deficit=0 -> topup termina sem chamar sweep."""
    from studio.library.db import LibraryDB
    from studio.library.topup import topup_for_plan

    db_p3 = LibraryDB(tmp_path)

    entity = _make_entity_coverage_p3(25.0)
    entity.target_seconds = 25.0
    entity.required_seconds = 20.0
    entity.available_seconds = 25.0  # >= target
    entity.deficit_seconds = 0.0

    plan = _plan_for(entity)
    s = _make_test_settings_for_pass3()

    sweep_called = {"n": 0}

    def fake_sweep(*a, **kw):
        sweep_called["n"] += 1
        return []

    # topup.py lazy-import sweep dentro da funcao; patch via FONTE.
    monkeypatch.setattr(
        "studio.library.sources.pexels.sweep", fake_sweep,
    )
    monkeypatch.setattr(
        "studio.library.ingest.ingest_file",
        lambda *a, **kw: (_ for _ in ()).throw(
            AssertionError("ingest_file NAO devia ser chamado")),
    )

    report = topup_for_plan(plan, db_p3, s, _make_stub_embedder(), max_rounds=1)
    # Contract 3a via (Pass 3 close-out): per_entity vazio para entities
    # deficit=0 (preserva test_topup.py::TestTopupEarlyReturn/NoDeficit).
    # Observability exposta via TopupReport.satisfied_count (NAO polui payload).
    assert report.per_entity == [], (
        f"per_entity deve estar vazio para deficit=0; obtido: {report.per_entity!r}"
    )
    assert report.satisfied_count == 1, (
        f"satisfied_count deve ser 1 (1 entity deficit=0); obtido: {report.satisfied_count}"
    )
    assert sweep_called["n"] == 0, (
        f"sweep devia NAO ser chamado quando deficit=0; chamado {sweep_called['n']}x"
    )


# ============================================================
# Pass 3.3 - negative_cache auto em ingest (vision_low_confidence)
# ============================================================


def test_3_cache_mark_rejected_em_vision_low_confidence(
    tmp_path, monkeypatch,
):
    """analyze_shot sparse meta (0 evidence fields) -> vision_conf=0.0
    < 0.85 -> cache_mark_rejected chamado automaticamente."""
    from studio.library.db import LibraryDB
    from studio.library.ingest import ingest_file

    db_p3 = LibraryDB(tmp_path)

    # Stub analyze_shot: retorna meta com 0 evidence fields
    class _SparseMeta:
        summary = "very sparse shot, no detectable content"
        places: list[str] = []
        landmarks: list[str] = []
        food_items: list[str] = []
        objects: list[str] = []
        shot_type = "unknown"
        camera_motion = "static"
        time_of_day = "day"
        indoor_outdoor = "unknown"
        people_present = False
        quality = 3
        has_food = False
        has_landmark = False

    class _AnalyzeResult:
        def __init__(self):
            self.meta = _SparseMeta()
            self.cost = 0.0

    def fake_analyze_shot(keyframes, settings, source_hint):
        return _AnalyzeResult()

    # Patch ingest.py imports via 'from' (NAME local; NAO atributo de origem).
    import studio.library.metadata as metadata_mod
    import studio.library.ingest as ingest_mod
    monkeypatch.setattr(metadata_mod, "analyze_shot", fake_analyze_shot)

    monkeypatch.setattr(
        ingest_mod, "detect_shots",
        lambda media_path: [(0.0, 5.0)],
    )
    monkeypatch.setattr(
        ingest_mod, "extract_keyframes",
        lambda media_path, t_in, t_out, kf_dir: [],
    )

    # Embedder trivial (sem GPU)
    class _StubEmbed:
        dim = 768

        def embed_images(self, paths):
            import numpy as np
            return np.zeros((len(paths), 768), dtype=np.float32)

    # Licença com source_url específica para a cache_get verificar
    lic = {
        "source": "pexels",
        "source_url": "https://pexels.com/v/vision-low-conf-test-789/",
        "license": "pexels",
        "author": "test",
        "license_source": "pexels",
        "attribution_text": "",
    }
    # library_root=tmp_path (default seria data/library - fora do workspace).
    s = _make_test_settings_for_pass3(library_root=tmp_path)
    fake_video = tmp_path / "fake.mp4"
    fake_video.write_bytes(b"\x00" * 4096)

    ingest_file(fake_video, lic, db_p3, s, _StubEmbed())

    cached = db_p3.cache_get(
        "pexels", "https://pexels.com/v/vision-low-conf-test-789/",
    )
    assert cached is not None, \
        "cache_mark_rejected (vision_low_confidence) NAO foi chamado"
    assert cached["status"] == "rejected"
    assert "vision_low_confidence" in cached["reason"], \
        f"esperado 'vision_low_confidence' na reason; obtido: {cached['reason']!r}"


# ============================================================
# Pass 3.4 - cache_prune_by_ttl cleanup
# ============================================================


def test_4_cache_prune_by_ttl_apaga_rows_velhas(db, monkeypatch):
    """Insere antiga (40d) + recente (5d); prune(30d) -> antiga removida,
    recente preservada. pytest.skip se LanceDB sem `.delete()`."""
    # Patch cache_mark para aceitar created_at override
    from studio.library import db as db_mod

    if not hasattr(db._cache_tbl, "delete"):
        pytest.skip(
            "LanceDB version sem .delete() — cache_prune_by_ttl cae em "
            "fallback no-op; test requer .delete() disponivel."
        )

    real_cache_mark = db_mod.LibraryDB.cache_mark

    def cache_mark_with_old_ts(
        self, provider, source_url, media_sha=None,
        created_at: str | None = None,
    ):
        if created_at is None:
            return real_cache_mark(self, provider, source_url, media_sha)
        row = {
            "provider": provider, "source_url": source_url,
            "status": "hit", "media_sha": media_sha or "",
            "reason": "",
            "created_at": created_at,
        }
        with self._write_lock:
            self._cache_tbl.add([row])

    db_mod.LibraryDB.cache_mark = cache_mark_with_old_ts

    try:
        old_ts = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
        db.cache_mark("pexels", "https://old.example/v/1",
                       media_sha="old_sha", created_at=old_ts)
        recent_ts = (datetime.now(timezone.utc) - timedelta(days=5)).isoformat()
        db.cache_mark("pexels", "https://recent.example/v/1",
                       media_sha="recent_sha", created_at=recent_ts)

        pruned = db.cache_prune_by_ttl(30)
        assert pruned >= 1, (
            f"prune(30d) devia remover >= 1 row antiga; removeu {pruned}"
        )

        old = db.cache_get("pexels", "https://old.example/v/1")
        assert old is None, \
            f"row antiga (40d) devia ter sido removida; ainda existe: {old}"
        recent = db.cache_get(
            "pexels", "https://recent.example/v/1",
        )
        assert recent is not None, "row recente (5d) deve ser preservada"
        assert recent["status"] == "hit"
    finally:
        db_mod.LibraryDB.cache_mark = real_cache_mark


# ============================================================
# Pass 3.1 invariants - cache_get distinguishes + cross-provider
# ============================================================


def test_5_cache_get_distinguishes_hit_vs_rejected(db):
    """Mesma URL com cache_mark + cache_mark_rejected -> 2 rows
    distintas por status (zero cross-contamination)."""
    same_url = "https://provider.example/v/same"
    db.cache_mark("pexels", same_url, media_sha="hit_sha")
    db.cache_mark_rejected("pexels", same_url, "reason_for_rejection")

    rows = db.cache_iter_rows(
        f"provider = 'pexels' AND source_url = '{same_url}'"
    )
    statuses = sorted(r["status"] for r in rows)
    assert statuses == ["hit", "rejected"], \
        f"esperado [hit, rejected]; obtido {statuses!r}"
    # Cada row tem o seu media_sha distintivo OU string vazia + reason
    hit_row = next(r for r in rows if r["status"] == "hit")
    rej_row = next(r for r in rows if r["status"] == "rejected")
    assert hit_row["media_sha"] == "hit_sha"
    assert rej_row["reason"] == "reason_for_rejection"
    assert rej_row["media_sha"] == ""


def test_6_cross_provider_isolation(db):
    """cache_mark em 'pexels' NAO fica visivel em cache_get com 'pixabay'
    - mesma URL funciona como duas rows diferentes (isolamento SSoT)."""
    url = "https://common-source.example/v/123"
    db.cache_mark("pexels", url, media_sha="pexels_sha")
    db.cache_mark("pixabay", url, media_sha="pixabay_sha")

    e_pexels = db.cache_get("pexels", url)
    e_pixabay = db.cache_get("pixabay", url)
    assert e_pexels is not None and e_pexels["provider"] == "pexels"
    assert e_pixabay is not None and e_pixabay["provider"] == "pixabay"
    assert e_pexels["media_sha"] == "pexels_sha"
    assert e_pixabay["media_sha"] == "pixabay_sha"


# ============================================================
# Bonus tests
# ============================================================


def test_7_cache_iter_rows_scan_basico(db):
    """cache_iter_rows permite scan simples com status='rejected'."""
    db.cache_mark("pexels", "https://example.com/v/1", media_sha="x")
    db.cache_mark_rejected("pexels", "https://example.com/v/2", "test reject")
    rows = db.cache_iter_rows("status = 'rejected'")
    assert any(
        r["source_url"] == "https://example.com/v/2" for r in rows
    ), "cache_iter_rows deve encontrar a row rejected"


def test_8_coverage_plan_negative_cache_age_seconds(db):
    """measure_coverage acumula negative_cache_age_seconds para entities
    cujas rows provider_cache rejected mencionam canonical_name."""
    import datetime as _dt

    # Mock cache_iter_rows para devolver uma row controlada (10 dias atrás)
    fake_rows = [
        {
            "provider": "pexels",
            "source_url": "https://pexels.com/v/mock",
            "status": "rejected",
            "reason": "francesinha rejected test reason",
            "media_sha": "",
            "created_at": (
                _dt.datetime.now(_dt.timezone.utc)
                - _dt.timedelta(days=10)
            ).isoformat(),
        },
    ]
    original_iter = db.cache_iter_rows
    db.cache_iter_rows = lambda clause, limit=20000: (
        list(fake_rows) if "francesinha" in clause.lower() else []
    )

    try:
        from studio.matching.coverage_plan import (
            EntityCoverage, measure_coverage,
        )
        entity = EntityCoverage(
            canonical_name="Francesinha", entity_type="food",
            priority_score=0.85, mention_count=1,
            required_seconds=20.0, target_seconds=25.0, min_distinct_shots=4,
            available_seconds=0.0, deficit_seconds=25.0, strict=False,
            queries=[], location="",
        )
        measure_coverage(entity, db)
        assert entity.negative_cache_age_seconds > 0, (
            f"negative_cache_age_seconds devia > 0; obtido: "
            f"{entity.negative_cache_age_seconds}"
        )
        # 10 dias ≈ 864000 s; tolerância ±10%
        assert 778000 < entity.negative_cache_age_seconds < 950400, (
            f"esperado ~864000s (10d); obtido: "
            f"{entity.negative_cache_age_seconds}"
        )
    finally:
        db.cache_iter_rows = original_iter
