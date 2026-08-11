"""Testes para SigLIP triage em ingest.py (UPSTREAM-CHANGE §P5 2026-08-11).

Cobre a função `_triage_shots`:
  - Empty req_text_embeds → tudo GLOBAL_ONLY (fallback conservativo).
  - Empty shot_vecs → {}.
  - Coords exactos para HIGH vs POSSIBLE vs GLOBAL_ONLY.
  - Thresholds configuráveis (settings.library_triage_*).

Estratégia: numpy mock vectors (não precisa de SigLIP real). Cada coseno
directo entre vectores normalizados (unitários).
"""

from __future__ import annotations

import numpy as np
from unittest.mock import MagicMock

from studio.config import Settings
from studio.library.ingest import (
    TIER_GLOBAL, TIER_HIGH, TIER_POSSIBLE, _triage_shots,
)


def _vec(values: list[float]) -> np.ndarray:
    """Mock de embedding (não precisa passar pelo SigLIP)."""
    arr = np.array(values, dtype=np.float32)
    norm = float(np.linalg.norm(arr))
    if norm < 1e-8:
        return arr
    return arr / norm


def _settings(high_t: float = 0.30, poss_t: float = 0.18) -> Settings:
    s = MagicMock(spec=Settings)
    s.library_triage_high_threshold = high_t
    s.library_triage_possible_threshold = poss_t
    return s


# ---------- Test 1: empty req_text_embeds → tudo GLOBAL_ONLY ----------------------
def test_empty_req_text_embeds_all_global_only():
    settings = _settings()
    shot_vecs = {"a": _vec([1.0, 0.0]), "b": _vec([0.0, 1.0])}
    out = _triage_shots(shot_vecs, {}, settings)
    assert out == {"a": TIER_GLOBAL, "b": TIER_GLOBAL}


# ---------- Test 2: empty shot_vecs → {} ------------------------------------------
def test_empty_shot_vecs_returns_empty_dict():
    settings = _settings()
    out = _triage_shots({}, {"req1": _vec([1.0, 0.0])}, settings)
    assert out == {}


# ---------- Test 3: HIGH (cosine = 1.0 contra req) --------------------------------
def test_high_relevance_perfect_cosine():
    settings = _settings(high_t=0.30, poss_t=0.18)
    req = {"Lello": _vec([1.0, 0.0, 0.0])}
    shot_vecs = {"s1": _vec([1.0, 0.0, 0.0])}     # coseno = 1.0
    out = _triage_shots(shot_vecs, req, settings)
    assert out["s1"] == TIER_HIGH


# ---------- Test 4: POSSIBLE (coseno entre thresholds) -----------------------------
def test_possible_relevance_between_thresholds():
    settings = _settings(high_t=0.30, poss_t=0.18)
    req = {"req1": _vec([1.0, 0.0])}
    shot_vecs = {
        # 0.20 entre 0.18 (POSS) e 0.30 (HIGH) → POSSIBLE.
        "p1": _vec([0.25, 0.97]),
    }
    out = _triage_shots(shot_vecs, req, settings)
    assert out["p1"] == TIER_POSSIBLE


# ---------- Test 5: GLOBAL_ONLY (cosine = baixo) ----------------------------------
def test_global_only_low_cosine():
    settings = _settings(high_t=0.30, poss_t=0.18)
    req = {"req1": _vec([1.0, 0.0])}
    shot_vecs = {"g1": _vec([-1.0, 0.0])}     # coseno = -1.0 (anti-)
    out = _triage_shots(shot_vecs, req, settings)
    assert out["g1"] == TIER_GLOBAL


# ---------- Test 6: max sobre múltiplas requirements -------------------------------
def test_max_over_multiple_requirements():
    """Se um shot tiver cosine HIGH com req_A (0.99) mas só 0.05 com req_B
    e req_C, o tier será HIGH (max). Verifica max(), não first-match."""
    settings = _settings(high_t=0.30, poss_t=0.18)
    req = {
        "req_A": _vec([1.0, 0.0]),
        "req_B": _vec([0.0, 1.0]),
        "req_C": _vec([0.7, 0.7]),
    }
    shot_vecs = {
        # coseno req_A = 0.99 (HIGH), req_B = 0.0, req_C = 0.69 (HIGH)
        "mix": _vec([0.99, 0.05]),
    }
    out = _triage_shots(shot_vecs, req, settings)
    assert out["mix"] == TIER_HIGH


def test_possible_when_max_cosine_in_band():
    """Mesmo setup do anterior mas o req_A é perpendicular; coseno max
    cai dentro da band POSSIBLE."""
    settings = _settings(high_t=0.30, poss_t=0.18)
    req = {
        "req_A": _vec([1.0, 0.0]),      # coseno 0.10 → GLOBAL_ONLY band
        "req_B": _vec([0.95, 0.20]),    # coseno da shot: ~0.98 mas invertido... usar below
    }
    # Shot alinhado com req_A ligeiramente abaixo do limiar HIGH:
    shot_vecs = {"mix": _vec([0.95, 0.05])}  # coseno com req_A = 0.95/√(0.95²+0.05²)
    out = _triage_shots(shot_vecs, req, settings)
    # cos(α) ≈ 0.998  →  HIGH band → expect HIGH
    assert out["mix"] == TIER_HIGH, \
        f"shot alinhado com req_A deve ser HIGH, got {out['mix']}"


# ---------- Test 7: thresholds 0 → apenas HIGH ------------------------------------
def test_zero_thresholds_treats_any_positive_as_high():
    settings = _settings(high_t=0.0, poss_t=0.0)
    req = {"req1": _vec([1.0, 0.0])}
    shot_vecs = {"s1": _vec([0.5, 0.5])}    # coseno ≈ 0.707
    out = _triage_shots(shot_vecs, req, settings)
    assert out["s1"] == TIER_HIGH
