"""Regressão bug 1 (final closure pass): DISCOVERY_LITE lia `candidates`
antes da primeira atribuição real — UnboundLocalError garantido, sempre
engolido pelo `except Exception` do próprio bloco e logado como "skipped".
Nunca corria de facto. Corrigido movendo a atribuição de `candidates`
para antes do bloco DISCOVERY_LITE.
"""
from __future__ import annotations

import inspect

from studio.library import reconcile


def test_candidates_assignment_vem_antes_do_discovery_lite_block():
    source = inspect.getsource(reconcile.main)
    idx_assign = source.index("candidates = sorted(")
    idx_discovery = source.index("DISCOVERY LITE phase")
    assert idx_assign < idx_discovery, (
        "candidates = sorted(...) deve vir ANTES do bloco DISCOVERY_LITE "
        "(regressão: UnboundLocalError sempre engolido pelo except)"
    )
