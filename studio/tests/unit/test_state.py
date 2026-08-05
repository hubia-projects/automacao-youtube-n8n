from studio.orchestrator.state import (
    load_state,
    new_state,
    save_state,
    state_path,
    touch_stage_end,
    touch_stage_start,
)


def test_roundtrip_atomic(tmp_path):
    state = new_state("vid1", "Lisboa gastronomia", 15.0)
    save_state(state, tmp_path)

    assert state_path(tmp_path).exists()
    assert not (tmp_path / "run.json.tmp").exists()  # tmp removido pelo rename

    loaded = load_state(tmp_path)
    assert loaded.video_id == "vid1"
    assert loaded.topic == "Lisboa gastronomia"
    assert loaded.cost_ledger.budget_usd == 15.0


def test_ledger_acumula_custos(tmp_path):
    state = new_state("vid1", "", 15.0)
    touch_stage_start(state, "01_a")
    touch_stage_end(state, "01_a", "done", cost_usd=0.5, outputs=["x"])
    touch_stage_start(state, "02_b")
    touch_stage_end(state, "02_b", "done", cost_usd=0.25, outputs=["y"])

    assert state.cost_ledger.total_usd == 0.75
    assert state.cost_ledger.by_stage == {"01_a": 0.5, "02_b": 0.25}
    assert state.stage("01_a").attempts == 1


def test_tentativas_incrementam(tmp_path):
    state = new_state("vid1", "", 15.0)
    touch_stage_start(state, "01_a")
    touch_stage_end(state, "01_a", "failed", error="boom")
    touch_stage_start(state, "01_a")
    assert state.stage("01_a").attempts == 2
