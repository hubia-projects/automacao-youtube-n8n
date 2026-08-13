"""Runner do DAG em ondas — ver ADR-0001 + Fase 3 (Sprint Optimização).

Stages agrupam-se em "waves": dentro de cada wave correm em paralelo via
ThreadPoolExecutor; waves correm sequencialmente. Mutações no RunState
(touch_stage_start/end, save_state, check_budget) são serializadas via
state_lock injected no RunContext (ctx.state_lock) — sem lock, duas threads
em paralelo corrompem run.json.

Backward compat: se passar `stages=[s1,s2,...]` é convertido para waves=[[s1],[s2],...]
equivalente a sequencial (mesmo comportamento do runner anterior).

Fail-closed: falha em qualquer stage aborta o run; outras waves não correm.
Re-run: `_outputs_ok(outputs)` no disco é a fonte de verdade; `studio resume`
salta stages com outputs já escritos (mesmo dentro de uma wave).
"""

from __future__ import annotations

import concurrent.futures
import logging
import threading
from pathlib import Path

# WORKAROUND IPv6 blackhole em redes onde Google APIs só respondem em IPv4.
# Python stdlib prefere IPv6 → hang de 60-120s em httpx/requests/urllib para
# generativelanguage.googleapis.com e Vertex. `curl` resolve via Happy
# Eyeballs (RFC 6555) com fallback rápido.
# Aplicar ANTES de qualquer import que toque em networking.
# Idempotente — pode ser chamado múltiplas vezes sem efeito.
from studio._net import apply_ipv4_only
apply_ipv4_only()

from studio.events import emit as emit_event
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
from studio.perf import Profiler

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
    def __init__(self, waves: list[list[Stage]] | list[Stage]):
        """Aceita waves=[[s1,s2],[s3]] (DAG paralelo) OU stages=[s1,s2,s3]
        (legacy sequencial — convertido em waves singleton).

        Distinguimos por estrutura: lista já-encapsulada tem waves[0] como
        list; legacy tem waves[0] como Stage. isinstance check é robusto
        mesmo quando waves[0] é MagicMock (legit ou test fixture).
        """
        if waves and isinstance(waves[0], list):
            self.waves: list[list[Stage]] = waves
        else:
            # legacy flat list → waves singleton (zero overhead)
            self.waves = [[s] for s in (waves or [])]
        # state_lock default: cada Runner cria o seu (testes injectam o seu).
        self.state_lock = threading.Lock()

    def _run_stage(self, stage: Stage, ctx: RunContext, state: RunState) -> None:
        """Corpo de uma stage (com lock no state mutations)."""
        rec = state.stage(stage.name)

        if rec.status == "done" and _outputs_ok(rec.outputs):
            log.info("skip %s (done)", stage.name)
            return

        # check_budget + touch_* + save_state protegidos pelo lock partilhado
        with self.state_lock:
            check_budget(state)
            touch_stage_start(state, stage.name)
            save_state(state, ctx.run_dir)
        log.info("run  %s (tentativa %d)", stage.name, rec.attempts)
        # item 2.2 (automation closure): stage_started — canal partilhado
        # terminal+frontend (item 24/25). Ponto único: cobre TODAS as
        # stages sem espalhar chamadas emit() por cada classe de stage.
        emit_event(ctx.run_dir, ctx.video_id, stage.name, "stage_started",
                  f"a correr {stage.name} (tentativa {rec.attempts})")

        try:
            result = stage.run(ctx)
        except BudgetExceeded:
            with self.state_lock:
                touch_stage_end(state, stage.name, "failed", error="budget_exceeded")
                save_state(state, ctx.run_dir)
            emit_event(ctx.run_dir, ctx.video_id, stage.name, "stage_failed",
                      "budget_exceeded", level="ERROR")
            raise
        except Exception as exc:
            with self.state_lock:
                touch_stage_end(state, stage.name, "failed", error=repr(exc))
                save_state(state, ctx.run_dir)
            emit_event(ctx.run_dir, ctx.video_id, stage.name, "stage_failed",
                      repr(exc), level="ERROR")
            raise StageFailed(stage.name, repr(exc)) from exc

        outputs = [str(p) for p in result.outputs]

        with self.state_lock:
            if result.status == "waiting_approval":
                touch_stage_end(state, stage.name, "waiting_approval",
                                cost_usd=result.cost_usd, outputs=outputs)
                save_state(state, ctx.run_dir)
            elif result.status == "failed" or not _outputs_ok(outputs):
                error = result.notes or "outputs em falta ou inválidos"
                touch_stage_end(state, stage.name, "failed",
                                cost_usd=result.cost_usd, error=error)
                save_state(state, ctx.run_dir)
            else:
                touch_stage_end(state, stage.name, "done",
                                cost_usd=result.cost_usd, outputs=outputs)
                save_state(state, ctx.run_dir)

        if result.status == "waiting_approval":
            emit_event(ctx.run_dir, ctx.video_id, stage.name, "waiting_approval",
                      result.notes or "gate", level="WARNING")
            raise WaitingApproval(stage.name, result.notes or "gate")
        if result.status == "failed" or not _outputs_ok(outputs):
            error = result.notes or "outputs em falta ou inválidos"
            emit_event(ctx.run_dir, ctx.video_id, stage.name, "stage_failed",
                      error, level="ERROR")
            raise StageFailed(stage.name, error)
        emit_event(ctx.run_dir, ctx.video_id, stage.name, "stage_completed",
                  result.notes or "done")

    def run(self, ctx: RunContext, state: RunState) -> RunState:
        # run_dir absoluto: cron pode acordar num CWD arbitrário, e o _outputs_ok
        # exige paths que existam desde CWD — relativos partem sem aviso.
        ctx.run_dir = Path(ctx.run_dir).resolve()
        ctx.state = state  # único objeto de estado; só o runner grava run.json
        ctx.state_lock = self.state_lock  # waves paralelas partilham este lock
        # params persistidos no run.json vencem defaults do CLI no resume
        ctx.params = {**ctx.params, **state.params}

        for wave_idx, wave in enumerate(self.waves, 1):
            if len(wave) == 1:
                # Sequencial: zero overhead de ThreadPoolExecutor.
                self._run_stage(wave[0], ctx, state)
                continue
            # Paralelo: N threads, cada uma chama _run_stage (com lock).
            log.info("wave %d: %d stages em paralelo — %s",
                     wave_idx, len(wave), [s.name for s in wave])
            with concurrent.futures.ThreadPoolExecutor(
                    max_workers=len(wave)) as ex:
                futures = {ex.submit(self._run_stage, stage, ctx, state): stage
                           for stage in wave}
                # as_completed propaga a primeira excepção: fail-fast na wave.
                for fut in concurrent.futures.as_completed(futures):
                    fut.result()  # levanta StageFailed / WaitingApproval / BudgetExceeded
        # Fase 1 Optimização — dump métricas em <run>/performance.json
        # + linha resumo PERF (8 maiores consumidores por ordem de tempo).
        # get_settings() corre lazily; se indisponível, desliga-se off.
        try:
            enabled = bool(getattr(ctx.settings, "perf_enabled", True))
        except Exception:
            enabled = True
        if enabled:
            Profiler.write(ctx.run_dir)
        emit_event(ctx.run_dir, ctx.video_id, "run", "run_completed",
                  "todas as waves concluídas")
        return state


def resume(ctx: RunContext, waves: list[list[Stage]] | list[Stage]) -> RunState:
    # mesmo motivo que em run(): state_path() é a primeira coisa tocada em
    # disco, e precisa de path absoluto para sobreviver ao CWD do cron.
    ctx.run_dir = Path(ctx.run_dir).resolve()
    if not state_path(ctx.run_dir).exists():
        raise FileNotFoundError(f"run.json não existe em {ctx.run_dir} — usa `studio run`")
    state = load_state(ctx.run_dir)
    return PipelineRunner(waves).run(ctx, state)
