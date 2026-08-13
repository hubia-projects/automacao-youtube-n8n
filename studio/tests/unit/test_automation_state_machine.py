"""Item 1.8 (automation closure): a automação como máquina de estados —
casos A-F do enunciado.

Casos B (incompleta+manual, gate ANTES de qualquer download) e D
(biblioteca já pronta, zero chamadas ao provider) já têm cobertura directa
em `test_library_gate.py` (mocka `is_workset_ready` mas não espia o
provider explicitamente); aqui reforçamos com spies explícitos em
`pexels.search`/`download` e cobrimos os casos que faltavam: C (auto-
acquire dispara SEM pausa humana), D (reject → stop limpo), E (credencial
inválida → zero DB/Vision tocados). Caso F (crash/resume, zero
duplicação) já tem cobertura e2e real em `test_workset_idempotency.py`
(RequirementIndex + LibraryDB reais, não FakeDB) — não duplicado aqui.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest


def _base_ctx(tmp_path, extra_params=None, video_id="wid-sm-test"):
    from studio.config import Settings
    from studio.orchestrator.stage import RunContext
    from studio.orchestrator.state import RunState

    state = RunState(video_id=video_id, topic="Porto", stages={})
    settings = Settings(STUDIO_MOCK="1", STUDIO_DATA_ROOT=tmp_path,
                        STUDIO_PEXELS_API_KEY="")
    run_dir = tmp_path / "runs" / video_id
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

    return RunContext(params=params, video_id=video_id,
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


# ---------------------------------------------------------------------------
# CASO A — biblioteca já pronta: zero chamadas ao provider (spy explícito,
# não só is_workset_ready mockado).
# ---------------------------------------------------------------------------
def test_caso_a_biblioteca_pronta_zero_chamadas_provider(tmp_path, monkeypatch):
    from studio.stages import produce as produce_mod
    from studio.matching.assigner import AssignmentResult

    _patch_common(monkeypatch)
    monkeypatch.setattr(
        "studio.matching.coverage_plan.is_workset_ready",
        lambda *a, **kw: (True, {"Francesinha": "COVERED"}, []))
    # item 18/19: is_workset_ready=True dispara allocate_shots dentro de
    # _measure_ready() — bypassa com resultado feasible (não é o assunto
    # deste teste, já cobertos em test_selection.py).
    monkeypatch.setattr(
        "studio.library.selection.allocate_shots",
        lambda *a, **kw: MagicMock(selection_feasible=True, by_requirement={}))
    assign_mock = MagicMock(return_value=AssignmentResult(segments=[]))
    import studio.matching.assigner as assigner_mod
    monkeypatch.setattr(assigner_mod, "assign_shots", assign_mock)
    search_mock = MagicMock(return_value=[])
    monkeypatch.setattr("studio.library.sources.pexels.search", search_mock)

    ctx = _base_ctx(tmp_path)
    produce_mod.S08Matching().run(ctx)

    search_mock.assert_not_called()
    assign_mock.assert_called()


# ---------------------------------------------------------------------------
# CASO C — incompleta + --auto-acquire-library: SEM pausa humana. O gate
# nunca é chamado; a aquisição dispara imediatamente.
# ---------------------------------------------------------------------------
def test_caso_c_auto_acquire_dispara_sem_pausa_humana(tmp_path, monkeypatch):
    from studio.stages import produce as produce_mod

    _patch_common(monkeypatch)
    monkeypatch.setattr(
        "studio.matching.coverage_plan.is_workset_ready",
        lambda *a, **kw: (False, {"Francesinha": "PARTIAL"}, ["Francesinha"]))
    gate_mock = MagicMock()
    monkeypatch.setattr(produce_mod, "request_gate", gate_mock)
    acquire_mock = MagicMock()
    from studio.library.acquisition import AcquisitionReport
    acquire_mock.return_value = AcquisitionReport(
        coverage_status={}, coverage_ready=False, downloads_succeeded=0)
    monkeypatch.setattr(
        "studio.library.acquisition.run_acquisition_for_workset", acquire_mock)

    ctx = _base_ctx(tmp_path, extra_params={"auto_acquire_library": True})
    res = produce_mod.S08Matching().run(ctx)

    gate_mock.assert_not_called()
    assert acquire_mock.called, (
        "run_acquisition_for_workset devia ter sido chamado sem pausa humana"
    )
    assert res.status == "failed"  # biblioteca continua incompleta após tentar


# ---------------------------------------------------------------------------
# CASO D — operador rejeita a aquisição: stop LIMPO
# (status="failed" com nota clara), nunca "continua incompleto".
# ---------------------------------------------------------------------------
def test_caso_d_reject_para_run_de_forma_limpa(tmp_path, monkeypatch):
    from studio.stages import produce as produce_mod
    from studio.approvals.gates import GateRejected

    _patch_common(monkeypatch)
    monkeypatch.setattr(
        "studio.matching.coverage_plan.is_workset_ready",
        lambda *a, **kw: (False, {"Francesinha": "PARTIAL"}, ["Francesinha"]))
    assign_mock = MagicMock()
    import studio.matching.assigner as assigner_mod
    monkeypatch.setattr(assigner_mod, "assign_shots", assign_mock)
    acquire_mock = MagicMock()
    monkeypatch.setattr(
        "studio.library.acquisition.run_acquisition_for_workset", acquire_mock)

    def gate_rejects(*a, **kw):
        raise GateRejected("library")
    monkeypatch.setattr(produce_mod, "request_gate",
                        MagicMock(side_effect=gate_rejects))

    ctx = _base_ctx(tmp_path)
    res = produce_mod.S08Matching().run(ctx)

    assert res.status == "failed"
    assert "cancelou" in res.notes.lower()
    acquire_mock.assert_not_called()
    assign_mock.assert_not_called()


# ---------------------------------------------------------------------------
# CASO E — credencial Gemini inválida: ACTION_REQUIRED (fail-fast), ZERO
# aquisição, ZERO fan-out de Vision, ZERO acesso à biblioteca.
# ---------------------------------------------------------------------------
def test_caso_e_credencial_invalida_bloqueia_antes_de_tudo(tmp_path, monkeypatch):
    from studio.stages import produce as produce_mod

    import studio.library.gemini_preflight as pre_mod
    monkeypatch.setattr(
        pre_mod, "preflight_gemini_credentials",
        lambda settings: (False, "GEMINI_CREDENTIALS_INVALID: HTTP 403"))
    db_mock = MagicMock(side_effect=AssertionError(
        "LibraryDB não devia ser tocada — preflight falhou antes de tudo"))
    import studio.library.db as db_module
    monkeypatch.setattr(db_module, "LibraryDB", db_mock)
    confirm_mock = MagicMock()
    import studio.library.confirmation as conf_mod
    monkeypatch.setattr(conf_mod, "require_entity_confirmation", confirm_mock)
    acquire_mock = MagicMock()
    monkeypatch.setattr(
        "studio.library.acquisition.run_acquisition_for_workset", acquire_mock)

    ctx = _base_ctx(tmp_path)
    res = produce_mod.S08Matching().run(ctx)

    assert res.status == "failed"
    assert "GEMINI_CREDENTIALS_INVALID" in res.notes
    db_mock.assert_not_called()
    confirm_mock.assert_not_called()
    acquire_mock.assert_not_called()
