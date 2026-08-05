import pytest

from studio.llm.budget import BudgetExceeded, charge, check_budget
from studio.orchestrator.state import new_state


def test_dentro_do_orcamento_passa():
    state = new_state("v", "", 15.0)
    state.cost_ledger.total_usd = 14.99
    check_budget(state)  # não levanta


def test_breaker_dispara_no_teto():
    state = new_state("v", "", 15.0)
    state.cost_ledger.total_usd = 15.0
    with pytest.raises(BudgetExceeded):
        check_budget(state)


def test_charge_regista_e_verifica():
    state = new_state("v", "", 1.0)
    charge(state, 0.4)
    assert state.cost_ledger.total_usd == 0.4
    with pytest.raises(BudgetExceeded):
        charge(state, 0.7)
