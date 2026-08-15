"""Item B (closure pass): S08Matching vivo tem de usar o workset genérico
(build_workset + load_workset_context), não build_coverage_plan directo.

Antes desta correcção, S08Matching chamava
`build_coverage_plan(spans, db, ctx.settings, topic=topic)` sem `scenes=`
nem `include_filler=True` — o CoveragePlan real (com scene-duration math e
filler contextual, já implementados em coverage_plan.py) nunca chegava à
produção viva; só corria em testes standalone de workset_builder.py.
"""
from __future__ import annotations

import inspect
import json
import re
from pathlib import Path

from studio.stages import produce


def test_s08_matching_chama_build_workset_e_load_workset_context():
    source = inspect.getsource(produce.S08Matching.run)
    assert "build_workset(" in source
    assert "load_workset_context(" in source
    assert "plan = build_coverage_plan(" not in source, (
        "S08 não deve mais chamar build_coverage_plan directamente — "
        "isso é responsabilidade interna de build_workset()"
    )
    assert "from studio.matching.coverage_plan import build_coverage_plan" \
        not in source


def test_s08_reindexa_apos_confirmacao_antes_do_gate():
    """BUG REAL (PORTO FINAL RETRIEVAL FIX): `_index_existing()` refresca
    `ent.available_shot_ids` a partir da RequirementIndex TAL COMO ESTAVA
    antes de `_run_strict_confirmation()` escrever novas confirmações.
    `is_workset_ready()` intersecta `confirmed_index` (fresco, lido da
    RequirementIndex depois da confirmação) com `available_shot_ids`
    (stale, de antes) — shots confirmados NA PRÓPRIA WAVE nunca entram em
    `strict_set`, o gate reporta NOT_FOUND/UNCONFIRMED apesar de cobertura
    estrita real persistida suficiente (caso real: Torre dos Clérigos/
    Miradouro da Serra do Pilar/Ponte Dom Luís I excediam o target e ainda
    assim apareciam NOT_FOUND numa run ao vivo). Cada
    `_run_strict_confirmation()` tem de ser seguido por outro
    `_index_existing()` antes do próximo `_measure_ready()`.
    """
    source = inspect.getsource(produce.S08Matching.run)
    code_only = "\n".join(
        line for line in source.splitlines()
        if not line.strip().startswith("#") and not line.strip().startswith("def ")
    )
    calls = re.findall(
        r"_run_strict_confirmation\(\)|_index_existing\(\)|_measure_ready\(\)",
        code_only,
    )
    assert calls.count("_run_strict_confirmation()") >= 2, (
        "esperava pelo menos 2 chamadas (pré-loop + dentro do wave loop)"
    )
    for i, call in enumerate(calls):
        if call == "_run_strict_confirmation()":
            assert calls[i + 1] == "_index_existing()", (
                f"_run_strict_confirmation() na posição {i} não é seguido "
                f"por _index_existing() — regressão do bug de staleness "
                f"de available_shot_ids (ver comentário BUG REAL em "
                f"produce.py junto a _run_strict_confirmation())"
            )


def test_s08_matching_integration_cria_workset_no_disco(tmp_path, monkeypatch):
    from studio.config import Settings
    from studio.orchestrator.stage import RunContext
    from studio.orchestrator.state import RunState

    state = RunState(video_id="wid-b-test", topic="Porto", stages={})
    settings = Settings(STUDIO_MOCK="1", STUDIO_DATA_ROOT=tmp_path,
                        STUDIO_PEXELS_API_KEY="")
    run_dir = tmp_path / "runs" / "wid-b-test"
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

    # item 1.3/1.6 (automation closure): o gate agora recusa avançar para
    # matching enquanto a biblioteca não estiver READY (nunca mais
    # "aprovar avançar mesmo assim") — para este teste continuar a exercer
    # o caminho FELIZ até ao fim (selected_shots.json real), a FakeDB
    # precisa de ter cobertura suficiente para "Francesinha" e a
    # confirmação Vision (mockada) tem de devolver o shot como confirmado.
    _matching_row = {
        "shot_id": "shot_fr_1", "media_sha": "sha_fr_1", "t_in": 0.0,
        "t_out": 10.0, "quality": 5, "revoked": False,
        "food_csv": "francesinha", "landmarks_csv": "", "places_csv": "",
    }

    class FakeDB:
        def __init__(self, root): self.root = root
        def get_shot(self, sid):
            return _matching_row if sid == "shot_fr_1" else None
        def iter_rows(self, where, *, limit=20000, include_restricted=False):
            return [_matching_row]
        def search_vec(self, *a, **kw): return []
        def entity_vocab(self): return {}
        def cache_prune_by_ttl(self, days): return 0

    import studio.library.db as db_module
    monkeypatch.setattr(db_module, "LibraryDB", FakeDB)

    from studio.matching.assigner import AssignmentResult
    import studio.matching.assigner as assigner_mod
    monkeypatch.setattr(assigner_mod, "assign_shots",
                        lambda *a, **kw: AssignmentResult(segments=[]))
    import studio.library.confirmation as conf_mod

    def _fake_confirm(canonical, entity_type, db, settings, **kwargs):
        if canonical.strip().lower() == "francesinha":
            # PORTO FINAL RETRIEVAL FIX: o gate real (_measure_ready em
            # produce.py) passou a ler a RequirementIndex persistida
            # (cumulativa, correcta) em vez do dict efémero por-chamada —
            # o mock precisa de escrever lá também, tal como
            # require_entity_confirmation() real sempre fez quando
            # requirement_index/workset_id/requirement_id são passados.
            ri_kw = kwargs.get("requirement_index")
            if ri_kw is not None and kwargs.get("requirement_id"):
                from studio.library.requirement_index import (
                    CS_CONFIRMED, RequirementMatch,
                )
                ri_kw.upsert_match(RequirementMatch(
                    workset_id=kwargs.get("workset_id", ""),
                    requirement_id=kwargs["requirement_id"],
                    shot_id=_matching_row["shot_id"],
                    media_sha=_matching_row["media_sha"],
                    similarity=0.0,
                    duration=_matching_row["t_out"] - _matching_row["t_in"],
                    confirmation_status=CS_CONFIRMED,
                    confirmation_confidence=0.95,
                    strict_eligible=True,
                ))
            return [_matching_row]
        return []
    monkeypatch.setattr(conf_mod, "require_entity_confirmation", _fake_confirm)
    # item 18/19: _measure_ready() também chama allocate_shots contra a
    # RequirementIndex real — a FakeDB não implementa os internals do
    # LanceDB que RequirementIndex precisa, então bypassa com um
    # resultado feasible (o assunto deste teste é o wiring do workset,
    # não o allocator, já testado em test_selection.py).
    from unittest.mock import MagicMock as _MM
    monkeypatch.setattr(
        "studio.library.selection.allocate_shots",
        lambda *a, **kw: _MM(selection_feasible=True, by_requirement={}))

    class DummyEmbedder:
        model_id = "fake-model"
    import studio.library.embed as embed_mod
    monkeypatch.setattr(embed_mod, "SiglipEmbedder", DummyEmbedder)

    ctx = RunContext(
        params={"_embedder": DummyEmbedder()},
        video_id="wid-b-test", run_dir=run_dir, settings=settings, state=state,
    )
    produce.S08Matching().run(ctx)

    wdir = settings.library_root / "worksets" / "wid-b-test"
    assert (wdir / "theme.json").exists()
    assert (wdir / "visual_requirements.json").exists()
    assert (wdir / "coverage.json").exists()
    vr = json.loads((wdir / "visual_requirements.json").read_text("utf-8"))
    canons = {r["canonical_entity"] for r in vr["requirements"]}
    assert "Francesinha" in canons

    # item I/J: selected_shots.json deixou de ser o scaffold vazio
    # {"by_entity": {}} — tem selection_feasible + by_entity real
    # (biblioteca vazia no FakeDB -> feasible=False, mas a CHAVE existe).
    sel = json.loads((wdir / "selected_shots.json").read_text("utf-8"))
    assert "selection_feasible" in sel
    assert "Francesinha" in sel["by_entity"]
    cov = json.loads((wdir / "coverage.json").read_text("utf-8"))
    assert "selection_feasible" in cov
    assert "overall_ready" in cov
