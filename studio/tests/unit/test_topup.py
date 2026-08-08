"""Testes Fase D — Top-up inteligente baseado em deficit do CoveragePlan.

Cobertura:
T20 — early-return skipped entities (deficit=0)
T21 — all satisfied → per_entity vazio
T22 — dedupe cross-entity de queries (real mode com sweep mock)
T23 — max_rounds=2 cap respeitado em real mode
T24 — cost_budget respeitado (mocks controlam cost ingest)
T25 — mock_mode continua isolado (no network)
PRÉ-FIX 4 — include_restricted override
FIX-1 smoke — assigner signature aceita coverage_plan + warning contextual
FIX-2 smoke — EntityCoverage.location persiste do build_coverage_plan
write_topup_log persiste JSON
"""
from __future__ import annotations
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from studio.config import Settings
from studio.matching.coverage_plan import (
    CoveragePlan, EntityCoverage, build_coverage_plan,
)
from studio.library.topup import topup_for_plan, write_topup_log


def _plan_with(entity, et, *, req=40.0, deficit=25.0, location="Porto",
               priority=0.6, strict=True, queries=None):
    tgt = req * 1.25
    if queries is None:
        queries = [f"{entity} {et} feat", f"{entity} {location} {et}",
                   f"{entity} Portugal"]
    return EntityCoverage(
        canonical_name=entity, entity_type=et,
        priority_score=priority, mention_count=4,
        required_seconds=req, target_seconds=tgt,
        min_distinct_shots=7,
        available_seconds=tgt - deficit,
        available_distinct_shots=2, available_files=2,
        deficit_seconds=deficit, strict=strict,
        location=location, queries=queries,
    )


def _settings_real(cost_budget=15.0):
    s = Settings(_env_file=None)
    object.__setattr__(s, "mock_mode", False)
    object.__setattr__(s, "pexels_api_key", "TEST_KEY")
    object.__setattr__(s, "budget_usd_per_run", cost_budget)
    return s


def _fake_db_with_iter(rows=None):
    db = MagicMock()
    db.iter_rows = MagicMock(return_value=list(rows or []))
    return db


class TestTopupEarlyReturn(unittest.TestCase):
    def test_zero_deficit_entity_skipped(self):
        s = _settings_real()
        e_ok = _plan_with("Lizbon", "place", deficit=0.0, priority=0.1,
                          strict=False)
        plan = CoveragePlan(topic="x", total_script_seconds=120.0,
                            ranked_entities=[e_ok])
        with patch("studio.library.sources.pexels.sweep") as msweep:
            rep = topup_for_plan(plan, _fake_db_with_iter(), s,
                                 embedder=MagicMock())
        self.assertEqual(rep.per_entity, [])
        self.assertEqual(rep.total_cost_usd, 0.0)
        msweep.assert_not_called()


class TestTopupNoDeficit(unittest.TestCase):
    def test_no_topup_when_all_satisfied(self):
        s = _settings_real()
        e1 = _plan_with("Lizbon", "place", deficit=0.0, strict=False)
        e2 = _plan_with("Porto", "place", deficit=0.0, strict=False)
        plan = CoveragePlan(topic="x", total_script_seconds=120.0,
                            ranked_entities=[e1, e2])
        rep = topup_for_plan(plan, _fake_db_with_iter(), s, embedder=MagicMock())
        self.assertEqual(rep.per_entity, [])
        self.assertEqual(rep.total_cost_usd, 0.0)


class TestTopupQueryDedupe(unittest.TestCase):
    def test_first_query_first_entity_then_dedupe_for_subsequent(self):
        s = _settings_real()
        # Fase D topup REBUILDS queries via build_query_hierarchy — qualquer
        # override de `queries=` em EntityCoverage é IGNORADO. Por isso esta
        # teste usa defaults gerados pelo _plan_with.
        e1 = _plan_with("Francesinha", "food", deficit=30.0)
        e2 = _plan_with("Francesinha Generic", "food", deficit=20.0,
                        priority=0.4)
        plan = CoveragePlan(topic="x", total_script_seconds=100.0,
                            ranked_entities=[e1, e2])
        sweep_calls = []
        # patch na FONTE porque topup_for_plan importa sweep localmente
        with patch("studio.library.sources.pexels.sweep",
                   side_effect=lambda q, *a, **k: sweep_calls.append(q) or []):
            rep = topup_for_plan(plan, _fake_db_with_iter(), s,
                                 embedder=MagicMock(), max_rounds=2)
        self.assertGreaterEqual(len(sweep_calls), 2)
        self.assertEqual(len(sweep_calls), len(set(sweep_calls)),
                         msg=f"queries duplicadas em sweep: {sweep_calls}")
        names = [p.entity for p in rep.per_entity]
        self.assertIn("Francesinha", names)
        self.assertIn("Francesinha Generic", names)


class TestTopupMaxRounds(unittest.TestCase):
    def test_real_mode_max_rounds(self):
        s = _settings_real()
        # FIX 5 (code-reviewer): topup rebuilds queries; usar defaults
        # do _plan_with (queries= removido).
        e1 = _plan_with("Francesinha", "food", deficit=50.0,
                        queries=[])  # qualquer override é IGNORADO
        plan = CoveragePlan(topic="x", total_script_seconds=100.0,
                            ranked_entities=[e1])
        sweep_calls = []
        # patch na FONTE — ver T22 comentário
        with patch("studio.library.sources.pexels.sweep",
                   side_effect=lambda q, *a, **k: sweep_calls.append(q) or []):
            rep = topup_for_plan(plan, _fake_db_with_iter(), s,
                                 embedder=MagicMock(), max_rounds=2)
        # Fase D topup rebuilds queries via build_query_hierarchy; não usa
        # ent.queries override. Validação: max_rounds cap.
        self.assertEqual(len(sweep_calls), 2,
                         msg=f"max_rounds=2, esperava 2 sweeps, recebi {sweep_calls}")
        self.assertEqual(rep.per_entity[0].rounds, 2)
        self.assertEqual(len(rep.per_entity[0].queries_used), 2)


class TestTopupBudget(unittest.TestCase):
    def test_zero_budget_skips(self):
        s = _settings_real(cost_budget=15.0)
        e1 = _plan_with("Francesinha", "food", deficit=20.0,
                        queries=["Francesinha feat"])
        plan = CoveragePlan(topic="x", total_script_seconds=60.0,
                            ranked_entities=[e1])
        # patch na FONTE
        with patch("studio.library.sources.pexels.sweep", return_value=[]):
            rep = topup_for_plan(plan, _fake_db_with_iter(), s,
                                 embedder=MagicMock(), max_rounds=2,
                                 cost_budget_usd=0.0)
        # cost_budget=0.0 → skipped_due_to_budget=True ANTES do 1º round
        self.assertTrue(rep.skipped_due_to_budget)


class TestTopupMockMode(unittest.TestCase):
    def test_mock_does_not_call_internet(self):
        s = Settings(_env_file=None)
        object.__setattr__(s, "mock_mode", True)
        e1 = _plan_with("Francesinha", "food", deficit=20.0)
        plan = CoveragePlan(topic="x", total_script_seconds=60.0,
                            ranked_entities=[e1])
        with patch("studio.library.sources.pexels.sweep") as msweep, \
             patch("studio.library.ingest.ingest_file") as mingest:
            rep = topup_for_plan(plan, _fake_db_with_iter(), s,
                                 embedder=MagicMock())
        self.assertTrue(rep.skipped_due_to_mock)
        msweep.assert_not_called()
        mingest.assert_not_called()
        for p in rep.per_entity:
            self.assertTrue(any("mock" in n for n in p.notes))


class TestIterRowsRestrictedFlag(unittest.TestCase):
    """PRÉ-FIX 4 — exercita _build_iter_clause sem I/O real."""

    def test_include_restricted_true_intact(self):
        from studio.library.db import _build_iter_clause
        out = _build_iter_clause("places_csv LIKE '%Porto%'", True)
        self.assertEqual(out, "places_csv LIKE '%Porto%'")
        self.assertNotIn("restricted = false", out)

    def test_include_restricted_false_adds(self):
        from studio.library.db import _build_iter_clause
        out = _build_iter_clause("places_csv LIKE '%Porto%'", False)
        self.assertIn("restricted = false", out)
        self.assertIn("places_csv LIKE", out)

    def test_restricted_already_no_dup(self):
        from studio.library.db import _build_iter_clause
        out = _build_iter_clause("restricted = true", False)
        self.assertEqual(out, "restricted = true")
        # regex word-boundary NÃO duplica
        self.assertNotIn("AND restricted = false", out)

    def test_empty_where_default(self):
        """FIX 2 (code-reviewer Fase D): empty where + include_restricted=True
        é fail-LOUD (ValueError). Aglomerado não-causal failure mode."""
        from studio.library.db import _build_iter_clause
        # modo normal: empty where + default include_restricted=False
        self.assertEqual(_build_iter_clause("", False), "restricted = false")
        # empty where + include_restricted=True é ill-defined → raise
        with self.assertRaises(ValueError):
            _build_iter_clause("", True)


class TestCoveragePlanLocationPersists(unittest.TestCase):
    def test_location_persists(self):
        from studio.script.entities import EntitySpan
        s = Settings(_env_file=None)
        object.__setattr__(s, "mock_mode", True)
        spans = [EntitySpan(
            entity_id="francesinha", canonical_name="Francesinha",
            entity_type="food", t_in=10.0, t_out=40.0,
            text="...francesinha...", aliases=[],
            importance=0.95, strict_visual=True,
            location_context="Porto",
        )]
        plan = build_coverage_plan(spans, _fake_db_with_iter(), s,
                                   topic="24h Porto",
                                   total_script_seconds=120.0)
        self.assertEqual(len(plan.ranked_entities), 1)
        self.assertEqual(plan.ranked_entities[0].location, "Porto")


class TestWriteTopupLog(unittest.TestCase):
    def test_write_log_persists(self):
        s = Settings(_env_file=None)
        object.__setattr__(s, "mock_mode", True)
        e1 = _plan_with("Francesinha", "food", deficit=20.0)
        plan = CoveragePlan(topic="x", total_script_seconds=60.0,
                            ranked_entities=[e1])
        rep = topup_for_plan(plan, _fake_db_with_iter(), s,
                             embedder=MagicMock())
        td = Path(tempfile.mkdtemp(prefix="tmp_topup_"))
        try:
            out = write_topup_log(rep, td / "log.json")
            data = json.loads(out.read_text("utf-8"))
            self.assertIn("per_entity", data)
            self.assertTrue(data["skipped_due_to_mock"])
            self.assertIn("total_rounds", data)
        finally:
            import shutil
            shutil.rmtree(td, ignore_errors=True)


class TestAssignerUsesCoveragePlan(unittest.TestCase):
    def test_signature_accepts_kwarg(self):
        from studio.matching.assigner import assign_shots
        import inspect
        sig = inspect.signature(assign_shots)
        self.assertIn("coverage_plan", sig.parameters)

    def test_info_log_when_deficit_pre_loop(self):
        """FIX-3 regression: assigner emite info log per-scene quando
        entidade tem deficit estrutural no plano, mesmo se depois o
        _preflight_topups fecha o gap."""
        from studio.script.scenes import Scene
        from studio.matching.briefs import VisualBrief
        from studio.matching.assigner import assign_shots
        scene = Scene(scene_id="s001", t_in=0.0, t_out=5.0, beat="detail",
                      text="A Francesinha do Porto",
                      primary_entity="Francesinha", primary_entity_type="food",
                      strict_entity=True)
        brief = VisualBrief(scene_id="s001",
                            visual_subject_en="Francesinha close up",
                            must_have=["food"], must_not=[],
                            required_entity="Francesinha",
                            required_entity_type="food",
                            strict_entity=True)
        e = _plan_with("Francesinha", "food", deficit=30.0)
        plan = CoveragePlan(topic="x", total_script_seconds=60.0,
                            ranked_entities=[e])
        s = _settings_real()
        db = MagicMock()
        # patch apenas no source (topup importa sweep localmente)
        with patch("studio.library.sources.pexels.sweep",
                   return_value=[]) as msweep:
            with patch("studio.library.ingest.ingest_file",
                       return_value=MagicMock(status="skipped_duplicate",
                                              media_sha="", shots_added=0,
                                              cost_usd=0.0)) as mingest:
                # mock entity_vocab + resolve_entity para pre-flight Patcher
                with patch("studio.library.inventory.entity_vocab",
                           return_value={"francesinha": ["francesinha"]}):
                    with patch("studio.library.inventory.resolve_entity",
                               side_effect=lambda entity, vocab:
                                   ["francesinha"] if "francesinha" in
                                   (entity or "").lower() else []):
                        with self.assertLogs("studio.assigner",
                                             level="INFO") as cm:
                            _ = assign_shots([scene], [brief], db,
                                             MagicMock(), s,
                                             run_id="test_run", topic="x",
                                             coverage_plan=plan)
        joined = "\n".join(cm.output)
        self.assertIn("Francesinha", joined,
                      msg=f"esperava info log Francesinha; logs={cm.output}")


