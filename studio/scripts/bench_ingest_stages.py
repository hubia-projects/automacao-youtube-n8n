"""Benchmark das etapas do ingest num ficheiro real (sem Gemini).

Mede, com time.perf_counter:
  A) ffprobe duration
  B) SceneDetect ATUAL (ContentDetector full-res) — limitado a N segundos
     para não esperar 9 min; extrapola o custo por segundo.
  C) SceneDetect OTIMIZADO (proxy 360p luma_only) — vídeo completo.
  D) keyframes atual (3 spawns ffmpeg) vs 1-spawn.
  E) SigLIP embed de 3 keyframes (GPU vs CPU).

Uso: uv run python scripts/bench_ingest_stages.py <mp4> [--max-seconds 15]
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np


def t(label: str, fn):
    t0 = time.perf_counter()
    r = fn()
    dt = time.perf_counter() - t0
    print(f"  {label:<55} {dt:7.2f}s")
    return dt, r


def ffprobe_dur(path: Path) -> float:
    """Duração via probe canónico (studio.library.shots.probe_duration) —
    parsing local com -of default mostrou-se não-fiável em ficheiros com
    moov/metadata atípica (devolveu 0.1s para vídeos de 12.4s)."""
    from studio.library.shots import probe_duration
    return probe_duration(path)


def make_proxy(path: Path, out: Path, width: int = 360) -> None:
    """Proxy MJPG 360p sem áudio, mesma duração/fps — para SceneDetect rápido."""
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(path),
         "-vf", f"scale=-2:{width}", "-an", "-c:v", "mjpeg", "-q:v", "3",
         str(out)],
        check=True, capture_output=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mp4", type=Path)
    ap.add_argument("--max-seconds", type=float, default=15.0,
                    help="limite para SceneDetect full-res (extrapolação)")
    args = ap.parse_args()

    mp4 = args.mp4
    print(f"ficheiro: {mp4.name} ({mp4.stat().st_size/1e6:.1f} MB)")
    dur, _ = t("A) ffprobe duration", lambda: ffprobe_dur(mp4))
    print(f"    duração={dur:.1f}s")

    from scenedetect import ContentDetector, detect

    # --- B) SceneDetect atual (full-res), limitado ----------------------------
    t0 = time.perf_counter()
    scenes = detect(str(mp4), ContentDetector(), end_time=args.max_seconds)
    dt_full = time.perf_counter() - t0
    fps_full = args.max_seconds / dt_full
    print(f"  B) SceneDetect full-res ({args.max_seconds:.0f}s limit)  "
          f"{dt_full:7.2f}s  -> {fps_full:.2f}s-video/s  "
          f"(projeção {dur:.0f}s = {dur/fps_full:.0f}s)")
    print(f"     shots encontrados (limit): {len(scenes)}")

    # --- C) SceneDetect otimizado: proxy 360p + luma_only ---------------------
    with tempfile.TemporaryDirectory() as td:
        proxy = Path(td) / "proxy.avi"
        t("C1) proxy ffmpeg 360p mjpeg", lambda: make_proxy(mp4, proxy))
        t0 = time.perf_counter()
        scenes2 = detect(str(proxy), ContentDetector(luma_only=True))
        dt_proxy = time.perf_counter() - t0
        fps_proxy = dur / dt_proxy
        print(f"  C2) SceneDetect proxy 360p luma_only (completo) "
              f"{dt_proxy:7.2f}s  -> {fps_proxy:.2f}s-video/s")
        print(f"     shots encontrados (completo): {len(scenes2)}")
        # validação: timestamps batem com o original?
        if scenes2:
            s, e = scenes2[0]
            print(f"     ex: shot[0] = {s.get_seconds():.2f}..{e.get_seconds():.2f}s")

        # --- D) keyframes: 3 spawns (referência atual) ---------------------------
        outdir = Path(td) / "kf"
        outdir.mkdir()
        t_in, t_out = 0.0, min(10.0, dur)
        span = t_out - t_in
        ts = [t_in + span * (0.05 + 0.9 * i / 2.0) for i in range(3)]

        def kf_3spawn():
            outs = []
            for i, t in enumerate(ts):
                o = outdir / f"a_{i}.jpg"
                subprocess.run(
                    ["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}",
                     "-i", str(mp4), "-frames:v", "1",
                     "-vf", "scale=384:384:force_original_aspect_ratio=increase,crop=384:384",
                     str(o)], check=True, capture_output=True)
                outs.append(o)
            return outs

        d1, outs = t("D1) keyframes 3 spawns ffmpeg (10s span)", kf_3spawn)

        # --- E) SigLIP embed dos 3 keyframes ------------------------------------
        from studio.library.embed import SiglipEmbedder
        emb = SiglipEmbedder(batch_starts=8)
        e1, vecs = t("E) SigLIP embed 3 keyframes (1ª chamada incl. load)",
                     lambda: emb.embed_images(outs))
        e2, _ = t("E2) SigLIP embed 3 keyframes (warm)", lambda: emb.embed_images(outs))
        print(f"     shape={vecs.shape}  dim={emb.dim}  device~{emb._device}")


if __name__ == "__main__":
    sys.exit(main())
