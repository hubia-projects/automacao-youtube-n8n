"""Pipeline dummy de 3 stages — teste E2E da Fase 1 (ROADMAP).

Valida: execução ordenada, checkpoint por stage, falha fail-closed,
resume sem re-executar stages done, gate humano.

O stage 2 falha na primeira tentativa (na ausência do ficheiro-flag
`allow_step2`), simulando um crash a meio do run. Cada stage incrementa
um contador em disco — prova de quantas vezes realmente executou.
"""

from __future__ import annotations

from pathlib import Path

from studio.approvals.gates import request_gate
from studio.orchestrator.stage import RunContext, StageResult


def _bump_counter(path: Path) -> int:
    count = int(path.read_text()) + 1 if path.exists() else 1
    path.write_text(str(count))
    return count


class Step1Write:
    name = "01_write"

    def run(self, ctx: RunContext) -> StageResult:
        d = ctx.stage_dir(self.name)
        _bump_counter(d / "exec_count")
        out = d / "hello.txt"
        out.write_text("olá do stage 1\n", encoding="utf-8")
        return StageResult(status="done", outputs=[out], cost_usd=0.01)


class Step2FlakyOnce:
    name = "02_flaky"

    def run(self, ctx: RunContext) -> StageResult:
        d = ctx.stage_dir(self.name)
        _bump_counter(d / "exec_count")
        flag = d / "allow_step2"
        if not flag.exists():
            flag.write_text("na próxima tentativa passo\n")
            raise RuntimeError("falha simulada (primeira tentativa)")
        out = d / "result.txt"
        out.write_text("stage 2 concluído à segunda\n", encoding="utf-8")
        return StageResult(status="done", outputs=[out], cost_usd=0.02)


class Step3Gate:
    name = "03_gate"

    def run(self, ctx: RunContext) -> StageResult:
        d = ctx.stage_dir(self.name)
        _bump_counter(d / "exec_count")
        # Round-trip de aprovação (em mock auto-aprova). Estado partilhado
        # via ctx.state — o runner é o único que grava run.json.
        request_gate(ctx.settings, ctx.state, "dummy_final",
                     "Pipeline dummy: aprovar conclusão?", ["approve", "reject"])
        out = d / "approved.txt"
        out.write_text(f"gate: {ctx.state.gates['dummy_final']}\n", encoding="utf-8")
        return StageResult(status="done", outputs=[out])


def dummy_stages() -> list:
    return [Step1Write(), Step2FlakyOnce(), Step3Gate()]
