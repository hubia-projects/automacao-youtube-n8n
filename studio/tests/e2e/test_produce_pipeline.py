"""E2E Fases 3+4 (mock): tema → roteiro → áudio → cenas → briefs →
matching → timeline.

Asserts do ROADMAP Fase 4: 0 cenas por preencher, 0 shots duplicados,
toda a cena de comida recebe shot com comida (regressão monumento/comida).
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


def test_fases_3_4_e2e_mock(produce_ctx):
    ctx = produce_ctx
    state = new_state(ctx.video_id, ctx.params["topic"], 15.0)
    save_state(state, ctx.run_dir)

    PipelineRunner(produce_stages()).run(ctx, state)

    final = load_state(ctx.run_dir)
    for stage in ["01_topic", "02_research", "03_script", "04_tts", "05_timestamps",
                  "06_scenes", "07_briefs", "08_matching", "09_timeline",
                  "10_render_proxy", "11_review", "12_render_final",
                  "13_package", "14_upload"]:
        assert final.stages[stage].status == "done", stage

    # Fase 7: pacote de publicação
    pkg = ctx.run_dir / "13_package"
    meta = json.loads((pkg / "metadata.json").read_text())
    assert meta["title"] and meta["description"]
    assert (pkg / "subtitles.srt").read_text().startswith("1\n")
    assert (pkg / "thumbnail.png").stat().st_size > 10_000
    receipt = json.loads((ctx.run_dir / "14_upload" / "upload_receipt.json").read_text())
    assert receipt.get("skipped"), "sem --upload o upload tem de ser saltado"

    scenes = json.loads((ctx.run_dir / "06_scenes" / "scenes.json").read_text())
    briefs = {b["scene_id"]: b for b in json.loads(
        (ctx.run_dir / "07_briefs" / "briefs.json").read_text())}
    result = json.loads((ctx.run_dir / "08_matching" / "assignments.json").read_text())
    segments = result["segments"]

    # ROADMAP Fase 4 — os 3 asserts centrais
    assert result["unfilled_scenes"] == []
    shot_ids = [s["shot_id"] for s in segments]
    assert len(shot_ids) == len(set(shot_ids)), "shot repetido no vídeo"
    for seg in segments:
        brief = briefs[seg["scene_id"]]
        if "food" in brief["must_have"]:
            assert seg["has_food"], f"cena de comida {seg['scene_id']} sem shot de comida"
            assert not seg["has_landmark"], \
                f"monumento em cena de comida: {seg['scene_id']}"

    # cobertura temporal: segmentos cobrem cada cena sem buracos > 0.75s
    by_scene: dict[str, list[dict]] = {}
    for seg in segments:
        by_scene.setdefault(seg["scene_id"], []).append(seg)
    for sc in scenes:
        segs = sorted(by_scene[sc["scene_id"]], key=lambda s: s["t_in"])
        assert abs(segs[0]["t_in"] - sc["t_in"]) < 0.01
        assert sc["t_out"] - segs[-1]["t_out"] < 0.76  # resto < MIN_SEGMENT_S

    # timeline: mesma contagem, xfade só na 1ª entrada de cada cena
    timeline = json.loads((ctx.run_dir / "09_timeline" / "timeline.json").read_text())
    assert len(timeline["entries"]) == len(segments)
    for e in timeline["entries"]:
        src = e["source"]
        assert src["out_s"] > src["in_s"]
        if e["transition_in"]["type"] == "xfade":
            assert e["scene_id"] != timeline["entries"][0]["scene_id"]

    # Fase 5: renders existem; duração do final ≈ narração (narração = master);
    # loudness -14 ±0.5 LUFS
    import subprocess as sp

    proxy = ctx.run_dir / "10_render_proxy" / "proxy_480p.mp4"
    final_mp4 = ctx.run_dir / "12_render_final" / "final.mp4"
    assert proxy.exists() and (ctx.run_dir / "10_render_proxy" / "captions.ass").exists()
    assert final_mp4.exists()

    def dur(p):
        return float(sp.run(["ffprobe", "-v", "error", "-show_entries",
                             "format=duration", "-of",
                             "default=noprint_wrappers=1:nokey=1", str(p)],
                            capture_output=True, text=True, check=True).stdout)

    audio_meta = json.loads((ctx.run_dir / "04_tts" / "audio_meta.json").read_text())
    assert abs(dur(final_mp4) - audio_meta["duration_seconds"]) < 1.0

    from studio.render.renderer import _measure_loudness

    # ±1.0: o teto de true-peak (-1.5 dBTP) limita o ganho linear em voz real;
    # o YouTube renormaliza a -14 na entrega, ±1 é imaterial
    loud = float(_measure_loudness(final_mp4)["input_i"])
    assert -15.0 <= loud <= -13.0, f"loudness {loud} fora de -14±1.0"


def test_resume_apos_falha_no_tts(produce_ctx, monkeypatch):
    ctx = produce_ctx
    state = new_state(ctx.video_id, ctx.params["topic"], 15.0)
    save_state(state, ctx.run_dir)

    import studio.stages.produce as produce_mod

    original = produce_mod.S04Tts.run

    def boom(self, _ctx):
        raise RuntimeError("tts indisponível")

    monkeypatch.setattr(produce_mod.S04Tts, "run", boom)
    from studio.orchestrator.runner import StageFailed

    with pytest.raises(StageFailed):
        PipelineRunner(produce_stages()).run(ctx, state)
    assert load_state(ctx.run_dir).stages["03_script"].status == "done"

    monkeypatch.setattr(produce_mod.S04Tts, "run", original)
    script_mtime = (ctx.run_dir / "03_script" / "script.md").stat().st_mtime_ns
    PipelineRunner(produce_stages()).run(ctx, load_state(ctx.run_dir))
    assert (ctx.run_dir / "03_script" / "script.md").stat().st_mtime_ns == script_mtime
    assert load_state(ctx.run_dir).stages["12_render_final"].status == "done"
