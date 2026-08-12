"""Shot detection (PySceneDetect) + extração de keyframes (ffmpeg).

Unidade de retrieval da biblioteca = shot, não ficheiro (ARCHITECTURE.md §6).

UPSTREAM-CHANGE 2026-08-11 §P1 zero-shot fallback (cobre raw scenes == []):
  - Vídeo VÁLIDO mas sem SceneDetect cuts → 1 shot fallback (0, duration).
  - Vídeo INVÁLIDO (corrupted, decode fail, duration<=0) → fail-fast em
    `probe_video` que devolve `VideoProbe.invalid=True` antes de chamar
    detect_shots. Caller deve marcar FAILED_PERMANENT (nunca DONE).
  - Invariante: se detect_shots retorna [] AND duration>0 → fallback [(0, duration)].

UPSTREAM-CHANGE 2026-08-11 TEST 5C §P2 POST-FILTER zero-shot fix:
  - Vídeo válido + pyscenedetect devolve raw shots sub-1s consecutivos
    (e.g. [0–0.4, 0.4–0.9, 0.9–1.4]): TENTATIVA merge adjacency primeiro
    (vira [0–1.4], ≥MIN). Se mesmo após merge nenhum usable ≥ MIN_SHOT_SECONDS,
    fallback whole-video (0, duration).
  - Invariante pós-filtro: proved válido → detect_shots SEMPRE devolve
    lista com ≥1 shot usable. Mantém o invariant A1 intacto
    (ingest_asset.py marca empty_media se shots_added==0).

Motivo histórico: TEST 5B mostrou 5/5 com shots=0. Root cause: vídeos
Pexels com várias cenas curtas sub-1s que pyscenedetect detectava mas
o filter MIN_SHOT_SECONDS=1.0 engolia. Pós-fix, vídeo válido nunca fica
com usable=[].
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

MIN_SHOT_SECONDS = 1.0  # shots mais curtos não são utilizáveis num corte
MIN_VIDEO_SECONDS = 0.5  # abaixo disto é suspicious, válido? caller decide

log = logging.getLogger("studio.shots")


@dataclass
class VideoProbe:
    """Resultado de `probe_video` — diagnóstico barato antes de qualquer
    processamento SigLIP/Gemini.

    Attributes:
        valid: True só se duration>0 E codec descodificável E ficheiro
            acessível. False em QUALQUER falha de ffprobe.
        duration: segundos (0.0 se invalid).
        width, height: resolução em pixels (0,0 se invalid).
        codec: string codec_name (\"\" se invalid).
        error: string com type de erro (\"\" se valid).
    """
    valid: bool
    duration: float
    width: int
    height: int
    codec: str
    error: str = ""


def probe_video(video_path: Path) -> VideoProbe:
    """Valida ficheiro mp4/mov em UMA chamada ffprobe.

    Barato (~5-10ms). Não processa vídeo. Devolve dataclass com `valid`
    bool + dimensões. Caller usa `valid` para decidir:
      - valid=True + shots=[] → fallback [(0, duration)]
      - valid=True + shots=N  → detector continua
      - valid=False → FAILED_PERMANENT (corrupted/unreachable).

    Raises:
        Não raise. Falhas viram VideoProbe(valid=False, error=...).
    """
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration:stream=width,height,codec_name",
             "-of", "json", str(video_path)],
            capture_output=True, text=True, timeout=10,
        )
    except subprocess.TimeoutExpired:
        return VideoProbe(False, 0.0, 0, 0, "", error="ffprobe_timeout")
    except Exception as exc:
        return VideoProbe(False, 0.0, 0, 0, "",
                          error=f"ffprobe_unreachable:{exc.__class__.__name__}")
    if out.returncode != 0:
        return VideoProbe(False, 0.0, 0, 0, "",
                          error=f"ffprobe_exit_{out.returncode}")
    try:
        import json as _json
        d = _json.loads(out.stdout)
    except Exception as exc:
        return VideoProbe(False, 0.0, 0, 0, "",
                          error=f"ffprobe_json:{exc.__class__.__name__}")
    fmt = d.get("format", {}) or {}
    try:
        duration = float(fmt.get("duration", 0.0) or 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    width = height = 0
    codec = ""
    for s in (d.get("streams", []) or []):
        if (s.get("codec_type") or "") == "video":
            try:
                width = int(s.get("width", 0) or 0)
                height = int(s.get("height", 0) or 0)
            except (TypeError, ValueError):
                pass
            codec = s.get("codec_name", "") or ""
            break
    if duration <= 0 or duration < MIN_VIDEO_SECONDS:
        return VideoProbe(False, duration, width, height, codec,
                          error=f"duration_invalid (duration={duration:.2f})")
    return VideoProbe(True, duration, width, height, codec)


def probe_duration(video_path: Path) -> float:
    """Legacy mantido para compat. Para diagnóstico rico use `probe_video`."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video_path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def _merge_adjacent_shots(
    raw: list[tuple[float, float]],
    *,
    min_seconds: float = MIN_SHOT_SECONDS,
    max_gap_seconds: float = 0.5,
) -> list[tuple[float, float]]:
    """Combina shots SÓ quando (a) há overlap real (próximo começa antes do
    corrente acabar) — sempre funde, toma max(end) — ou (b) o shot corrente
    ainda está sub-`min_seconds` E o gap para o próximo é <= max_gap_seconds.
    Nunca funde dois shots já utilizáveis (>= min_seconds) que apenas
    estejam contíguos ou levemente separados.

    Edge cases:
      - raw vazio → [].
      - 1 shot → [raw[0]].
      - shot corrente já >= min_seconds e sem overlap → NUNCA funde com o
        seguinte, mesmo contíguo (gap=0) — pyscenedetect devolve sempre
        cenas contíguas (fim da cena N = início da N+1); fundir só por
        adjacência (sem o guard de duração) fundia TODAS as cenas de
        qualquer vídeo num único shot — bug real, corrigido aqui.
      - shots afastados > max_gap (e já sub-min) → break em merged list.

    Finalidade: TEST 5C §P2 — quando pyscenedetect devolve várias cenas
    sub-1s (ex: [0–0.4, 0.4–0.9, 0.9–1.4]), merge gera um único shot
    com duração ≥ MIN_SHOT_SECONDS. Vídeos com cortes normais (≥1s cada)
    mantêm-se como shots distintos.
    """
    if not raw:
        return []
    sorted_shots = sorted(raw, key=lambda x: (x[0], x[1]))
    merged: list[tuple[float, float]] = []
    cur_start, cur_end = sorted_shots[0]
    for s, e in sorted_shots[1:]:
        gap = s - cur_end
        overlap = gap < 0
        if overlap or ((cur_end - cur_start) < min_seconds and gap <= max_gap_seconds):
            cur_end = max(cur_end, e)
        else:
            merged.append((cur_start, cur_end))
            cur_start, cur_end = s, e
    merged.append((cur_start, cur_end))
    return merged


def detect_shots(video_path: Path) -> list[tuple[float, float]]:
    """Divide o vídeo em shots [(t_in, t_out)]. Pós-fallback §P2.

    Algoritmo:
      1. probe_video rápido (defesa): invalid → [].
      2. pyscenedetect detect: falha → fallback [(0, probe.duration)].
      3. raw = [(s.seconds, e.seconds) for s, e in scenes].
      4. merge_adjacent(raw) → merged (combina cenas contíguas sub-MIN).
      5. usable_merged = [s for s in merged if s[1]-s[0] >= MIN_SHOT_SECONDS].
      6. usable_raw    = [s for s in raw if s[1]-s[0] >= MIN_SHOT_SECONDS]
                          (só usado se usable_merged vazio E probe válido).
      7. Final fallback:
         - usable_merged não-vazio → devolve usable_merged.
         - usable_merged vazio E raw não-vazio E probe válido
           → tenta usable_raw (NÃO-MERGE filtered shots).
         - usable_merged vazio E usable_raw vazio E probe válido
           → fallback [(0, probe.duration)] (whole-video).
         - probe inválido → [].

    Hot path: caller invocou `probe_video(valid=True)` antes (defesa extra).
    """
    from scenedetect import ContentDetector, detect

    probe = probe_video(video_path)
    if not probe.valid:
        return []  # Caller decide o outcome (FAILED_PERMANENT)

    try:
        scenes = detect(str(video_path), ContentDetector())
    except Exception as exc:
        log.warning("detect_shots: pyscenedetect falhou (%s) — fallback whole-video",
                    exc.__class__.__name__)
        return [(0.0, probe.duration)]

    raw = [(s.seconds, e.seconds) for s, e in scenes]

    if not raw:
        # §P1: vídeo válido sem cortes detectados.
        return [(0.0, probe.duration)]

    # §P2: merge adjacency primeiro.
    merged = _merge_adjacent_shots(raw)
    usable_merged = [s for s in merged if (s[1] - s[0]) >= MIN_SHOT_SECONDS]
    if usable_merged:
        return usable_merged

    # merged todo sub-MIN (e.g. uma única cena micro de 0.4s).
    # Tentar raw filtrado — pode haver >= MIN_SHOT_SECONDS no raw mesmo
    # se o merge fundiu várias para algo curto.
    usable_raw = [s for s in raw if (s[1] - s[0]) >= MIN_SHOT_SECONDS]
    if usable_raw:
        return usable_raw

    # Tudo falhou: vídeo válido com cenas utilizáveis < 1s isoladas
    # E sem merged suficiente. Fallback whole-video via (0, dur).
    log.info("detect_shots: vídeos válidos com raw/merged < MIN_SHOT_SECONDS — "
             "fallback whole-video (0, %.3fs)", probe.duration)
    return [(0.0, probe.duration)]


def extract_keyframes(video_path: Path, t_in: float, t_out: float,
                      out_dir: Path, n: int = 3) -> list[Path]:
    """N keyframes distribuídos no shot (início/meio/fim), JPEG 384px."""
    out_dir.mkdir(parents=True, exist_ok=True)
    span = t_out - t_in
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


def extract_representative_frame(
    video_path: Path,
    out_path: Path,
    duration: float,
) -> Path:
    """P3 (TEST 5C) cheap frame extraction: 1 frame central do vídeo.

    Usado pelo picker v7 para prescreen SigLIP de até 50 candidatos
    sem o custo de extract_keyframes × N shots. Output JPEG 384×384
    (mesma pipeline de extract_keyframes).

    Returns: out_path (caller trata erros).
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    t = max(0.5, duration / 2.0)
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(video_path),
         "-frames:v", "1", "-vf", "scale=384:384:force_original_aspect_ratio=increase,crop=384:384",
         str(out_path)],
        check=True, capture_output=True,
    )
    return out_path
