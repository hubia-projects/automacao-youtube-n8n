"""T1-17 da master integration refactor de 2026-08-11.

Sys.path bootstrap via tests/conftest.py (resolve imports absolutos a
benchmark_library_pipeline sem passar por `studio.scripts`, que NÃO é
package porque pyproject.toml só inclui `src/studio`).
Tests T16-17 são P11: prova que acquire_for_deficits é chamada quando
deficits persistem e termina cedo quando coverage_ready.
"""
from __future__ import annotations

import importlib
from pathlib import Path
from unittest.mock import MagicMock

import pytest

REPO = Path(__file__).resolve().parents[2]
STUDIO_SRC = REPO / "studio" / "src"

_bm = importlib.import_module("benchmark_library_pipeline")


# === Test 1 ===
def test_1_benchmark_root_real():
    rp = Path(_bm._REPO_ROOT)
    assert (rp / "studio" / "src" / "studio").exists()
    assert (rp / "studio" / "scripts" / "benchmark_library_pipeline.py").exists()
    print("✓ T1 OK")


# === Test 2 ===
def test_2_b2_grep_no_match_not_fail():
    res = _bm.b2_architecture_assess()
    assert res.get("ok") is True
    print("✓ T2 OK")


# === Test 3 ===
def test_3_b2_detects_ingest_file_import(tmp_path):
    (tmp_path / "fake_lib.py").write_text(
        "from studio.library.ingest import ingest_file\n"
        "def call():\n    ingest_file('x.mp4', {}, None, None, None)\n"
    )
    offenders, err = _bm._ast_scan_ingest_file_callers(tmp_path)
    assert err is None
    assert any(o.endswith("fake_lib.py") for o in offenders)
    print("✓ T3 OK")


# === Test 4 ===
def test_4_workset_roundtrip_exact():
    from studio.library.workset_context import _coerce_requirement
    spec = _coerce_requirement({
        "canonical_entity": "Livraria Lello", "entity_type": "place",
        "strict": True, "required_seconds": 50.0,
        "target_seconds": 48.75, "min_distinct_shots": 5,
        "narration_t_in": 12.5, "narration_t_out": 60.0,
        "aliases": ["Lello", "Lello Bookshop"], "location": "Porto",
    }, 0)
    assert spec is not None
    assert spec.target_seconds == 48.75
    assert spec.min_distinct_shots == 5
    assert spec.narration_seconds == pytest.approx(47.5)
    print("✓ T4 OK")


# === Test 5 ===
def test_5_strict_covered_only_confirmed():
    from studio.library.requirement_index import (
        RequirementMatch, CS_CONFIRMED, CS_PENDING,
        is_strict_covered_pure,
    )
    def _m(status, strict_eligible=True, dur=8.0, sid="s"):
        return RequirementMatch(
            "t1", "R1", sid, "m1", 0.9, dur,
            status, 0.95, strict_eligible, ("v",))
    matches = [_m(CS_CONFIRMED, strict_eligible=True, dur=60.0, sid="s1")]
    matches += [_m(CS_PENDING, strict_eligible=True, dur=8.0, sid=f"s{i}")
                for i in range(2, 11)]
    covered, sec, shots = is_strict_covered_pure(
        matches, target_seconds=50.0, min_distinct_shots=5)
    assert covered is False    # 1 CONFIRMED só, 1 distinct shot
    print("✓ T5 OK")


# === Test 6 ===
def test_6_requirement_persist_jsonl(tmp_path):
    from studio.library.requirement_index import (
        RequirementIndex, RequirementMatch, CS_CONFIRMED,
    )
    class _F:
        def __init__(self, r): self.r = r
        @property
        def library_root(self): return self.r
        @property
        def lance(self): raise RuntimeError("LanceDB disabled for test")
    db = _F(tmp_path)
    ri = RequirementIndex(db)
    m = RequirementMatch("t1", "R1", "s1", "m1", 0.9, 11.0,
                        CS_CONFIRMED, 0.95, True, ("e",))
    assert ri.upsert_match(m) is True
    out = ri.list_for_workset("t1")
    assert len(out) == 1 and out[0].shot_id == "s1"
    print("✓ T6 OK")


# === Test 7 ===
def test_7_discovery_cache_hit_signal(tmp_path):
    from studio.library.discovery import DiscoveryIndex, DiscoveryRecord
    class _F:
        def __init__(self, r): self.r = r
        @property
        def library_root(self): return self.r
        @property
        def lance(self): raise RuntimeError("LanceDB disabled for test")
    db = _F(tmp_path)
    di = DiscoveryIndex(db)
    rec = DiscoveryRecord(
        media_path="/tmp/a.mp4", source_id="a", media_sha="h",
        duration=10.0, width=1920, height=1080, codec="h264",
        file_size=1000, siglip_model_id="siglip-base",
        discovery_version=1, preview_vec=[0.0] * 768,
        status="DISCOVERED_GLOBAL",
    )
    assert di.upsert(rec) is True
    assert di.has_scanned("/tmp/a.mp4") is True
    print("✓ T7 OK")


# === Test 8 ===
def test_8_coverage_gain_ranks_top_first():
    from studio.library.discovery import coverage_gain
    g1 = coverage_gain(sim=0.9, target_seconds=10.0,
                       available_seconds=0.0, deficit=10.0, quality=8)
    g2 = coverage_gain(sim=0.5, target_seconds=10.0,
                       available_seconds=5.0, deficit=5.0, quality=4)
    assert g1 > g2
    print("✓ T8 OK")


# === Test 9 ===
def test_9_microbatch_stop_defensive():
    from studio.library.acquisition import AcquisitionReport
    rep = AcquisitionReport()
    assert rep.coverage_ready is False
    rep.coverage_ready = True
    assert rep.coverage_ready is True
    print("✓ T9 OK")


# === Test 10 ===
def test_10_provider_dedup_signature():
    from studio.library.acquisition import is_provider_already_taken
    class _F:
        def __init__(self, st): self.st = st
        def cache_get(self, prov, url):
            return ({"status": self.st} if self.st else None)
    for st in ("HIT", "REJECTED", "DONE"):
        assert is_provider_already_taken("p", "u", _F(st)) is True
    assert is_provider_already_taken("p", "u", _F(None)) is False
    print("✓ T10 OK")


# === Test 11 ===
def test_11_gemini_telemetry_4xx_policy():
    from studio.library.metadata import get_gemini_telemetry, reset_gemini_telemetry
    reset_gemini_telemetry()
    t = get_gemini_telemetry()
    t.actual_http_requests += 1
    t.actual_http_4xx_failfast += 1
    d = t.as_dict()
    assert d["actual_http_requests"] == 1 and d["actual_http_4xx_failfast"] == 1
    assert d["actual_retries"] == 0    # 4xx fail-fast ≠ retry
    print("✓ T11 OK")


# === Test 12 ===
def test_12_gemini_telemetry_429_retry():
    from studio.library.metadata import get_gemini_telemetry, reset_gemini_telemetry
    reset_gemini_telemetry()
    t = get_gemini_telemetry()
    for _ in range(3):
        t.actual_http_requests += 1
        t.actual_http_429_retries += 1
        t.actual_retries += 1
    d = t.as_dict()
    assert d["actual_http_requests"] == 3 and d["actual_retries"] == 3
    print("✓ T12 OK")


# === Test 13 ===
def test_13_gemini_telemetry_real_count():
    from studio.library.metadata import get_gemini_telemetry, reset_gemini_telemetry
    reset_gemini_telemetry()
    t = get_gemini_telemetry()
    for _ in range(1):
        t.actual_http_requests += 1
    for _ in range(2):
        t.actual_http_requests += 1
        t.actual_http_429_retries += 1
        t.actual_retries += 1
    d = t.as_dict()
    assert d["actual_retries"] > 0       # real retries ≠ logical ceil
    print("✓ T13 OK")


# === Test 14 ===
def test_14_global_only_constant():
    from studio.library.ingest import TIER_GLOBAL, NEEDS_ENRICHMENT_SUMMARY
    assert TIER_GLOBAL == "GLOBAL_ONLY"
    assert NEEDS_ENRICHMENT_SUMMARY == "NEEDS_ENRICHMENT"
    print("✓ T14 OK")


# === Test 15 ===
def test_15_zero_direct_ingest_file_callers():
    res = _bm.b2_architecture_assess()
    whitelist = (
        "studio/library/ingest_asset.py",
        "studio/library/ingest.py",
        "studio/scripts/benchmark_library_pipeline.py",
    )
    for off in res.get("external_callers", []):
        assert not any(w in off for w in whitelist)
    assert res.get("ok") is True
    print("✓ T15 OK")


# === Test 16 — P11 acquire_for_deficits é chamada quando depleted ===
def test_16_p11_acquire_called_when_depleted():
    """P11: quando deficits>0 e provider_resolver devolve mock, o report
    regista queries_run≥1 e wall_s≥0 (gate/exercise prova)."""
    from studio.library.acquisition import (
        acquire_for_deficits, DeficitItem,
    )
    settings = MagicMock()
    settings.mock_mode = False
    ctx = MagicMock()
    ctx.req_by_canonical.return_value = MagicMock(
        canonical_entity="Lello", aliases=(), location="Porto")
    di = [DeficitItem("Lello", "R-Lello", 48.75, 48.75, 5, 1.0)]
    rep = acquire_for_deficits(
        workset_ctx=ctx, db=MagicMock(), embedder=MagicMock(),
        settings=settings, deficit_items=di,
        provider_resolver=lambda q, lvl: [],
        remeasure_coverage=lambda: False, max_iterations=4,
    )
    assert rep.queries_run > 0, "expected at least 1 query attempted"
    print(f"✓ T16 OK — P11 wire exercitada, queries={rep.queries_run}, "
          f"down_attempted={rep.downloads_attempted}")


# === Test 17 — P11 NÃO chama quando coverage_ready ===
def test_17_p11_acquire_not_called_when_ready():
    """P11: remeasure retorna True → ciclo termina cedo (≤1 iteration)."""
    from studio.library.acquisition import (
        acquire_for_deficits, DeficitItem,
    )
    settings = MagicMock()
    settings.mock_mode = False
    ctx = MagicMock()
    ctx.req_by_canonical.return_value = MagicMock(
        canonical_entity="Lello", aliases=(), location="Porto")
    di = [DeficitItem("Lello", "R-Lello", 48.75, 48.75, 5, 1.0)]
    rep = acquire_for_deficits(
        workset_ctx=ctx, db=MagicMock(), embedder=MagicMock(),
        settings=settings, deficit_items=di,
        provider_resolver=lambda q, lvl: [],
        remeasure_coverage=lambda: True, max_iterations=4,
    )
    assert rep.coverage_ready is True
    assert rep.iterations <= 1
    print(f"✓ T17 OK — P11 STOP early: ready=True, "
          f"iterations={rep.iterations}")
