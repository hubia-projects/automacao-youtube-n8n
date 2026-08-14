"""item MediaKind (Fase 4, fecho de cobertura multi-provider): imagem como
VirtualShot através de assigner -> timeline -> renderer. Cobre:
  - SegmentAssignment.media_kind propagado a partir do candidato (dict com
    chave "media_kind" ausente ou None -> "video", nunca None no pydantic).
  - build_timeline() propaga media_kind e o Ken Burns NUNCA fica "none"
    para imagem (item 19/20 — nunca parece slideshow).
  - render_segment() usa -loop 1 (sem -ss/-t de trim) para imagem; vídeo
    continua exactamente como antes.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from studio.matching.assigner import SegmentAssignment
from studio.render.timeline import Narration, TimelineEntry, KenBurns, _kenburns_for


def _seg(shot_id="s1", media_kind="video", shot_type="", camera_motion="static"):
    return SegmentAssignment(
        scene_id="sc1", beat="detail", seg_index=0, t_in=0.0, t_out=5.0,
        shot_id=shot_id, media_path="/media/x.jpg", media_sha="sha1",
        source_in=0.0, source_out=5.0, shot_type=shot_type,
        camera_motion=camera_motion, media_kind=media_kind,
    )


def test_segment_assignment_media_kind_default_video():
    seg = SegmentAssignment(
        scene_id="sc1", beat="detail", seg_index=0, t_in=0.0, t_out=5.0,
        shot_id="s1", media_path="/x.mp4", media_sha="sha1",
        source_in=0.0, source_out=5.0,
    )
    assert seg.media_kind == "video"


def test_kenburns_nunca_none_para_imagem_sem_shot_type():
    seg = _seg(media_kind="image", shot_type="", camera_motion="static")
    kb = _kenburns_for(seg)
    assert kb.mode != "none"


def test_kenburns_none_permitido_para_video_estatico_sem_shot_type():
    seg = _seg(media_kind="video", shot_type="", camera_motion="static")
    kb = _kenburns_for(seg)
    assert kb.mode == "none"


def test_kenburns_imagem_respeita_shot_type_quando_disponivel():
    seg = _seg(media_kind="image", shot_type="close-up")
    kb = _kenburns_for(seg)
    assert kb.mode == "push_in"


def test_kenburns_imagem_fallback_deterministico_mesmo_shot_mesmo_modo():
    seg_a = _seg(shot_id="imgABC", media_kind="image", shot_type="")
    seg_b = _seg(shot_id="imgABC", media_kind="image", shot_type="")
    assert _kenburns_for(seg_a).mode == _kenburns_for(seg_b).mode


def test_build_timeline_propaga_media_kind():
    from studio.render.timeline import build_timeline
    seg = _seg(media_kind="image")
    tl = build_timeline("vid1", "/narration.wav", [seg], {"sc1": "texto"})
    assert tl.entries[0].media_kind == "image"


def _entry(media_kind="video", source=None):
    return TimelineEntry(
        scene_id="sc1", beat="detail",
        narration=Narration(t_in=0.0, t_out=5.0, text="x"),
        shot_ref="s1", media_path="/media/x.jpg",
        source=source or {"in_s": 2.0, "out_s": 7.0},
        kenburns=KenBurns(mode="push_in", zoom_max=1.06),
        media_kind=media_kind,
    )


def test_render_segment_imagem_usa_loop1_sem_trim(tmp_path):
    from studio.render.renderer import render_segment

    calls = []

    def _fake_run(args):
        calls.append(args)
        # simula ffmpeg criando o ficheiro de output esperado
        out_path = args[-1]
        with open(out_path, "wb") as f:
            f.write(b"\x00")

    with patch("studio.render.renderer._run", _fake_run):
        entry = _entry(media_kind="image")
        render_segment(entry, 1920, 1080, tmp_path, target_dur=5.0)

    assert len(calls) == 1
    args = calls[0]
    assert "-loop" in args and args[args.index("-loop") + 1] == "1"
    assert "-ss" not in args, "imagem nunca usa -ss (sem janela de origem)"
    assert entry.media_path in args


def test_render_segment_video_continua_a_usar_ss_trim(tmp_path):
    from studio.render.renderer import render_segment

    calls = []

    def _fake_run(args):
        calls.append(args)
        out_path = args[-1]
        with open(out_path, "wb") as f:
            f.write(b"\x00")

    with patch("studio.render.renderer._run", _fake_run):
        entry = _entry(media_kind="video")
        render_segment(entry, 1920, 1080, tmp_path, target_dur=5.0)

    assert len(calls) == 1
    args = calls[0]
    assert "-ss" in args
    assert "-loop" not in args
