"""Teste definitivo: replica as etapas reais do ingest_file num ficheiro real,
com timers por etapa + timestamps absolutos. Inclui chamada Gemini REAL
(custo ~$0.0007) — não escreve no LanceDB.

Uso: uv run python scripts/bench_ingest_real.py <mp4>
"""
from __future__ import annotations

import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


def log(msg: str) -> None:
    print(f"{datetime.now().strftime('%H:%M:%S')}  {msg}", flush=True)


def main() -> None:
    mp4 = Path(sys.argv[1])
    from studio.config import get_settings
    from studio.library.embed import SiglipEmbedder
    from studio.library.shots import detect_shots, extract_keyframes, probe_duration
    from studio.library.metadata import analyze_shot

    settings = get_settings()
    log(f"=== INICIO {mp4.name} ({mp4.stat().st_size/1e6:.1f} MB) ===")

    t0 = time.perf_counter()
    dur = probe_duration(mp4)
    log(f"probe_duration: {dur:.1f}s ({time.perf_counter()-t0:.1f}s)")

    t0 = time.perf_counter()
    shots = detect_shots(mp4)
    log(f"detect_shots: {len(shots)} shots em {time.perf_counter()-t0:.1f}s "
       f"-> {dur/max(time.perf_counter()-t0,1e-9):.1f} s-video/s")

    embedder = SiglipEmbedder()
    all_kf = []
    for idx, (t_in, t_out) in enumerate(shots):
        t0 = time.perf_counter()
        kfs = extract_keyframes(mp4, t_in, t_out, Path("/tmp/bench_kf") / f"{idx}")
        dt = time.perf_counter() - t0
        log(f"  keyframes shot{idx} ({t_out-t_in:.1f}s): {len(kfs)} em {dt:.1f}s")
        all_kf.extend(kfs)

    t0 = time.perf_counter()
    vecs = embedder.embed_images(all_kf)
    log(f"siglip embed {len(all_kf)} kf: {time.perf_counter()-t0:.1f}s (incl load 1ª vez)")

    t0 = time.perf_counter()
    vecs = embedder.embed_images(all_kf)
    log(f"siglip embed warm: {time.perf_counter()-t0:.1f}s")

    # Gemini REAL (1 call, custo ~$0.0007) — replica analyze_shot exato
    t0 = time.perf_counter()
    meta, cost = analyze_shot(all_kf[:3], settings, source_hint=mp4.name)
    log(f"analyze_shot (Gemini real): {time.perf_counter()-t0:.1f}s cost=${cost:.4f} "
       f"-> places={meta.places} landmarks={meta.landmarks}")

    log("=== FIM ===")


if __name__ == "__main__":
    sys.exit(main())
