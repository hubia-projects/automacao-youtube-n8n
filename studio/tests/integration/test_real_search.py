"""Integração real — E2E de saída da Fase 2 (ROADMAP).

Corre APENAS se a biblioteca real (data/library) já tem shots ingeridos.
Verifica: query de comida com must_not=monument devolve só shots com
has_food e zero has_landmark no top-10 — regressão direta da classe
monumento/comida.

Correr:  uv run pytest tests/integration -m real  (ou sem -m; skip automático)
"""

import pytest

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.library.search import search_shots


@pytest.fixture(scope="module")
def real_settings():
    s = Settings()  # .env real, data/ real
    if not (s.library_root / "lancedb").exists():
        pytest.skip("biblioteca real vazia — correr `studio ingest sweep` primeiro")
    return s


def test_query_comida_exclui_monumentos(real_settings):
    from studio.library.embed import SiglipEmbedder

    db = LibraryDB(real_settings.library_root)
    if db.count() == 0:
        pytest.skip("biblioteca sem shots")

    results = search_shots(
        db, SiglipEmbedder(),
        "close-up of pastel de nata custard tart on a bakery table",
        must_have=["food"], must_not=["monument"], min_quality=3, k=10,
    )
    assert results, "biblioteca tem shots mas query não devolveu nada"
    for r in results:
        assert r["has_food"], f"{r['shot_id']} sem comida no top-10: {r['summary']}"
        assert not r["has_landmark"], f"{r['shot_id']} é monumento: {r['summary']}"
