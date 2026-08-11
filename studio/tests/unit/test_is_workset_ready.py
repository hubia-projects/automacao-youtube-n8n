"""Tests para is_workset_ready (UNICA FONTE AUTORITATIVA de READY).

Spec task 2026-08-11 §B:
  A) target=25s, available=4s,   shots=1                  -> PARTIAL
  B) target=25s, available=30s,  shots=1, min_shots=4     -> PARTIAL
  C) target=25s, available=30s,  shots=5                  -> COVERED
  D) strict + sem confirmacao Vision                     -> UNCONFIRMED

Spec §P1 strict (3 casos):
  1) 50s semantic / 5 shots / 1 confirmado (10s)        -> UNCONFIRMED
     (spec §P1: strict insuficiente -> UNCONFIRMED, NAO PARTIAL)
  2) 55s confirmados / 5 shots / target=48.75 / min=5  -> COVERED
  3) 60s confirmados / 3 shots / min=5                 -> UNCONFIRMED
     (strict insuficiente -> UNCONFIRMED, NAO PARTIAL)
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
    ent = EntityCoverage(
        canonical_name=canonical,
        entity_type=etype,
        priority_score=0.5,
        mention_count=1,
        required_seconds=required,
        target_seconds=target,
        min_distinct_shots=min_shots,
        available_seconds=available_s,
        available_distinct_shots=shots,
        available_shot_ids=(set(available_ids) if available_ids is not None
                            else set()),
        available_files=shots,
        deficit_seconds=max(0.0, target - available_s),
        strict=strict,
        location=location,
    )
    return ent


def _plan(*entities) -> CoveragePlan:
    return CoveragePlan(
        schema_version="1.0",
        topic="test",
        total_script_seconds=sum(e.target_seconds for e in entities) or 1.0,
        ranked_entities=list(entities),
    )


# ----------------- Caso A (spec §B): target=25, available=4, shots=1 -> PARTIAL ----
def test_case_a_partial_by_seconds():
    ent = _make_entity(available_s=4.0, shots=1, target=25.0, min_shots=1)
    plan = _plan(ent)
    ready, per, _ = is_workset_ready(plan, MagicMock(), MagicMock(), remeasure=False)
    assert ready is False
    assert per["Ribeira Porto"] == "PARTIAL"


# ----------------- Caso B (spec §B): target=25, available=30, shots=1, min=4 -> PARTIAL
def test_case_b_partial_by_min_shots():
    ent = _make_entity(
        available_s=30.0, shots=1, target=25.0,
        min_shots=4, canonical="Livraria Lello", etype="landmark",
    )
    plan = _plan(ent)
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(), remeasure=False)
    assert ready is False
    assert per["Livraria Lello"] == "PARTIAL"


# ----------------- Caso C (spec §B): target=25, available=30, shots=5 -> COVERED ----
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


# ----------------- Caso D (spec §B): strict + sem confirmacao -> UNCONFIRMED ---
def test_case_d_strict_no_confirmation():
    ent = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        strict=True, canonical="Francesinha", etype="food",
        available_ids={"s1", "s2", "s3", "s4", "s5"},
    )
    # mock durations para simular 5 shots disponíveis (~6s cada)
    ent._per_shot_durations = {f"s{i}": 6.0 for i in range(1, 6)}
    plan = _plan(ent)
    ready, per, strict_uncovered = is_workset_ready(
        plan, MagicMock(), MagicMock(), remeasure=False, confirmed_index={})
    assert ready is False
    assert per["Francesinha"] == "UNCONFIRMED"
    assert "Francesinha" in strict_uncovered


def test_case_d_strict_no_index_passed_is_conservative():
    ent = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        strict=True, canonical="Lello Strict", etype="landmark",
        available_ids={"s1", "s2", "s3", "s4", "s5"},
    )
    ent._per_shot_durations = {f"s{i}": 6.0 for i in range(1, 6)}
    plan = _plan(ent)
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(), remeasure=False, confirmed_index=None)
    assert ready is False
    assert per["Lello Strict"] == "UNCONFIRMED"


def test_case_d_strict_with_confirmation_passes():
    """spec §P1: 5 shots confirmados com _per_shot_durations suficient
    -> strict_secs >= target E strict_shots >= min -> COVERED."""
    canonical = "Francesinha C"
    confirmed_ids = [f"shot_c_{i}" for i in range(1, 6)]
    ent = _make_entity(
        available_s=50.0, shots=5, target=25.0, min_shots=4,
        strict=True, canonical=canonical, etype="food",
        available_ids=set(confirmed_ids),
    )
    # 5 shots confirmados de 10s cada = 50s total (cobre target=25)
    ent._per_shot_durations = {sid: 10.0 for sid in confirmed_ids}
    plan = _plan(ent)
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False, confirmed_index={"francesinha c": confirmed_ids})
    assert ready is True
    assert per[canonical] == "COVERED"


def test_overlap_rejects_unrelated_confirmed_shot():
    """Strict + confirmed_index aponta para fora do available_shot_ids
    -> UNCONFIRMED (overlap Vazio; mesmo se confirmed_index nao vazio)."""
    canonical = "Francesinha O"
    ent = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        strict=True, canonical=canonical, etype="food",
        available_ids={"shot_001", "shot_002"},
    )
    ent._per_shot_durations = {"shot_001": 15.0, "shot_002": 15.0}
    plan = _plan(ent)
    confirmed = {"francesinha o": ["shot_999"]}    # outro shot, fora
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False, confirmed_index=confirmed)
    assert ready is False
    assert per[canonical] == "UNCONFIRMED"


def test_not_found_when_available_zero():
    """Strict mas com available_seconds = 0 (biblioteca vazia para a entity):
    -> NOT_FOUND (nem sequer há candidatos semânticos)."""
    ent = _make_entity(
        available_s=0.0, shots=0, target=25.0, min_shots=4,
        canonical="Sao Bento Strict", etype="landmark", strict=True,
    )
    plan = _plan(ent)
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False, confirmed_index={"sao bento strict": ["x"]})
    assert ready is False
    assert per["Sao Bento Strict"] == "NOT_FOUND"


def test_mixed_covered_and_partial_by_seconds():
    a = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        canonical="Francesinha Mixed", etype="food", available_ids={"s1"})
    b = _make_entity(
        available_s=4.0, shots=1, target=25.0, min_shots=4,
        canonical="Ribeira Mixed", etype="place", strict=False)
    plan = _plan(a, b)
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False, confirmed_index=None)
    assert ready is False
    assert per["Francesinha Mixed"] == "COVERED"
    assert per["Ribeira Mixed"] == "PARTIAL"


def test_mixed_covered_and_strict_unconfirmed():
    a = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        canonical="Francesinha M2", etype="food",
        available_ids={"s1", "s2", "s3", "s4", "s5"})
    a._per_shot_durations = {f"s{i}": 6.0 for i in range(1, 6)}
    b = _make_entity(
        available_s=30.0, shots=5, target=25.0, min_shots=4,
        canonical="Ponte D Luis", etype="landmark", strict=True,
        available_ids={"p1", "p2", "p3", "p4", "p5"})
    b._per_shot_durations = {f"p{i}": 6.0 for i in range(1, 6)}
    plan = _plan(a, b)
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False,
        # Francesinha M2 confirmado, Ponte D Luis NAO
        confirmed_index={"francesinha m2": ["s1"]})
    assert ready is False
    assert per["Francesinha M2"] == "COVERED"
    assert per["Ponte D Luis"] == "UNCONFIRMED"


# ===========================================================
# CASO 1 (spec §P1):
#   50s semantic footage, 5 shots, 1 shot confirmado (10s).
#   Para entities strict, APENAS footage confirmado conta.
#   strict_secs=10 < target=48.75 -> UNCONFIRMED (spec diz UNCONFIRMED,
#   NAO PARTIAL; strict nunca pode ser só PARTIAL).
# ===========================================================
def test_strict_caso_1_partial_by_overlap():
    canonical = "Francesinha C1"
    ent = _make_entity(
        available_s=50.0, shots=5, target=48.75, min_shots=5,
        strict=True, canonical=canonical, etype="food",
        available_ids={"shot_a", "shot_b", "shot_c", "shot_d", "shot_e"},
    )
    # Cache per-shot durações (total 50s semantic; 1 confirmado = 10s)
    ent._per_shot_durations = {
        "shot_a": 10.0, "shot_b": 10.0, "shot_c": 10.0,
        "shot_d": 10.0, "shot_e": 10.0,
    }
    plan = _plan(ent)
    ready, per, strict_uncovered = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False,
        confirmed_index={"francesinha c1": ["shot_a"]},   # 1 confirmado
    )
    assert ready is False
    # secs_ok = 10 >= 48.75 -> False; shots_ok = 1 >= 5 -> False
    # spec §P1 strict: insuficiente -> UNCONFIRMED (NAO PARTIAL)
    assert per[canonical] == "UNCONFIRMED"
    assert canonical in strict_uncovered
    assert ent.strict_shot_ids == {"shot_a"}
    assert ent.strict_available_seconds == 10.0
    assert ent.strict_available_distinct_shots == 1


# ===========================================================
# CASO 2 (spec §P1):
#   55s confirmados, 5 shots confirmados / target=48.75 / min=5
#   strict_secs=55 >= target, strict_shots=5 >= min -> COVERED.
# ===========================================================
def test_strict_caso_2_covered():
    canonical = "Francesinha C2"
    confirmed_ids = ["shot_a", "shot_b", "shot_c", "shot_d", "shot_e"]
    ent = _make_entity(
        available_s=55.0, shots=5, target=48.75, min_shots=5,
        strict=True, canonical=canonical, etype="food",
        available_ids=set(confirmed_ids),
    )
    # 5 shots confirmados somam 55s (e.g. 11s cada).
    ent._per_shot_durations = {
        "shot_a": 11.0, "shot_b": 11.0, "shot_c": 11.0,
        "shot_d": 11.0, "shot_e": 11.0,
    }
    plan = _plan(ent)
    ready, per, _ = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False,
        confirmed_index={"francesinha c2": confirmed_ids},
    )
    assert ready is True
    assert per[canonical] == "COVERED"
    assert ent.strict_available_seconds == 55.0
    assert ent.strict_available_distinct_shots == 5


# ===========================================================
# CASO 3 (spec §P1):
#   60s confirmados, 3 shots confirmados / min=5
#   strict_secs=60 >= target, strict_shots=3 < min=5 -> UNCONFIRMED.
# ===========================================================
def test_strict_caso_3_partial_by_min_shots():
    canonical = "Francesinha C3"
    ent = _make_entity(
        available_s=80.0, shots=5, target=48.75, min_shots=5,
        strict=True, canonical=canonical, etype="food",
        available_ids={"shot_a", "shot_b", "shot_c", "shot_d", "shot_e"},
    )
    # 5 shots semanticamente (sum 80s) mas só 3 confirmados (60s).
    ent._per_shot_durations = {
        "shot_a": 20.0, "shot_b": 20.0, "shot_c": 20.0,
        "shot_d": 10.0, "shot_e": 10.0,
    }
    plan = _plan(ent)
    ready, per, strict_uncovered = is_workset_ready(
        plan, MagicMock(), MagicMock(),
        remeasure=False,
        confirmed_index={"francesinha c3": ["shot_a", "shot_b", "shot_c"]},
    )
    assert ready is False
    # secs_ok = 60 >= 48.75 True; shots_ok = 3 >= 5 False -> UNCONFIRMED.
    assert per[canonical] == "UNCONFIRMED"
    assert canonical in strict_uncovered
    assert ent.strict_available_seconds == 60.0
    assert ent.strict_available_distinct_shots == 3
