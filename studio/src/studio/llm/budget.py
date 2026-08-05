"""Breaker de orçamento — doutrina fail-closed (ARCHITECTURE.md §2).

Exceder o orçamento do run é um erro que PÁRA o pipeline; nunca se continua
a gastar silenciosamente.
"""

from __future__ import annotations

from studio.orchestrator.state import RunState


class BudgetExceeded(RuntimeError):
    def __init__(self, total_usd: float, budget_usd: float):
        self.total_usd = total_usd
        self.budget_usd = budget_usd
        super().__init__(
            f"orçamento excedido: ${total_usd:.2f} gastos de ${budget_usd:.2f}"
        )


def check_budget(state: RunState) -> None:
    ledger = state.cost_ledger
    if ledger.total_usd >= ledger.budget_usd:
        raise BudgetExceeded(ledger.total_usd, ledger.budget_usd)


def charge(state: RunState, cost_usd: float) -> None:
    """Regista custo antecipadamente (para chamadas dentro de um stage) e
    verifica o teto. O registo por-stage acontece no runner via StageResult."""
    state.cost_ledger.total_usd += cost_usd
    check_budget(state)
