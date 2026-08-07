"""Bypass operacional STUDIO_AUTO_APPROVE_GATES em request_gate.

Garante 3 propriedades:
1. Gate novo sem decisão prévia → auto-aprovado (1ª opção).
2. Decisão humana anterior (reject) → preservada, NÃO sobrescrita pelo bypass.
3. Estado pending:<id> (loop do watch) → limpo → auto-aprovado para destravar.
"""
from __future__ import annotations

import pytest

from studio.approvals.gates import GateRejected, request_gate
from studio.config import Settings
from studio.orchestrator.state import RunState


@pytest.fixture
def bypass_settings() -> Settings:
    return Settings(
        auto_approve_gates=True,
        mock_mode=False,
        telegram_bot_token="dummy-token-should-not-be-called",
    )


@pytest.fixture
def fresh_state() -> RunState:
    return RunState(video_id="v_unit_test", topic="tópico de teste")


def test_bypass_auto_approves_new_gate(
    bypass_settings: Settings, fresh_state: RunState
) -> None:
    """Gate sem decisão prévia → primeira opção é tomada, sem tocar Telegram."""
    assert request_gate(bypass_settings, fresh_state, "topic", "Q?") == "approve"
    assert fresh_state.gates["topic"] == "approve"


def test_bypass_preserves_human_reject(
    bypass_settings: Settings, fresh_state: RunState
) -> None:
    """Idempotência: rejeição humana anterior é mantida, NÃO overriden."""
    fresh_state.gates["script"] = "reject"
    with pytest.raises(GateRejected) as exc_info:
        request_gate(bypass_settings, fresh_state, "script", "Q?")
    assert exc_info.value.gate == "script"
    # Estado intacto — bypass NÃO escreve por cima de reject
    assert fresh_state.gates["script"] == "reject"


def test_bypass_resolves_pending_loop_state(
    bypass_settings: Settings, fresh_state: RunState
) -> None:
    """Estado pending:<id> (causa do loop infinito do watch) → auto-aprovado.

    Crítico: este é o cenário do run actual 20260806-133000 onde o
    daemon ficou em retry porque state.gates['topic'] == 'pending:1420'."""
    fresh_state.gates["final"] = "pending:999"
    assert request_gate(bypass_settings, fresh_state, "final", "Q?") == "approve"
    assert fresh_state.gates["final"] == "approve"


def test_bypass_keeps_existing_approved_idempotent(
    bypass_settings: Settings, fresh_state: RunState
) -> None:
    """Aprovação humana anterior é preservada (short-circuit upstream)."""
    fresh_state.gates["topic"] = "approve"
    assert request_gate(bypass_settings, fresh_state, "topic", "Q?") == "approve"


def test_bypass_off_routes_to_telegram_gate_pending(
    monkeypatch, fresh_state: RunState
) -> None:
    """Sem auto_approve_gates e sem mock, o pending state leva a GatePending —
    prova que o bypass NÃO se aplica quando auto_approve_gates=False.
    Monkeypatch ao `TelegramClient` no módulo `gates` (é onde o import
    fica bindado, não no módulo original).
    """
    from studio.approvals.gates import GatePending

    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            # ignora settings/params — só serve para unicidade de tipo
            self.mock = False  # força caminho real (não-mock)

        def poll_answer(self, message_id, options):
            return None  # sem resposta → GatePending

        def send_question(self, question, options):
            return 1

    # gates.py faz `from ... import TelegramClient` — patch no símbolo bindado
    monkeypatch.setattr("studio.approvals.gates.TelegramClient", FakeClient)

    settings = Settings(
        auto_approve_gates=False,
        mock_mode=False,
        telegram_bot_token="dummy-token",
    )
    with pytest.raises(GatePending):
        request_gate(settings, fresh_state, "new_gate", "Q?")
