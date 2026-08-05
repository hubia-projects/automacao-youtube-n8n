"""E2E Fase 6 (sabotagem, ROADMAP): atribuir deliberadamente um shot de
monumento a uma cena de comida → o revisor tem de sinalizar ESSA cena com
replace_shot; o loop corrige; score final ≥90.
"""

import json

import pytest

from studio.orchestrator.runner import PipelineRunner
from studio.orchestrator.state import load_state, new_state, save_state
from studio.stages.produce import produce_stages


@pytest.fixture()
def produce_ctx(ctx, fake_embedder, seeded_library):
    ctx.params.update({"topic": "Pastéis de Belém em Lisboa",
                       "duration_minutes": 1.0,
                       "_embedder": fake_embedder})
    return ctx


def test_sabotagem_detetada_corrigida(produce_ctx, fake_embedder, seeded_library):
    ctx = produce_ctx
    state = new_state(ctx.video_id, ctx.params["topic"], 15.0)
    save_state(state, ctx.run_dir)
    stages = produce_stages()

    # correr até ao proxy (parar antes do revisor)
    PipelineRunner(stages[:10]).run(ctx, state)

    # SABOTAGEM: substituir o 1º segmento de uma cena de comida por um shot
    # de monumento (metadados has_landmark)
    from studio.library.search import search_shots

    assign_path = ctx.run_dir / "08_matching" / "assignments.json"
    result = json.loads(assign_path.read_text())
    briefs = {b["scene_id"]: b for b in json.loads(
        (ctx.run_dir / "07_briefs" / "briefs.json").read_text())}
    food_seg = next(s for s in result["segments"]
                    if "food" in briefs[s["scene_id"]]["must_have"])
    monument = search_shots(seeded_library, fake_embedder, "historic tower",
                            must_have=["landmark"], min_quality=0, k=5)[0]
    sabotaged_scene = food_seg["scene_id"]
    food_seg.update({
        "shot_id": monument["shot_id"], "media_path": monument["media_path"],
        "media_sha": monument["media_sha"], "has_food": False, "has_landmark": True,
        "source_in": monument["t_in"],
        "source_out": monument["t_in"] + (food_seg["source_out"] - food_seg["source_in"]),
    })
    assign_path.write_text(json.dumps(result, ensure_ascii=False))
    # timeline e proxy têm de refletir a sabotagem: apagar s09/s10 do estado
    st = load_state(ctx.run_dir)
    for name in ["09_timeline", "10_render_proxy"]:
        st.stages.pop(name, None)
    save_state(st, ctx.run_dir)

    # retomar: rebuild timeline+proxy → revisor → fix → re-review → final
    PipelineRunner(stages).run(ctx, load_state(ctx.run_dir))

    review_dir = ctx.run_dir / "11_review"
    r1 = json.loads((review_dir / "review_r1.json").read_text())
    assert r1["global"]["overall"] < 90
    fix_scenes = [f["scene_id"] for f in r1["fixes"]]
    assert sabotaged_scene in fix_scenes, \
        f"revisor não sinalizou a cena sabotada {sabotaged_scene}: {fix_scenes}"
    assert all(f["action"] == "replace_shot" for f in r1["fixes"])

    r2 = json.loads((review_dir / "review_r2.json").read_text())
    assert r2["global"]["overall"] >= 90

    # a cena sabotada já não tem monumento
    fixed = json.loads(assign_path.read_text())
    segs = [s for s in fixed["segments"] if s["scene_id"] == sabotaged_scene]
    assert segs and all(s["has_food"] and not s["has_landmark"] for s in segs)

    # pipeline completo: gate final (mock auto-aprova) + render final
    final = load_state(ctx.run_dir)
    assert final.gates["final"] == "approve"
    assert final.stages["12_render_final"].status == "done"
    assert (ctx.run_dir / "12_render_final" / "final.mp4").exists()
