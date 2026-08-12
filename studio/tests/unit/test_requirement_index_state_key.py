"""Regressão item 8: bug de chave de state em reconcile.py.

`state["_requirement_index_initialized"] = True` era escrito, mas o guard
de persistência de RequirementMatch pós-DONE verificava
`state.get("_requirement_index")` — chave DIFERENTE, nunca coincidia, o
bloco de persistência nunca corria. Corrigido para usar a MESMA chave
("_requirement_index") no setter e no getter.

Este teste inspecciona o módulo fonte directamente (em vez de correr o
`main()` completo, que exige workflow.json/DB/embedder reais) — garante
que um futuro refactor não reintroduz o mismatch de chave.
"""
from __future__ import annotations

import inspect

from studio.library import reconcile


def test_setter_e_getter_da_requirement_index_flag_usam_a_mesma_chave():
    source = inspect.getsource(reconcile)
    assert 'state["_requirement_index"] = True' in source, (
        "setter da flag _requirement_index não encontrado — "
        "regressão do bug de chave (item 8)?"
    )
    assert 'state.get("_requirement_index")' in source, (
        "getter da flag _requirement_index não encontrado"
    )
    # a chave antiga (buggy) não deve voltar a aparecer como SETTER
    assert 'state["_requirement_index_initialized"] = True' not in source


def test_ri_instance_singleton_reutilizado_no_loop():
    """item 8: RequirementIndex deixa de ser recriado por asset dentro do
    loop de ingest — reutiliza `ri_instance` do arranque da função."""
    source = inspect.getsource(reconcile)
    assert "ri = ri_instance or RequirementIndex(db)" in source
