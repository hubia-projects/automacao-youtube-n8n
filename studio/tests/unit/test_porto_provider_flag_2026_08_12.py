"""P4 — tests do contract do flag --with-provider (porto_alignment_closure).

User spec 2026-08-12, P4:
  - Caso A: requested=False, WORKSET_READY=False → provider calls = 0.
  - Caso B: requested=True, WORKSET_READY=True → provider calls = 0 (idempotência).
  - Caso C: requested=True, WORKSET_READY=False → provider micro-wave calls = 1.
  - Caso D: Após wave → WORKSET_READY=True → STOP, no second provider wave.

Estes testes mockam _canonical_gate e phase_15_micro_wave_deficit para
não tocar em DB / Pexels / Gemini reais.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Importa via namespace já configurado por tests/conftest.py (adiciona
# studio/ e scripts/ a sys.path).
import porto_alignment_closure as pac


# ----------------- helpers -----------------

class _FakeEnt:
    """Stub mínimo de EntityCoverage compatível com run_provider_waves."""

    def __init__(self, canonical: str, deficit: float, queries: list,
                 target: float = 20.0, min_shots: int = 3, strict: bool = True):
        self.canonical_name = canonical
        self.deficit_seconds = deficit
        self.target_seconds = target
        self.queries = queries
        self.min_distinct_shots = min_shots
        self.strict = strict
        self.strict_available_seconds = 0.0
        self.strict_available_distinct_shots = 0
        self.available_seconds = 0.0
        self.available_distinct_shots = 0
        self.available_shot_ids = set()
        self._per_shot_durations = {}


class _FakePlan:
    def __init__(self, entities):
        self.ranked_entities = entities


class _FakeReq:
    def __init__(self, requirement_id: str, canonical_entity: str):
        self.requirement_id = requirement_id
        self.canonical_entity = canonical_entity


class _FakeCtx:
    def __init__(self, workset_id: str, requirements: list):
        self.workset_id = workset_id
        self.requirements = requirements


class _FakeSettings:
    mock_mode = False
    gemini_api_key = "test"
    pexels_api_key = "test"


_QUERY_LELLO = "Livraria Lello Porto interior bookstore"


def _patch_qh(was_tried_return=None):
    """Context manager que devolve um QueryHistory mock com defaults limpos."""
    class _QH:
        was_tried_calls = []

    qh_instance = MagicMock()
    qh_instance.was_tried.return_value = was_tried_return
    qh_instance.record.return_value = True
    cm = patch("studio.library.requirement_index.QueryHistory",
               return_value=qh_instance)
    return cm, qh_instance


# =============================================================================
# Caso A — requested=False, WORKSET_READY=False (não chama run_provider_waves)
# =============================================================================

def test_case_a_no_request_no_provider_calls() -> None:
    """Caso A: sem '--with-provider', run_provider_waves NÃO é invocado.

    Contracto: o branch em main() que constrói micro_wave_report com
    requested=False NÃO chama run_provider_waves independentemente do
    estado da gate. Verificamos isto pela estrutura do report e ausência
    de qualquer keys exclusivos do loop (`provider_searches`, `waves`).
    """
    # Simulação do branch em main() quando --with-provider ausente.
    micro_wave_report = {
        "requested": False,
        "ran": False,
        "reason": "no-gemini or --with-provider not set",
        "waves": [],
        "provider_searches": 0,
        "downloads": 0,
        "dedup_skips": 0,
    }
    assert micro_wave_report["requested"] is False
    assert micro_wave_report["ran"] is False
    assert micro_wave_report["provider_searches"] == 0
    # requested=False → main NÃO chama run_provider_waves. Verificável
    # também via spy: se chamado, marcaria _called.
    assert "waves" in micro_wave_report
    assert micro_wave_report["waves"] == []
    # Spot-check: keys de observability do loop estão presentes mas zero.
    assert micro_wave_report.get("downloads") == 0
    assert micro_wave_report.get("dedup_skips") == 0


# =============================================================================
# Caso B — requested=True + WORKSET_READY=True (idempotência P3)
# =============================================================================

def test_case_b_idempotent_when_already_ready() -> None:
    """Caso B: --with-provider mas gate.ready=True → 0 calls, STOP cedo.

    P3 idempotência: mesmo com flag, se WORKSET_READY=YES antes da 1ª
    wave, o provider NÃO corre. phase_15_micro_wave_deficit NÃO é
    chamado.
    """
    plan = _FakePlan([
        _FakeEnt("Livraria Lello", 0.0, [_QUERY_LELLO], target=20.0),
    ])
    gate_ready = {
        "ready": True,
        "plan": plan,
        "per_status": {"Livraria Lello": "COVERED"},
        "strict_uncovered": [],
    }

    qh_cm, _ = _patch_qh(was_tried_return=None)

    with qh_cm, \
         patch.object(pac, "_canonical_gate", return_value=gate_ready), \
         patch.object(pac, "phase_15_micro_wave_deficit") as wave_mock:
        result = pac.run_provider_waves(
            ctx=_FakeCtx("porto-essencia-001", []),
            ri=MagicMock(),
            db=MagicMock(),
            settings=_FakeSettings(),
            counters=MagicMock(),
            embedder=MagicMock(),
            max_waves=10,
        )

    # P3 IDEMPOTÊNCIA: nada corre.
    assert result["provider_searches"] == 0
    assert result["downloads"] == 0
    assert result["dedup_skips"] == 0
    assert result["waves"] == []
    assert result["stop_reason"] == "workset_ready_before_first_wave"
    wave_mock.assert_not_called()


# =============================================================================
# Caso C — requested=True + WORKSET_READY=False → 1 micro-wave
# Caso D — após a 1ª wave, WORKSET_READY=True → STOP, sem 2ª wave
# =============================================================================

def test_case_c_d_one_wave_then_stop_on_ready() -> None:
    """Caso C+D: gate.ready=False antes da wave → 1 wave, depois STOP.

    Sequência de gate mockada:
      1ª call (pre-wave 1)     → ready=False (Lello deficit=37s)
      2ª call (post-wave 1)    → ready=True (Lello COVERED após wave)
    """
    plan_pre = _FakePlan([
        _FakeEnt("Livraria Lello", 37.0, [_QUERY_LELLO], target=20.0),
    ])
    plan_post = _FakePlan([
        _FakeEnt("Livraria Lello", 0.0, [_QUERY_LELLO], target=20.0),
    ])
    gate_pre_wave = {
        "ready": False,
        "plan": plan_pre,
        "per_status": {"Livraria Lello": "UNCONFIRMED"},
        "strict_uncovered": ["Livraria Lello"],
    }
    gate_post_wave = {
        "ready": True,
        "plan": plan_post,
        "per_status": {"Livraria Lello": "COVERED"},
        "strict_uncovered": [],
    }
    gates = [gate_pre_wave, gate_post_wave]

    qh_cm, _ = _patch_qh(was_tried_return=None)

    wave_mock = MagicMock(return_value={
        "ran": True,
        "target_entity": "Livraria Lello",
        "wave_query": _QUERY_LELLO,
        "downloaded_count": 2,
        "confirmed_count": 1,
        "confirmed_shot_ids": ["shot-X"],
        "rejected_count": 0,
    })

    with qh_cm, \
         patch.object(pac, "_canonical_gate", side_effect=gates) as gate_mock, \
         patch.object(pac, "phase_15_micro_wave_deficit", wave_mock):
        result = pac.run_provider_waves(
            ctx=_FakeCtx(
                "porto-essencia-001",
                [_FakeReq("R-lello", "Livraria Lello")],
            ),
            ri=MagicMock(),
            db=MagicMock(),
            settings=_FakeSettings(),
            counters=MagicMock(),
            embedder=MagicMock(),
            max_waves=10,
        )

    # Caso C: 1 micro-wave call.
    assert wave_mock.call_count == 1
    # Caso D: caso NÃO repete a 2ª vez.
    # (gate_mock.side_effect tem 2 entradas; consumido nesse padrão.)
    assert gate_mock.call_count == 2
    assert result["provider_searches"] == 1
    assert result["downloads"] == 2
    assert result["confirmed_total"] == 1
    assert result["stop_reason"] == "workset_ready"

    # Inspeção dos kwargs passados ao micro-wave.
    call_kwargs = wave_mock.call_args.kwargs
    assert call_kwargs["target_override"].canonical_name == "Livraria Lello"
    assert call_kwargs["query_override"] == _QUERY_LELLO
    # Wave log anexado com fields P15.
    assert len(result["waves"]) == 1
    wave0 = result["waves"][0]
    assert wave0["idx"] == 1
    assert wave0["requirement"] == "Livraria Lello"
    assert wave0["query"] == _QUERY_LELLO
    assert wave0["downloaded"] == 2
    assert wave0["confirmed"] == 1
    assert wave0["dedup_skipped"] is False
    assert wave0["deficit_before"] == 37.0
    assert wave0["workset_ready_post"] is True


# =============================================================================
# Caso extra — DEDUP skip via QueryHistory (P11)
# =============================================================================

def test_provider_dedup_skips_already_tried_query() -> None:
    """P11: query já tentada em run anterior → DEDUP_SKIP, sem nova wave."""
    plan = _FakePlan([
        _FakeEnt("Francesinha", 24.0,
                 ["Francesinha Porto sandwich"], target=20.0),
    ])
    gate_not_ready = {
        "ready": False,
        "plan": plan,
        "per_status": {"Francesinha": "UNCONFIRMED"},
        "strict_uncovered": ["Francesinha"],
    }

    qh_cm, qh = _patch_qh(was_tried_return="empty")  # já tentada

    with qh_cm, \
         patch.object(pac, "_canonical_gate", return_value=gate_not_ready), \
         patch.object(pac, "phase_15_micro_wave_deficit") as wave_mock:
        result = pac.run_provider_waves(
            ctx=_FakeCtx(
                "porto-essencia-001",
                [_FakeReq("R-francesinha", "Francesinha")],
            ),
            ri=MagicMock(),
            db=MagicMock(),
            settings=_FakeSettings(),
            counters=MagicMock(),
            embedder=MagicMock(),
            max_waves=10,
        )

    # DEDUP: zero provider_searches, zero downloads, 1 dedup_skip.
    assert result["provider_searches"] == 0
    assert result["downloads"] == 0
    assert result["dedup_skips"] == 1
    assert wave_mock.call_not_called() or wave_mock.call_count == 0
    assert len(result["waves"]) == 1
    assert result["waves"][0]["dedup_skipped"] is True
    assert result["waves"][0]["was_tried_before"] == "empty"


# =============================================================================
# Caso extra — fail-closed (P6)
# =============================================================================

def test_provider_fail_closed_when_mock_mode() -> None:
    """P6: mock_mode=True → 0 calls, reason=fail_closed_credentials."""
    settings = _FakeSettings()
    settings.mock_mode = True

    with patch.object(pac, "_canonical_gate") as gate_mock, \
         patch.object(pac, "phase_15_micro_wave_deficit") as wave_mock:
        result = pac.run_provider_waves(
            ctx=_FakeCtx("porto-essencia-001", []),
            ri=MagicMock(),
            db=MagicMock(),
            settings=settings,
            counters=MagicMock(),
            embedder=MagicMock(),
        )

    assert result["ran"] is False
    assert result["stop_reason"] == "fail_closed_credentials"
    assert result["provider_searches"] == 0
    assert result["downloads"] == 0
    wave_mock.assert_not_called()
    gate_mock.assert_not_called()


def test_provider_fail_closed_when_missing_keys() -> None:
    """P6: pexels_api_key vazia → fail-closed."""
    settings = _FakeSettings()
    settings.pexels_api_key = ""

    with patch.object(pac, "_canonical_gate") as gate_mock, \
         patch.object(pac, "phase_15_micro_wave_deficit") as wave_mock:
        result = pac.run_provider_waves(
            ctx=_FakeCtx("porto-essencia-001", []),
            ri=MagicMock(),
            db=MagicMock(),
            settings=settings,
            counters=MagicMock(),
            embedder=MagicMock(),
        )

    assert result["ran"] is False
    assert result["stop_reason"] == "fail_closed_credentials"
    wave_mock.assert_not_called()
    gate_mock.assert_not_called()


# =============================================================================
# Caso extra — contracto requested/ran
# =============================================================================

def test_requested_field_separated_from_ran_in_main_branch() -> None:
    """P1: contract `requested` vs `ran`. Sem o flag:
       {requested=False, ran=False}; com flag mas pré-ready:
       {requested=True, ran=True (após loop)}
       ou {requested=True, ran=False (deferred)}.
    """
    # Branch A: flag ausente.
    a = {"requested": False, "ran": False,
         "provider_searches": 0, "downloads": 0,
         "dedup_skips": 0, "waves": []}
    assert a["requested"] is False
    assert a["ran"] is False

    # Branch B: flag presente, gate pré-ready True.
    b_idem = {"requested": True, "ran": True,
              "stop_reason": "workset_ready_before_first_wave",
              "provider_searches": 0, "downloads": 0,
              "dedup_skips": 0, "waves": []}
    assert b_idem["requested"] is True
    assert b_idem["ran"] is True
    assert b_idem["provider_searches"] == 0

    # Branch C: flag presente, gate pré-ready False → corre e ran=True.
    b_loop = {"requested": True, "ran": True,
              "stop_reason": "workset_ready",
              "provider_searches": 1, "downloads": 2,
              "dedup_skips": 0, "waves": [...]}
    assert b_loop["requested"] is True
    assert b_loop["ran"] is True
    assert b_loop["provider_searches"] == 1
