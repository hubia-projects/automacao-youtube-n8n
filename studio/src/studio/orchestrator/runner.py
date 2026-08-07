"""Runner do DAG — ver ADR-0001.

Executa stages em ordem, salta os `done` (outputs existem + estado válido),
persiste run.json após cada stage. Fail-closed: falha tipada pára o run;
`studio resume` retoma no primeiro stage não-done.
"""

from __future__ import annotations

import logging
from pathlib import Path

from studio.llm.budget import BudgetExceeded, check_budget
from studio.orchestrator.stage import RunContext, Stage
from studio.orchestrator.state import (
    RunState,
    load_state,
    save_state,
    state_path,
    touch_stage_end,
    touch_stage_start,
)

log = logging.getLogger("studio.runner")


class StageFailed(RuntimeError):
    def __init__(self, stage_name: str, message: str):
        self.stage_name = stage_name
        super().__init__(f"{stage_name}: {message}")


class WaitingApproval(RuntimeError):
    """Run parado num gate humano — não é erro; resume após aprovação."""

    def __init__(self, stage_name: str, gate: str):
        self.stage_name = stage_name
        self.gate = gate
        super().__init__(f"{stage_name}: à espera de aprovação humana ({gate})")


def _outputs_ok(outputs: list[str]) -> bool:
    return bool(outputs) and all(Path(p).exists() for p in outputs)


class PipelineRunner:
    def __init__(self, stages: list[Stage]):
        # Ordem = ordem da lista; prefixos numéricos nos nomes documentam-na.
        self.stages = stages

    def run(self, ctx: RunContext, state: RunState) -> RunState:
        # run_dir absoluto: cron pode acordar num CWD arbitrário, e o _outputs_ok
        # exige paths que existam desde CWD — relativos partem sem aviso.
        ctx.run_dir = Path(ctx.run_dir).resolve()
        ctx.state = state  # único objeto de estado; só o runner grava run.json
        # params persistidos no run.json vencem defaults do CLI no resume
        ctx.params = {**ctx.params, **state.params}
        for stage in self.stages:
            rec = state.stage(stage.name)

            if rec.status == "done" and _outputs_ok(rec.outputs):
                log.info("skip %s (done)", stage.name)
                continue

            check_budget(state)  # breaker: exceder orçamento pára o run

            touch_stage_start(state, stage.name)
            save_state(state, ctx.run_dir)
            log.info("run  %s (tentativa %d)", stage.name, rec.attempts)

            try:
                result = stage.run(ctx)
            except BudgetExceeded:
                touch_stage_end(state, stage.name, "failed", error="budget_exceeded")
                save_state(state, ctx.run_dir)
                raise
            except Exception as exc:  # fail-closed: registar e parar
                touch_stage_end(state, stage.name, "failed", error=repr(exc))
                save_state(state, ctx.run_dir)
                raise StageFailed(stage.name, repr(exc)) from exc

            outputs = [str(p) for p in result.outputs]

            if result.status == "waiting_approval":
                touch_stage_end(state, stage.name, "waiting_approval",
                                cost_usd=result.cost_usd, outputs=outputs)
                save_state(state, ctx.run_dir)
                raise WaitingApproval(stage.name, result.notes or "gate")

            if result.status == "failed" or not _outputs_ok(outputs):
                error = result.notes or "outputs em falta ou inválidos"
                touch_stage_end(state, stage.name, "failed",
                                cost_usd=result.cost_usd, error=error)
                save_state(state, ctx.run_dir)
                raise StageFailed(stage.name, error)

            touch_stage_end(state, stage.name, "done",
                            cost_usd=result.cost_usd, outputs=outputs)
            save_state(state, ctx.run_dir)

        return state


def resume(ctx: RunContext, stages: list[Stage]) -> RunState:
    # mesmo motivo que em run(): state_path() é a primeira coisa tocada em
    # disco, e precisa de path absoluto para sobreviver ao CWD do cron.
    ctx.run_dir = Path(ctx.run_dir).resolve()
    if not state_path(ctx.run_dir).exists():
        raise FileNotFoundError(f"run.json não existe em {ctx.run_dir} — usa `studio run`")
    state = load_state(ctx.run_dir)
    return PipelineRunner(stages).run(ctx, state)
