"""provider_policy.py (item 30 do fecho de cobertura multi-provider) —
waterfall por tipo de requirement, sem hardcode de nome de entidade/cidade."""
from __future__ import annotations

from studio.library.provider_policy import provider_policy
from studio.matching.coverage_plan import FILLER_ENTITY_TYPE


def test_strict_landmark_prioriza_wikimedia():
    out = provider_policy("landmark", strict=True)
    assert out[0] == "wikimedia"
    assert set(out) == {"wikimedia", "pexels", "pixabay"}


def test_strict_place_prioriza_wikimedia():
    out = provider_policy("place", strict=True)
    assert out[0] == "wikimedia"


def test_food_prioriza_stock():
    out = provider_policy("food", strict=True)
    assert out[0] in ("pexels", "pixabay")
    assert "wikimedia" in out


def test_filler_prioriza_stock():
    out = provider_policy(FILLER_ENTITY_TYPE, strict=False)
    assert out[0] in ("pexels", "pixabay")


def test_core_nao_estrito_prioriza_stock_mesmo_sendo_landmark():
    out = provider_policy("landmark", strict=False)
    assert out[0] in ("pexels", "pixabay")


def test_tipo_desconhecido_e_strict_trata_como_strict_place():
    out = provider_policy("unknown_type", strict=True)
    assert out[0] == "wikimedia"


def test_nunca_inclui_manual_ou_openverse():
    for et in ("landmark", "food", FILLER_ENTITY_TYPE, "unknown"):
        for strict in (True, False):
            out = provider_policy(et, strict)
            assert "manual" not in out
            assert "openverse" not in out
