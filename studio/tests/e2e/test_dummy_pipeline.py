"""Teste E2E de saída da Fase 1 (ROADMAP):

pipeline dummy de 3 stages — stage 2 falha → `resume` completa sem refazer
o stage 1; round-trip de aprovação (mock Telegram auto-aprova).
"""

import pytest

from studio.orchestrator.runner import PipelineRunner, StageFailed, resume
from studio.orchestrator.state import load_state, new_state, save_state
from studio.stages.dummy import dummy_stages


def _exec_count(ctx, stage_name):
    return int((ctx.run_dir / stage_name / "exec_count").read_text())


def test_fase1_e2e_falha_resume_gate(ctx):
    state = new_state(ctx.video_id, "dummy", ctx.settings.budget_usd_per_run)
    save_state(state, ctx.run_dir)

    # 1º run: stage 2 falha (simulação de crash a meio)
    with pytest.raises(StageFailed):
        PipelineRunner(dummy_stages()).run(ctx, state)

    persisted = load_state(ctx.run_dir)
    assert persisted.stages["01_write"].status == "done"
    assert persisted.stages["02_flaky"].status == "failed"
    assert _exec_count(ctx, "01_write") == 1
    assert _exec_count(ctx, "02_flaky") == 1

    # resume: completa tudo SEM re-executar o stage 1
    resume(ctx, dummy_stages())

    final = load_state(ctx.run_dir)
    assert final.stages["01_write"].status == "done"
    assert final.stages["02_flaky"].status == "done"
    assert final.stages["03_gate"].status == "done"

    assert _exec_count(ctx, "01_write") == 1  # NÃO refeito
    assert _exec_count(ctx, "02_flaky") == 2  # refeito (tinha falhado)
    assert _exec_count(ctx, "03_gate") == 1

    # gate decidido (mock auto-aprova) e registado no estado
    assert final.gates["dummy_final"] == "approve"
    # ledger acumulou custos dos stages
    assert final.cost_ledger.total_usd == pytest.approx(0.03)
    # artefactos existem
    assert (ctx.run_dir / "01_write" / "hello.txt").exists()
    assert (ctx.run_dir / "03_gate" / "approved.txt").read_text().strip() == "gate: approve"


def test_resume_e_idempotente_depois_de_concluido(ctx):
    state = new_state(ctx.video_id, "dummy", 15.0)
    save_state(state, ctx.run_dir)
    with pytest.raises(StageFailed):
        PipelineRunner(dummy_stages()).run(ctx, state)
    resume(ctx, dummy_stages())

    # correr resume outra vez: tudo done → nenhum stage re-executa
    resume(ctx, dummy_stages())
    assert _exec_count(ctx, "01_write") == 1
    assert _exec_count(ctx, "02_flaky") == 2
    assert _exec_count(ctx, "03_gate") == 1
