"""§P2 (TEST 5C) — pytests para _merge_adjacent_shots pure logic.

Test A: lista vazia → [].
Test B: shots contíguos sub-1s → MERGED em shot único passando MIN.
Test C: shots afastados (>0.5s gap) → mantém separação.
Test D: shots sobrepostos → max(end).
"""
from __future__ import annotations

from studio.library.shots import _merge_adjacent_shots


def test_merge_returns_empty_for_empty_list():
    assert _merge_adjacent_shots([]) == []


def test_merge_returns_single_for_single_element():
    assert _merge_adjacent_shots([(0.0, 0.4)]) == [(0.0, 0.4)]


def test_merge_combines_three_contiguous_sub_min_into_one_passing_min():
    """Caso TEST 5C: 3 cenas Pexels sub-1s contíguas viram ≥MIN."""
    raw = [(0.0, 0.4), (0.4, 0.9), (0.9, 1.4)]
    merged = _merge_adjacent_shots(raw)
    assert merged == [(0.0, 1.4)]
    assert merged[0][1] - merged[0][0] >= 1.0    # ≥MIN_SHOT_SECONDS


def test_merge_keeps_gap_above_threshold_separated():
    raw = [(0.0, 0.4), (1.0, 1.4)]    # gap 0.6s > max_gap=0.5s
    merged = _merge_adjacent_shots(raw)
    assert merged == [(0.0, 0.4), (1.0, 1.4)]


def test_merge_extends_takes_max_end_on_overlap():
    raw = [(0.0, 1.0), (0.8, 1.4)]
    merged = _merge_adjacent_shots(raw)
    assert merged == [(0.0, 1.4)]


def test_merge_with_explicit_gap_accepts_small_gap():
    raw = [(0.0, 0.4), (0.7, 1.1)]    # gap 0.3s < default 0.5s
    merged = _merge_adjacent_shots(raw, max_gap_seconds=0.5)
    assert merged == [(0.0, 1.1)]


def test_merge_sorted_input_already():
    """Garante robustez mesmo com input não-ordenado."""
    raw_unsorted = [(5.0, 5.3), (0.0, 0.4), (1.0, 1.4)]
    merged = _merge_adjacent_shots(raw_unsorted)
    assert merged == [(0.0, 0.4), (1.0, 1.4), (5.0, 5.3)]


def test_merge_typical_pesqueels_clips():
    """Pexels-Porto cenário típico: 2 cenas curtas contíguas."""
    raw = [(0.0, 0.6), (0.6, 1.2)]
    merged = _merge_adjacent_shots(raw)
    assert merged == [(0.0, 1.2)]
    assert merged[0][1] - merged[0][0] >= 1.0
