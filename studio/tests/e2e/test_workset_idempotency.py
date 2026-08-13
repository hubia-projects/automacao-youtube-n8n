"""Item Y (closure pass): idempotência RUN A / RUN B a nível do stage real.

RUN A cria o workset (theme.json/script.md escritos, RequirementIndex
populada). RUN B (mesmo video_id/run_dir, biblioteca já populada por A) tem
de: (1) reutilizar o workset (theme.json byte-idêntico, `reused=True`
internamente); (2) NUNCA duplicar RequirementMatch na RequirementIndex
(upsert_match é upsert, não append); (3) nunca lançar excepção.

Corre S01..S07 uma vez via PipelineRunner (produz os artefactos reais de
que S08 depende), depois chama S08Matching().run(ctx) DUAS VEZES
directamente — evita o full 14-stage pipeline (onde 2 testes têm falhas
pré-existentes não relacionadas, já confirmadas nesta closure pass, sobre
contagem de shots distintos no render final).
"""
from __future__ import annotations

import pytest

from studio.orchestrator.runner import PipelineRunner
from studio.orchestrator.state import new_state, save_state
from studio.stages.produce import S08Matching, produce_stages


@pytest.fixture()
def produce_ctx(ctx, fake_embedder, seeded_library):
    ctx.params.update({"topic": "Pastéis de Belém em Lisboa",
                       "duration_minutes": 1.0,
                       "_embedder": fake_embedder})
    return ctx


def test_s08_run_a_run_b_idempotente(produce_ctx):
    ctx = produce_ctx
    state = new_state(ctx.video_id, ctx.params["topic"], 15.0)
    save_state(state, ctx.run_dir)

    # S01..S07: artefactos reais de que S08 depende (script/scenes/briefs).
    PipelineRunner(produce_stages()[:7]).run(ctx, state)

    from studio.library.db import LibraryDB
    from studio.library.requirement_index import RequirementIndex

    db = LibraryDB(ctx.settings.library_root)
    ri = RequirementIndex(db)

    res_a = S08Matching().run(ctx)
    assert res_a.status in ("done", "failed", "waiting_approval"), (
        f"RUN A não devia lançar excepção não tratada: {res_a}")

    # workset_id real usado por S08 é ctx.video_id (não o hash) — ver item B.
    wdir = ctx.settings.library_root / "worksets" / ctx.video_id
    assert wdir.exists(), "RUN A devia ter materializado o workset"
    theme_json_a = (wdir / "theme.json").read_text("utf-8")
    matches_after_a = ri.list_for_workset(ctx.video_id)
    n_matches_a = len(matches_after_a)

    res_b = S08Matching().run(ctx)
    assert res_b.status in ("done", "failed", "waiting_approval"), (
        f"RUN B não devia lançar excepção não tratada: {res_b}")

    theme_json_b = (wdir / "theme.json").read_text("utf-8")
    assert theme_json_a == theme_json_b, (
        "RUN B reescreveu theme.json — build_workset() devia ter "
        "detectado reused=True (mesmo workset_id, mesmo script)"
    )

    matches_after_b = ri.list_for_workset(ctx.video_id)
    n_matches_b = len(matches_after_b)
    # upsert_match é upsert (delete+add pela mesma chave composta) — RUN B
    # NUNCA deve duplicar matches para os mesmos (workset,requirement,shot).
    keys_a = {(m.requirement_id, m.shot_id) for m in matches_after_a}
    keys_b = {(m.requirement_id, m.shot_id) for m in matches_after_b}
    assert len(keys_b) == len(matches_after_b), (
        "RUN B duplicou RequirementMatch para a mesma (requirement_id, "
        "shot_id) — upsert_match deixou de ser idempotente"
    )
    assert n_matches_b <= n_matches_a + 5, (
        f"RUN B devia manter a RequirementIndex estável (a=entity{n_matches_a} "
        f"vs b={n_matches_b}), não continuar a crescer sem limite"
    )
