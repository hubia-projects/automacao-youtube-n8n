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

    class FakeDB:
        def __init__(self, root): self.root = root
        def get_shot(self, sid): return None
        def iter_rows(self, where, *, limit=20000, include_restricted=False): return []
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
    monkeypatch.setattr(conf_mod, "require_entity_confirmation",
                        lambda *a, **kw: [])

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
