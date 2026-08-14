"""Secção 48 (fecho de cobertura multi-provider): render REAL (ffmpeg de
facto, não mockado) de uma timeline com 1 vídeo + 2 imagens — verifica
duração total ~= duração do áudio, sem freeze/corte, e que o mecanismo de
imagem (loop 1 + Ken Burns) produz um output válido lado a lado com vídeo
normal na MESMA timeline."""
from __future__ import annotations

import subprocess

import pytest


def _probe_duration(path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


@pytest.fixture(scope="module")
def _video_source(tmp_path_factory):
    d = tmp_path_factory.mktemp("render_mix_video")
    out = d / "source.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", "testsrc=size=640x360:rate=24:duration=10",
         "-pix_fmt", "yuv420p", str(out)], check=True)
    return out


@pytest.fixture(scope="module")
def _narration_audio(tmp_path_factory):
    d = tmp_path_factory.mktemp("render_mix_audio")
    out = d / "narration.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", "sine=frequency=440:duration=15", str(out)], check=True)
    return out


@pytest.fixture(scope="module")
def _images(tmp_path_factory):
    from PIL import Image
    d = tmp_path_factory.mktemp("render_mix_images")
    paths = []
    for i, color in enumerate([(200, 50, 50), (50, 200, 50)]):
        p = d / f"img{i}.jpg"
        Image.new("RGB", (1920, 1080), color=color).save(p, format="JPEG")
        paths.append(p)
    return paths


def test_render_video_com_video_e_2_imagens_duracao_e_sync(
    tmp_path, _video_source, _narration_audio, _images,
):
    from studio.config import Settings
    from studio.render.renderer import render_video
    from studio.render.timeline import (
        KenBurns, Narration, Timeline, TimelineEntry, Transition,
    )

    entries = [
        TimelineEntry(
            scene_id="s1", beat="hook",
            narration=Narration(t_in=0.0, t_out=5.0, text="video shot"),
            shot_ref="v1", media_path=str(_video_source),
            source={"in_s": 0.0, "out_s": 5.0},
            kenburns=KenBurns(mode="none"), media_kind="video",
        ),
        TimelineEntry(
            scene_id="s2", beat="detail",
            narration=Narration(t_in=5.0, t_out=10.0, text="imagem A"),
            shot_ref="img1", media_path=str(_images[0]),
            source={"in_s": 0.0, "out_s": 5.0},
            kenburns=KenBurns(mode="push_in", zoom_max=1.06),
            media_kind="image",
        ),
        TimelineEntry(
            scene_id="s3", beat="detail",
            narration=Narration(t_in=10.0, t_out=15.0, text="imagem B"),
            shot_ref="img2", media_path=str(_images[1]),
            source={"in_s": 0.0, "out_s": 5.0},
            kenburns=KenBurns(mode="drift_lateral", zoom_max=1.04),
            media_kind="image",
        ),
    ]
    timeline = Timeline(
        video_id="test-mix", entries=entries,
        audio={"narration": str(_narration_audio), "music_track": None},
    )
    settings = Settings(mock_mode=True, data_root=tmp_path / "data",
                        output_width=640, output_height=360,
                        render_preset="ultrafast")
    out_path = tmp_path / "final.mp4"
    render_video(timeline, out_path, settings)

    assert out_path.exists()
    dur = _probe_duration(out_path)
    assert 14.0 <= dur <= 16.0, (
        f"duração final {dur:.2f}s devia acompanhar o áudio (~15s)")
