"""Gates humanos — pontos de aprovação do pipeline.

Um gate resolve para "approved" | "rejected" | (opção livre) e fica
registado em state.gates. Decisões já tomadas não voltam a perguntar
(idempotência no resume).
"""

from __future__ import annotations

import logging

from studio.approvals.telegram import TelegramClient
from studio.config import Settings
from studio.orchestrator.state import RunState

log = logging.getLogger("studio.gates")


class GateRejected(RuntimeError):
    def __init__(self, gate: str):
        self.gate = gate
        super().__init__(f"gate {gate!r} rejeitado pelo humano")


class GatePending(RuntimeError):
    """Pergunta enviada; decisão ainda não existe. O stage converte isto em
    StageResult(waiting_approval) — o run pára limpo e retoma com
    `studio approve` ou com o botão do Telegram no próximo resume."""

    def __init__(self, gate: str):
        self.gate = gate
        super().__init__(f"gate {gate!r} à espera de decisão humana")


def request_gate(
    settings: Settings,
    state: RunState,
    gate: str,
    question: str,
    options: list[str] | None = None,
) -> str:
    """NÃO-BLOQUEANTE: envia a pergunta uma vez, guarda o message_id e
    levanta GatePending. Em chamadas seguintes (resume) faz um poll único
    ao Telegram; sem resposta → GatePending outra vez."""
    options = options or ["approve", "reject"]
    client = TelegramClient(settings)

    existing = state.gates.get(gate)
    if existing and not str(existing).startswith("pending:"):
        log.info("gate %s já decidido: %s", gate, existing)
        if existing == "reject":
            raise GateRejected(gate)
        return existing

    if client.mock:
        state.gates[gate] = options[0]
        return options[0]

    if existing:  # "pending:<message_id>" — poll único
        message_id = int(str(existing).split(":", 1)[1])
        choice = client.poll_answer(message_id, options)
        if choice:
            state.gates[gate] = choice
            if choice == "reject":
                raise GateRejected(gate)
            return choice
        raise GatePending(gate)

    message_id = client.send_question(question, options)
    state.gates[gate] = f"pending:{message_id}"
    raise GatePending(gate)
