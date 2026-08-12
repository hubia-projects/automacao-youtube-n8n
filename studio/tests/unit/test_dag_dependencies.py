"""Testes do DAG pós-fix Fase 1 — dependências estruturais entre stages.

Cobre:
1. S05 vem DEPOIS de S04 (wave ordering).
2. S06 vem DEPOIS de S05 (S06 lê words.json).
3. S07 vem DEPOIS de S06 (S07 lê scenes.json).
4. S08 vem DEPOIS de S07 (S08 lê briefs.json).
5. Não há wave com paralelismo inválido (cada wave tem 1 stage ou todas
   garantem "0 dependência cruzada" — após fix Fase 1, todas as waves
   são sequenciais).
6. produce_stages() produz wave count == nº stages (1:1).
7. O pipeline.run(dummy_stages_flat) verifica que Stages artificiais
   na MESMA wave arrancam depois do wave anterior terminar (lock-state).
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from studio.orchestrator.runner import PipelineRunner
from studio.orchestrator.stage import RunContext, StageResult
from studio.stages.produce import produce_stages


def _stage_names(stage_classes_waves):
    """Converte list[list[Stage]] em todos os nomes como surge na ordem
    das waves (tendo cada wave na sua lista)."""
    flat = []
    for wave in stage_classes_waves:
        for stg in wave:
            flat.append(stg.name)
    return flat


def test_dag_wave_count_matches_n_stages():
    """Depois do fix Fase 1: cada stage = 1 wave. Zero paralelismo espúrio."""
    waves = produce_stages()
    names = _stage_names(waves)
    # 14 stages, cada um na sua wave → 14 waves cada com 1 stage
    assert len(waves) == len(names) == 14
    # Cada wave = exactamente 1 stage (sem paralelismo inválido)
    for w in waves:
        assert len(w) == 1, f"wave com paralelismo inválido: {len(w)} stages"


def test_dag_s05_after_s04():
    waves = produce_stages()
    flat = _stage_names(waves)
    i04 = flat.index("04_tts")
    i05 = flat.index("05_timestamps")
    assert i04 < i05, "S05 deve correr DEPOIS de S04 (consome narration.wav)"


def test_dag_s06_after_s05():
    """S06 lê 05_timestamps/words.json — não pode arrancar antes de S05 done."""
    waves = produce_stages()
    flat = _stage_names(waves)
    assert flat.index("05_timestamps") < flat.index("06_scenes")


def test_dag_s07_after_s06():
    """S07 lê 06_scenes/scenes.json — não pode arrancar antes de S06 done."""
    waves = produce_stages()
    flat = _stage_names(waves)
    assert flat.index("06_scenes") < flat.index("07_briefs")


def test_dag_s08_after_s07():
    """S08 lê 07_briefs/briefs.json — não pode arrancar antes de S07 done."""
    waves = produce_stages()
    flat = _stage_names(waves)
    assert flat.index("07_briefs") < flat.index("08_matching")


def test_dag_no_wave_with_parallel_invalid_pairs():
    """Nenhuma wave combina duas stages em paralelo. Verificação
    estrutural: para cada par (i, i+1) plano de mat[i], mat[i+1]
    não podem partilhar artefatos de input (cada uma na sua wave)."""
    waves = produce_stages()
    flat = _stage_names(waves)
    # Inputs por stage (mapa explícito após auditoria 2026-08-08):
    inputs = {
        "01_topic": [],
        "02_research": ["01_topic"],
        "03_script": ["02_research"],
        "04_tts": ["03_script"],
        "05_timestamps": ["04_tts"],
        "06_scenes": ["05_timestamps"],
        "07_briefs": ["06_scenes"],
        "08_matching": ["07_briefs"],
        "09_timeline": ["08_matching"],
        "10_render_proxy": ["09_timeline"],
        "11_review": ["10_render_proxy"],
        "12_render_final": ["11_review"],
        "13_package": ["12_render_final"],
        "14_upload": ["13_package"],
    }
    # Cada wave acaba onde começa a próxima (flat N=waves=stages).
    for wave_name, deps in inputs.items():
        idx = flat.index(wave_name)
        for dep in deps:
            assert flat.index(dep) < idx, \
                f"DAG inválido: {wave_name} precisa de {dep} mas aparece antes"


def test_dag_pipeline_runner_rejects_wave_smaller_than_input(tmp_path, monkeypatch):
    """Demonstra que o runner CONSIDERA outputs já escritos como done.
    Quando wave tem 1 stage e essa stage é pré-marcada done, salta-a
    (caching do resume)."""
    from studio.orchestrator import runner as runner_mod
    from studio.orchestrator.state import new_state
    # settings stub
    settings = MagicMock()
    settings.budget_usd_per_run = 50.0
    settings.perf_enabled = False  # evita Profiler.write em tmp
    settings.runs_root = tmp_path
    ctx = RunContext(video_id="dag-test", run_dir=tmp_path / "r",
                     settings=settings, params={})
    state = new_state("dag-test", "topic", 50.0)
    # Simula S03 com output em disco (resume salta)
    s_a = MagicMock(name="03_script")
    out = ctx.run_dir / "03_script" / "x.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("ok", "utf-8")
    s_a.name = "03_script"
    s_a.run = MagicMock(return_value=StageResult(status="done", outputs=[out]))
    # FIX KeyError: Pydantic v2 NÃO auto-vivifica `state.stages[name]` —
    # lançar KeyError em vez disso. Usar API pública `state.stage(name)`
    # (get-or-create), exactamente como o `runner._run_stage` faz.
    rec = state.stage("03_script")
    rec.status = "done"
    rec.outputs = [str(out)]
    rec.finished_at = "2026-08-08T00:00:00+00:00"

    monkeypatch.setattr(runner_mod, "check_budget", lambda s: None)
    runner = PipelineRunner([[s_a]])
    runner.run(ctx, state)
    # MagicMock.run NÃO foi chamado (resume salta)
    assert not s_a.run.called


def test_dag_wave_chain_finishes_inputs_before_next(tmp_path, monkeypatch):
    """Embutido nos testes acima: proof of life que stages sequenciais no
    DAG FUNCIONAM via fixtures SimpleNamespace. Aqui validamos que
    PipelineRunner chama stages em ordem."""
    from studio.orchestrator.state import new_state
    from studio.orchestrator import runner as runner_mod

    settings = MagicMock()
    settings.budget_usd_per_run = 500.0
    settings.perf_enabled = False
    settings.runs_root = tmp_path
    monkeypatch.setattr(runner_mod, "check_budget", lambda s: None)

    class _Recording:
        def __init__(self, name):
            self.name = name
            self.calls = []

        def run(self, ctx):
            self.calls.append(time.perf_counter())
            # FIX (_outputs_ok fails otherwise): a fixture precisa ESCREVER
            # o ficheiro em disco antes de devolver — o runner considera
            # StageResult.outputs como outputs em falta se Path(p).exists()
            # for False.
            out = ctx.stage_dir(self.name) / "x"
            out.write_text("ok", "utf-8")
            return StageResult(status="done", outputs=[out])

    import time
    stages = [MagicMock(name=n) for n in
              ["03_script", "04_tts", "05_timestamps"]]
    for i, stg in enumerate(stages):
        stg.name = ["03_script", "04_tts", "05_timestamps"][i]
        r = _Recording(stg.name)
        stg.run = MagicMock(side_effect=r.run)
        stg._recorder = r

    ctx = RunContext(video_id="chain", run_dir=tmp_path / "r",
                     settings=settings, params={})
    state = new_state("chain", "t", 500.0)
    waves = [[s] for s in stages]
    PipelineRunner(waves).run(ctx, state)
    # Cada stage corre 1 vez, na ordem
    assert all(s.run.called for s in stages)
    times = [s._recorder.calls[0] for s in stages]
    assert times == sorted(times), "stages devem correr em ordem crescente"
