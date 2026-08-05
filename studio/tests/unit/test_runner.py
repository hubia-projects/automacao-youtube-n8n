import pytest

from studio.orchestrator.runner import PipelineRunner, StageFailed, WaitingApproval
from studio.orchestrator.stage import RunContext, StageResult
from studio.orchestrator.state import load_state, new_state, save_state


class WriteStage:
    def __init__(self, name):
        self.name = name
        self.executions = 0

    def run(self, ctx: RunContext) -> StageResult:
        self.executions += 1
        out = ctx.stage_dir(self.name) / "out.txt"
        out.write_text("ok")
        return StageResult(status="done", outputs=[out], cost_usd=0.1)


class FailStage:
    name = "02_fail"

    def run(self, ctx: RunContext) -> StageResult:
        raise RuntimeError("boom")


class GateStage:
    name = "02_gate"

    def run(self, ctx: RunContext) -> StageResult:
        return StageResult(status="waiting_approval", notes="final")


class NoOutputStage:
    name = "02_semout"

    def run(self, ctx: RunContext) -> StageResult:
        return StageResult(status="done", outputs=[])  # viola fail-closed


def _fresh_state(ctx, budget=15.0):
    state = new_state(ctx.video_id, "", budget)
    save_state(state, ctx.run_dir)
    return state


def test_falha_para_o_run_e_persiste(ctx):
    s1 = WriteStage("01_ok")
    state = _fresh_state(ctx)
    with pytest.raises(StageFailed):
        PipelineRunner([s1, FailStage()]).run(ctx, state)

    persisted = load_state(ctx.run_dir)
    assert persisted.stages["01_ok"].status == "done"
    assert persisted.stages["02_fail"].status == "failed"
    assert "boom" in persisted.stages["02_fail"].error


def test_resume_salta_stages_done(ctx):
    s1 = WriteStage("01_ok")
    state = _fresh_state(ctx)
    with pytest.raises(StageFailed):
        PipelineRunner([s1, FailStage()]).run(ctx, state)
    assert s1.executions == 1

    # segunda passagem: stage 1 done → skip; substituímos o que falhava
    s2 = WriteStage("02_fail")  # mesmo nome, agora passa
    state = load_state(ctx.run_dir)
    PipelineRunner([s1, s2]).run(ctx, state)
    assert s1.executions == 1  # NÃO re-executado
    assert s2.executions == 1


def test_waiting_approval_para_sem_erro(ctx):
    state = _fresh_state(ctx)
    with pytest.raises(WaitingApproval):
        PipelineRunner([WriteStage("01_ok"), GateStage()]).run(ctx, state)
    persisted = load_state(ctx.run_dir)
    assert persisted.stages["02_gate"].status == "waiting_approval"


def test_done_sem_outputs_e_falha(ctx):
    state = _fresh_state(ctx)
    with pytest.raises(StageFailed):
        PipelineRunner([WriteStage("01_ok"), NoOutputStage()]).run(ctx, state)


def test_budget_breaker_bloqueia_proximo_stage(ctx):
    state = _fresh_state(ctx, budget=0.15)
    s1, s2 = WriteStage("01_a"), WriteStage("02_b")
    # s1 custa 0.1 < 0.15 → passa; antes de s2 o ledger (0.1) ainda < 0.15 → passa;
    # com budget 0.05 o breaker dispara logo antes de s2.
    PipelineRunner([s1]).run(ctx, state)
    state.cost_ledger.budget_usd = 0.05
    from studio.llm.budget import BudgetExceeded

    with pytest.raises(BudgetExceeded):
        PipelineRunner([s1, s2]).run(ctx, state)
    assert s2.executions == 0
