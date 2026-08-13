"""Item 36 (automation closure): apply_fixes/_violates_brief_constraints.

Bug real: _metadata_score nunca validava brief.must_have/must_not
(food/landmark) — uma "correcção" podia trocar o shot sabotado por outro
que ainda violava a cena, e apply_fixes aceitava-a sem detectar.
"""
from __future__ import annotations

from studio.matching.assigner import SegmentAssignment
from studio.matching.briefs import VisualBrief
from studio.review.fixes import _violates_brief_constraints


def _seg(shot_id, has_food=False, has_landmark=False) -> SegmentAssignment:
    return SegmentAssignment(
        scene_id="s01", beat="detail", seg_index=0, t_in=0.0, t_out=2.0,
        shot_id=shot_id, media_path="/x.mp4", media_sha="sha_" + shot_id,
        source_in=0.0, source_out=2.0, has_food=has_food,
        has_landmark=has_landmark,
    )


def _brief(must_have=None, must_not=None) -> VisualBrief:
    return VisualBrief(scene_id="s01", visual_subject_en="x",
                       must_have=must_have or [], must_not=must_not or [])


def test_segmento_sem_food_viola_must_have_food():
    brief = _brief(must_have=["food"])
    assert _violates_brief_constraints([_seg("a", has_food=False)], brief)


def test_segmento_com_food_satisfaz_must_have_food():
    brief = _brief(must_have=["food"])
    assert not _violates_brief_constraints([_seg("a", has_food=True)], brief)


def test_segmento_com_landmark_viola_must_not_landmark():
    brief = _brief(must_not=["landmark"])
    assert _violates_brief_constraints([_seg("a", has_landmark=True)], brief)


def test_sem_must_have_must_not_nunca_viola():
    brief = _brief()
    assert not _violates_brief_constraints(
        [_seg("a", has_food=False, has_landmark=True)], brief)


def test_um_segmento_violador_entre_varios_e_suficiente():
    brief = _brief(must_have=["food"])
    segs = [_seg("a", has_food=True), _seg("b", has_food=False)]
    assert _violates_brief_constraints(segs, brief)
