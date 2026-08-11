"""Tests para is_workset_ready (UNICA FONTE AUTORITATIVA de READY).

Casos da spec §B (task 2026-08-11):
  A) target=25s, available=4s,   shots=1                  -> PARTIAL
  B) target=25s, available=30s,  shots=1, min_shots=4     -> PARTIAL
  C) target=25s, available=30s,  shots=5                  -> COVERED
  D) strict + sem confirmacao Vision                     -> UNCONFIRMED

Cobertura adicional:
  E) NOT_FOUND (available=0)
  F) Sem confirmed_index passado -> strict fica UNCONFIRMED (conservador)
  G) Mixed: COVERED + PARTIAL -> ready=False
  H) Mixed: COVERED + UNCONFIRMED (strict) -> ready=False
"""

from unittest.mock import MagicMock

from studio.matching.coverage_plan import (
    CoveragePlan,
    EntityCoverage,
    is_workset_ready,
)


def _make_entity(*, available_s=0.0, shots=0, min_shots=1,
                 required=25.0, target=25.0, strict=False,
                 canonical="Ribeira Porto", etype="place",
                 location="porto",
                 available_ids: set | None = None) -> EntityCoverage:
    return EntityCoverage(
        canonical_name=canonical,
        entity_type=etype,
        priority_score=0.5,
        mention_count=1,
        required_seconds=required,
        target_seconds=target,
        min_distinct_shots=min_shots,
        available_seconds=available_s,
        available_distinct_shots=shots,
        # UPSTREAM-FIX 2026-08-11: novo campo available_shot_ids.
        # Por defeito = set vazio (cenário sem medição). Tests específicos
        # passam-no explicitamente para validar overlap real.
        available_shot_ids=(set(available_ids) if available_ids is not None
                            else set()),
        available_files=shots,
        deficit_seconds=max(0.0, target - available_s),
        strict=strict,
        location=location,
    )


def _plan(*entities) -> CoveragePlan:
    return CoveragePlan(
        schema_version="1.0",
        topic="test",
        total_script_seconds=sum(e.target_seconds for e in entities) or 1.0,
        ranked_entities=list(entities),
    )


# ----------------- Caso A: target=25, available=4, shots=1 -> PARTIAL ------------
def test_case_a_partial_by_seconds():
    """target=25s mas so 4s disponiveis -> PARTIAL (secs_ok=False)."""
    ent = _make_entity(available_s=4.0, shots=1, target=25.0, min_shots=1)
    plan = _plan(ent)
    db = MagicMock()
    s = MagicMock()
    ready, per, _ = is_workset_ready(plan, db, s, remeasure=False)
    assert ready is False
    assert per["Ribeira Porto"] == "PARTIAL"


# ----------------- Caso B: target=25, available=30, shots=1, min_shots=4 -> PARTIAL
def test_case_b_partial_by_min_shots():
    """30s disponiveis mas so 1 shot distinto; min_shots=4 -> PARTIAL."""
    ent = _make_entity(
        available_s=30.0, shots=1, target=25.0,
        min_shots=4, canonical="Livraria Lello", etype="landmark",
    )
    plan = _plan(ent)
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(), remeasure=False)
    assert ready is False
    assert per["Livraria Lello"] == "PARTIAL"


# ----------------- Caso C: target=25, available=30, shots=5 -> COVERED ----------
# ----------------- Caso C: target=25, available=30, shots=5 -> COVERED ----------
def test_case_c_covered():
    ent = _make_entity(
        available_s=30.0, shots=5, target=25.0,
        min_shots=4, canonical="Francesinha", etype="food",
        available_ids={"s1", "s2", "s3", "s4", "s5"},
    )
    plan = _plan(ent)
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(), remeasure=False)
    assert ready is True
    assert per["Francesinha"] == "COVERED"


# ----------------- Caso D: strict + sem confirmacao -> UNCONFIRMED ---------------
def test_case_d_strict_no_confirmation():
    ent = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        strict=True, canonical="Francesinha", etype="food",
        available_ids={"s1", "s2", "s3", "s4", "s5"},
    )
    plan = _plan(ent)
    ready, per, strict_uncovered = is_workset_ready(
        plan, MagicMock(), MagicMock(), remeasure=False, confirmed_index={})
    assert ready is False
    assert per["Francesinha"] == "UNCONFIRMED"
    assert "Francesinha" in strict_uncovered


def test_case_d_strict_no_index_passed_is_conservative():
    """Sem confirmed_index passado (None) -> strict vira UNCONFIRMED (fail-closed)."""
    ent = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        strict=True, canonical="Livraria Lello", etype="landmark",
    )
    plan = _plan(ent)
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False, confirmed_index=None)
    assert ready is False
    assert per["Livraria Lello"] == "UNCONFIRMED"


def test_case_d_strict_with_confirmation_passes():
    """Strict + confirmed_index populated com shot REAL -> COVERED."""
    ent = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        strict=True, canonical="Francesinha", etype="food",
        available_ids={"shot_xyz_001", "shot_xyz_002"},
    )
    plan = _plan(ent)
    confirmed = {"francesinha": ["shot_xyz_001"]}
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False, confirmed_index=confirmed)
    assert ready is True
    assert per["Francesinha"] == "COVERED"


def test_overlap_rejects_unrelated_confirmed_shot():
    """UPSTREAM-FIX (code-reviewer #3): se confirmed_index aponta para um
    shot_id que NÃO está em available_shot_ids, gate devolve UNCONFIRMED
    mesmo com `len(confirmed) > 0`. Bug antigo: `len(confirmed)>0` era
    suficiente — dava COVERED mesmo com shot de outra entity."""
    ent = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        strict=True, canonical="Francesinha", etype="food",
        # medidos para Francesinha: só shot_001 e shot_002
        available_ids={"shot_001", "shot_002"},
    )
    plan = _plan(ent)
    # confirmed_index diz "francesinha" mas referencia shot_999 (Lello)
    confirmed = {"francesinha": ["shot_999"]}
    ready, per, strict_uncovered = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False, confirmed_index=confirmed)
    assert ready is False
    assert per["Francesinha"] == "UNCONFIRMED"
    assert "Francesinha" in strict_uncovered


# ----------------- Caso E: NOT_FOUND -----------------
def test_not_found_when_available_zero():
    ent = _make_entity(
        available_s=0.0, shots=0, target=25.0, min_shots=4,
        canonical="Estacao Sao Bento", etype="landmark", strict=True,
    )
    plan = _plan(ent)
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False, confirmed_index={"estacao sao bento": ["x"]})
    assert ready is False
    assert per["Estacao Sao Bento"] == "NOT_FOUND"


# ----------------- Caso G: Mixed COVERED + PARTIAL (nao-strict) -----------------
def test_mixed_covered_and_partial_by_seconds():
    a = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        canonical="Francesinha", etype="food",
        available_ids={"s1"})
    b = _make_entity(
        available_s=4.0, shots=1, target=25.0, min_shots=4,
        canonical="Ribeira", etype="place", strict=False)
    plan = _plan(a, b)
    ready, per, strict_uncovered = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False, confirmed_index=None)
    assert ready is False
    assert per["Francesinha"] == "COVERED"
    # secs_ok=False sobrepoe strict gate -> PARTIAL puro, nao UNCONFIRMED.
    assert per["Ribeira"] == "PARTIAL"
    assert "Ribeira" not in strict_uncovered


# ----------------- Caso H: Mixed COVERED + strict UNCONFIRMED -----------------
def test_mixed_covered_and_strict_unconfirmed():
    a = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        canonical="Francesinha", etype="food",
        available_ids={"s1"})
    b = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        canonical="Ponte Dom Luis", etype="landmark", strict=True)
    plan = _plan(a, b)
    ready, per, strict_uncovered = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False, confirmed_index={"francesinha": ["s1"]})
    assert ready is False
    assert per["Francesinha"] == "COVERED"
    # b passou secs+shots mas strict sem confirmacao -> UNCONFIRMED.
    assert per["Ponte Dom Luis"] == "UNCONFIRMED"
    assert "Ponte Dom Luis" in strict_uncovered
