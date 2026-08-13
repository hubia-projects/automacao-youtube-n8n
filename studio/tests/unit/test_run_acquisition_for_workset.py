"""Item 1.4/O (automation closure): run_acquisition_for_workset — o único
wrapper de aquisição que produção deve chamar (substitui
topup_for_plan_concurrent/_targeted_topup_for_entity/_maybe_targeted_topup/
assigner JIT — nenhum deles passava por acquire_for_deficits).
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from studio.library.acquisition import run_acquisition_for_workset
from studio.matching.coverage_plan import EntityCoverage, FILLER_ENTITY_TYPE


class _Spec:
    def __init__(self, canonical, requirement_id):
        self.canonical_entity = canonical
        self.requirement_id = requirement_id
        self.aliases = ()
        self.location = ""


def _ent(canon, strict, deficit, entity_type="landmark", priority=1.0):
    return EntityCoverage(
        canonical_name=canon, entity_type=entity_type, priority_score=priority,
        mention_count=1, required_seconds=10.0, target_seconds=10.0,
        min_distinct_shots=1, strict=strict, deficit_seconds=deficit,
        available_seconds=max(0.0, 10.0 - deficit),
    )


def _plan(entities):
    plan = MagicMock()
    plan.ranked_entities = entities
    return plan


def _ctx(specs):
    ctx = MagicMock()
    ctx.workflow_id = "wf-test"
    ctx.workset_id = "wf-test"
    by_canon = {s.canonical_entity: s for s in specs}
    ctx.req_by_canonical.side_effect = lambda c: by_canon.get(c)
    ctx.requirement_prompts = {}
    ctx.requirement_embeddings = {}
    ctx.visual_prompt_embeddings = {}
    return ctx


def test_sem_deficits_devolve_coverage_ready_sem_chamar_provider(tmp_path):
    ent = _ent("A", strict=True, deficit=0.0)
    plan = _plan([ent])
    ctx = _ctx([_Spec("A", "R01")])
    resolver_calls = []
    with patch("studio.library.acquisition.make_provider_resolver") as mock_mpr:
        mock_mpr.return_value = lambda q, lvl: resolver_calls.append(q) or []
        rep = run_acquisition_for_workset(
            plan, ctx, MagicMock(library_root=tmp_path), MagicMock(),
            MagicMock(library_root=tmp_path), requirement_index=MagicMock(),
        )
    assert rep.coverage_ready is True
    assert resolver_calls == []


def test_ordena_por_tier_strict_antes_de_filler(tmp_path):
    strict_ent = _ent("Livraria Lello", strict=True, deficit=30.0)
    filler_ent = _ent("filler:porto", strict=False, deficit=50.0,
                      entity_type=FILLER_ENTITY_TYPE, priority=-1.0)
    plan = _plan([filler_ent, strict_ent])  # filler primeiro na lista de entrada
    ctx = _ctx([_Spec("Livraria Lello", "R01"), _Spec("filler:porto", "R02")])

    queries_order = []

    def fake_resolver(query, level):
        queries_order.append(query)
        return []

    with patch("studio.library.acquisition.make_provider_resolver",
              return_value=fake_resolver):
        run_acquisition_for_workset(
            plan, ctx, MagicMock(library_root=tmp_path), MagicMock(),
            MagicMock(library_root=tmp_path, query_levels=4),
            requirement_index=MagicMock(),
            max_iterations=1,
        )
    assert queries_order, "resolver devia ter sido chamado pelo menos 1x"
    assert "Livraria Lello" in queries_order[0], (
        f"strict deve ser tentado antes do filler (maior deficit tambem, "
        f"mas o tier manda) — primeira query foi {queries_order[0]!r}"
    )


def test_wrapper_chama_acquire_for_deficits_com_requirement_index_e_query_history(
    tmp_path,
):
    ent = _ent("A", strict=True, deficit=20.0)
    plan = _plan([ent])
    ctx = _ctx([_Spec("A", "R01")])
    ri = MagicMock()
    qh = MagicMock()

    captured = {}

    def fake_acquire(**kwargs):
        captured.update(kwargs)
        from studio.library.acquisition import AcquisitionReport
        return AcquisitionReport(coverage_status={}, coverage_ready=True)

    with patch("studio.library.acquisition.make_provider_resolver",
              return_value=lambda q, lvl: []), \
         patch("studio.library.acquisition.acquire_for_deficits",
              side_effect=fake_acquire):
        run_acquisition_for_workset(
            plan, ctx, MagicMock(library_root=tmp_path), MagicMock(),
            MagicMock(library_root=tmp_path), requirement_index=ri,
            query_history=qh,
        )
    assert captured["requirement_index"] is ri
    assert captured["query_history_db"] is qh
    assert captured["deficit_items"][0].canonical_entity == "A"
