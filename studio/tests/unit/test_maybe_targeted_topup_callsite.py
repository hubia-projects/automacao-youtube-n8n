"""Regressão item 14: TypeError engolido na chamada a _maybe_targeted_topup.

produce.py's S08 repair loop chamava:
    _maybe_targeted_topup(strict_v, plan, db, embedder, ctx.settings,
                          embedder=embedder, run_id=ctx.video_id)
contra a assinatura (strict_violations, plan, db, settings, *, embedder,
run_id) — 5 posicionais para 4 slots. TypeError sempre capturado pelo
`except Exception` do call site e logado como warning — o top-up dirigido
NUNCA corria em produção. Este teste chama a função exactamente como o
call site corrigido chama, provando que não há TypeError.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from studio.matching.alignment import Violation, ViolationType
from studio.matching.coverage_plan import EntityCoverage
from studio.stages.produce import _maybe_targeted_topup


def test_callsite_correcto_nao_levanta_typeerror():
    plan = MagicMock()
    ent = EntityCoverage(
        canonical_name="Livraria Lello", entity_type="landmark",
        priority_score=0.8, mention_count=1, required_seconds=10.0,
        target_seconds=12.5, min_distinct_shots=2, deficit_seconds=12.5,
        strict=True, location="Porto",
    )
    plan.ranked_entities = [ent]
    strict_v = [Violation(
        violation_type=ViolationType.ENTITY_COVERAGE_GAP,
        scene_id="s001", seg_index=0, t_in=0.0, t_out=5.0, shot_id="sh1",
        severity="strict",
        expected_entity="Livraria Lello", expected_entity_type="landmark",
    )]
    db = MagicMock()
    settings = MagicMock()
    settings.query_levels = 3
    settings.library_root = MagicMock()

    with patch("studio.library.sources.pexels.sweep", return_value=[]), \
         patch("studio.matching.coverage_plan.measure_coverage",
              side_effect=lambda e, d: e):
        # a chamada abaixo replica EXACTAMENTE o call site de produce.py
        # (4 posicionais + embedder/run_id keyword) — não deve levantar
        # TypeError (bug antigo: 5 posicionais, sempre engolido).
        touched = _maybe_targeted_topup(
            strict_v, plan, db, settings,
            embedder=MagicMock(), run_id="video-123",
        )
    assert touched == 1


def test_callsite_antigo_com_5_posicionais_levantava_typeerror():
    """Documenta o bug: a assinatura só aceita 4 posicionais — chamar com
    5 (o padrão antigo/quebrado) levanta TypeError."""
    import pytest

    plan = MagicMock()
    plan.ranked_entities = []
    with pytest.raises(TypeError):
        _maybe_targeted_topup(  # type: ignore[misc]
            [], plan, MagicMock(), MagicMock(), MagicMock(),
            embedder=MagicMock(), run_id="video-123",
        )
