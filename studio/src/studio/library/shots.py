"""Shot detection (PySceneDetect) + extração de keyframes (ffmpeg).

Unidade de retrieval da biblioteca = shot, não ficheiro (ARCHITECTURE.md §6).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

MIN_SHOT_SECONDS = 1.0  # shots mais curtos não são utilizáveis num corte


def probe_duration(video_path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video_path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def detect_shots(video_path: Path) -> list[tuple[float, float]]:
    """Divide o vídeo em shots [(t_in, t_out)]. Sem cortes detetados → 1 shot."""
    from scenedetect import ContentDetector, detect

    scenes = detect(str(video_path), ContentDetector())
    shots = [(s.seconds, e.seconds) for s, e in scenes]
    if not shots:
        shots = [(0.0, probe_duration(video_path))]
    return [(a, b) for a, b in shots if (b - a) >= MIN_SHOT_SECONDS]


def extract_keyframes(video_path: Path, t_in: float, t_out: float,
                      out_dir: Path, n: int = 3) -> list[Path]:
    """N keyframes distribuídos no shot (início/meio/fim), JPEG 384px."""
    out_dir.mkdir(parents=True, exist_ok=True)
    span = t_out - t_in
    # margem de 5% para evitar frames de transição nas fronteiras do shot
    ts = [t_in + span * (0.05 + 0.9 * i / max(n - 1, 1)) for i in range(n)]
    paths = []
    for i, t in enumerate(ts):
        out = out_dir / f"kf_{i}.jpg"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(video_path),
             "-frames:v", "1", "-vf", "scale=384:384:force_original_aspect_ratio=increase,crop=384:384",
             str(out)],
            check=True, capture_output=True,
        )
        paths.append(out)
    return paths
