"""Item V/W (closure pass): gate de aprovação da biblioteca em S08Matching.

- Workset READY -> gate nunca é chamado, assign_shots corre normalmente.
- Workset NOT READY + auto_acquire_library=True (topup já esgotado acima)
  -> StageResult(status="failed"), assign_shots NUNCA chamado.
- Workset NOT READY + sem auto_acquire_library + gate pendente
  -> StageResult(status="waiting_approval"), assign_shots NUNCA chamado.
  (item W: consequência directa — S09 não recebe status="done".)
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest


def _base_ctx(tmp_path, extra_params=None):
    from studio.config import Settings
    from studio.orchestrator.stage import RunContext
    from studio.orchestrator.state import RunState

    state = RunState(video_id="wid-gate-test", topic="Porto", stages={})
    settings = Settings(STUDIO_MOCK="1", STUDIO_DATA_ROOT=tmp_path,
                        STUDIO_PEXELS_API_KEY="")
    run_dir = tmp_path / "runs" / "wid-gate-test"
    for stage in ("03_script", "05_timestamps", "06_scenes", "07_briefs"):
        (run_dir / stage).mkdir(parents=True)
    (run_dir / "03_script" / "script.md").write_text(
        "# Porto\nFrancesinha em destaque.", "utf-8")

    from studio.script.scenes import Scene
    from studio.script.entities import EntitySpan
    from studio.matching.briefs import VisualBrief

    scene = Scene(scene_id="s01", t_in=0.0, t_out=5.0, text="Francesinha",
                 beat="detail", primary_entity="Francesinha",
                 primary_entity_type="food", strict_entity=True)
    (run_dir / "06_scenes" / "scenes.json").write_text(
        json.dumps([scene.model_dump()], ensure_ascii=False), "utf-8")
    span = EntitySpan(entity_id="francesinha:0001", canonical_name="Francesinha",
                      entity_type="food", t_in=0.0, t_out=5.0,
                      text="Francesinha", importance=0.9, strict_visual=True)
    (run_dir / "06_scenes" / "entity_spans.json").write_text(
        json.dumps([span.model_dump()], ensure_ascii=False), "utf-8")
    brief = VisualBrief(scene_id="s01", visual_subject_en="francesinha dish",
                        required_entity="Francesinha",
                        required_entity_type="food", strict_entity=True)
    (run_dir / "07_briefs" / "briefs.json").write_text(
        json.dumps([brief.model_dump()], ensure_ascii=False), "utf-8")

    params = {"_embedder": _DummyEmbedder()}
    if extra_params:
        params.update(extra_params)

    return RunContext(params=params, video_id="wid-gate-test",
                      run_dir=run_dir, settings=settings, state=state)


class _DummyEmbedder:
    model_id = "fake-model"


class _FakeDB:
    def __init__(self, root):
        self.root = root

    def get_shot(self, sid):
        return None

    def iter_rows(self, where, *, limit=20000, include_restricted=False):
        return []

    def search_vec(self, *a, **kw):
        return []

    def entity_vocab(self):
        return {}

    def cache_prune_by_ttl(self, days):
        return 0


def _patch_common(monkeypatch):
    import studio.library.db as db_module
    monkeypatch.setattr(db_module, "LibraryDB", _FakeDB)
    import studio.library.embed as embed_mod
    monkeypatch.setattr(embed_mod, "SiglipEmbedder", _DummyEmbedder)
    import studio.library.confirmation as conf_mod
    monkeypatch.setattr(conf_mod, "require_entity_confirmation",
                        lambda *a, **kw: [])
    import studio.library.gemini_preflight as pre_mod
    monkeypatch.setattr(pre_mod, "preflight_gemini_credentials",
                        lambda settings: (True, ""))


def test_workset_ready_gate_nunca_e_chamado_assign_corre(tmp_path, monkeypatch):
    from studio.stages import produce as produce_mod
    from studio.matching.assigner import AssignmentResult

    _patch_common(monkeypatch)
    monkeypatch.setattr(
        "studio.matching.coverage_plan.is_workset_ready",
        lambda *a, **kw: (True, {"Francesinha": "COVERED"}, []))
    assign_mock = MagicMock(return_value=AssignmentResult(segments=[]))
    import studio.matching.assigner as assigner_mod
    monkeypatch.setattr(assigner_mod, "assign_shots", assign_mock)
    gate_mock = MagicMock()
    monkeypatch.setattr(produce_mod, "request_gate", gate_mock)

    ctx = _base_ctx(tmp_path)
    res = produce_mod.S08Matching().run(ctx)

    gate_mock.assert_not_called()
    assign_mock.assert_called()
    assert res.status in ("done", "failed")  # não bloqueado pelo gate


def test_workset_nao_ready_auto_acquire_falha_fechado(tmp_path, monkeypatch):
    from studio.stages import produce as produce_mod

    _patch_common(monkeypatch)
    monkeypatch.setattr(
        "studio.matching.coverage_plan.is_workset_ready",
        lambda *a, **kw: (False, {"Francesinha": "PARTIAL"}, ["Francesinha"]))
    assign_mock = MagicMock()
    import studio.matching.assigner as assigner_mod
    monkeypatch.setattr(assigner_mod, "assign_shots", assign_mock)
    gate_mock = MagicMock()
    monkeypatch.setattr(produce_mod, "request_gate", gate_mock)

    ctx = _base_ctx(tmp_path, extra_params={"auto_acquire_library": True})
    res = produce_mod.S08Matching().run(ctx)

    assert res.status == "failed"
    assert "WORKSET_READY" in res.notes
    gate_mock.assert_not_called()
    assign_mock.assert_not_called()


def test_workset_nao_ready_sem_auto_acquire_pede_gate_e_fica_waiting(
    tmp_path, monkeypatch,
):
    from studio.stages import produce as produce_mod
    from studio.approvals.gates import GatePending

    _patch_common(monkeypatch)
    monkeypatch.setattr(
        "studio.matching.coverage_plan.is_workset_ready",
        lambda *a, **kw: (False, {"Francesinha": "PARTIAL"}, ["Francesinha"]))
    assign_mock = MagicMock()
    import studio.matching.assigner as assigner_mod
    monkeypatch.setattr(assigner_mod, "assign_shots", assign_mock)

    def gate_raises(*a, **kw):
        raise GatePending("library")
    gate_mock = MagicMock(side_effect=gate_raises)
    monkeypatch.setattr(produce_mod, "request_gate", gate_mock)

    ctx = _base_ctx(tmp_path)
    res = produce_mod.S08Matching().run(ctx)

    assert res.status == "waiting_approval"
    assert "library" in res.notes
    gate_mock.assert_called_once()
    assign_mock.assert_not_called()
