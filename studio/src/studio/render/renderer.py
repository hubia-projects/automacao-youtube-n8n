"""Render FFmpeg (ADR-0004) — narração é o master de sincronização.

- Segmentos renderizados individualmente com cache por hash (fix loops só
  re-renderizam o alterado).
- xfade SEM drift: o segmento B estende a janela de origem D segundos para
  trás quando há headroom; offset = lenA - D → duração total preservada.
  Sem headroom → corte seco (fallback).
- Proxy 480p ultrafast com scene-id+timecode queimados (input do revisor).
- Final: loudnorm 2-pass -14 LUFS; música opcional com sidechaincompress;
  legendas ASS burn-in opcional; color: leve vibrance/eq de casa.
"""

from __future__ import annotations

import hashlib
import json
import logging
import subprocess
from pathlib import Path

from studio.config import Settings
from studio.render.timeline import Timeline, TimelineEntry

log = logging.getLogger("studio.render")

FPS = 30


def _run(args: list[str]) -> None:
    proc = subprocess.run(["ffmpeg", "-y", "-v", "error", *args],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg falhou: {proc.stderr.strip()[:400]}")


def _probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def _kenburns_filter(entry: TimelineEntry, w: int, h: int) -> str:
    kb = entry.kenburns
    if kb.mode == "none":
        return ""
    step = (kb.zoom_max - 1.0) / (FPS * max(entry.narration.t_out - entry.narration.t_in, 1))
    if kb.mode == "drift_lateral":
        x = "iw/2-(iw/zoom/2)+((zoom-1)*iw/8)"
    else:  # push_in
        x = "iw/2-(iw/zoom/2)"
    # s= obrigatório: default do zoompan é 1280x720, partia o concat
    return (f"zoompan=z='min(zoom+{step:.6f},{kb.zoom_max})':d=1:"
            f"x='{x}':y='ih/2-(ih/zoom/2)':fps={FPS}:s={w}x{h}")


RENDER_VERSION = "v3"  # bump invalida cache quando os filtros mudam


def _segment_hash(entry: TimelineEntry, w: int, h: int, head_ext: float,
                  target_dur: float) -> str:
    payload = (entry.model_dump_json()
               + f"|{w}x{h}|{head_ext:.3f}|{target_dur:.3f}|{RENDER_VERSION}")
    return hashlib.sha1(payload.encode()).hexdigest()[:16]


def render_segment(entry: TimelineEntry, w: int, h: int, cache_dir: Path, *,
                   target_dur: float, head_ext: float = 0.0,
                   preset: str = "veryfast") -> Path:
    """Um clip de vídeo (sem áudio). target_dur pode exceder a janela de
    origem (pausas da narração) — o último frame congela (tpad clone).
    Cacheado por hash."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"{_segment_hash(entry, w, h, head_ext, target_dur)}.mp4"
    if out.exists():
        return out

    src_in = max(0.0, entry.source["in_s"] - head_ext)
    window = (entry.source["out_s"] - entry.source["in_s"]) + (entry.source["in_s"] - src_in)
    total = target_dur + (entry.source["in_s"] - src_in)
    pad = max(0.0, total - window)

    vf = [f"scale={w}:{h}:force_original_aspect_ratio=increase",
          f"crop={w}:{h}", "setsar=1", f"fps={FPS}"]
    kb = _kenburns_filter(entry, w, h)
    if kb:
        vf.append(kb)
    # color de casa: saturação/contraste subtis (LUTs entram quando existirem)
    vf.append("eq=saturation=1.06:contrast=1.02")
    if pad > 0.01:
        vf.append(f"tpad=stop_mode=clone:stop_duration={pad:.3f}")

    _run(["-ss", f"{src_in:.3f}", "-t", f"{min(window, total):.3f}",
          "-i", entry.media_path, "-vf", ",".join(vf), "-t", f"{total:.3f}",
          "-an", "-c:v", "libx264", "-preset", preset,
          "-pix_fmt", "yuv420p", str(out)])
    return out


def _concat_reencode(files: list[Path], out: Path, preset: str) -> Path:
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{p}'\n" for p in files))
    # re-encode: timestamps limpos (concat -c copy gera PTS que partem o xfade)
    _run(["-f", "concat", "-safe", "0", "-i", str(lst),
          "-c:v", "libx264", "-preset", preset, "-pix_fmt", "yuv420p", str(out)])
    return out


def _assemble_video(timeline: Timeline, w: int, h: int, cache_dir: Path,
                    preset: str) -> tuple[Path, float]:
    """Segmentos → vídeo contínuo sincronizado com a narração.

    A duração alvo de cada entrada cobre até ao início da próxima
    (pausas incluídas). xfade só quando o segmento seguinte tem headroom
    na origem (source_in ≥ fade) — caso contrário corte seco."""
    xfade = 0.4
    entries = timeline.entries
    narration_dur = _probe_duration(Path(timeline.audio["narration"]))
    targets: list[float] = []
    for i, e in enumerate(entries):
        # última entrada estica até ao fim do áudio (silêncio final coberto)
        end = entries[i + 1].narration.t_in if i + 1 < len(entries) \
            else max(e.narration.t_out, narration_dur)
        targets.append(max(0.1, end - e.narration.t_in))

    # grupos separados apenas por xfades COM headroom real
    groups: list[list[int]] = [[0]]
    fades: list[float] = []
    for i in range(1, len(entries)):
        e = entries[i]
        head = min(xfade, e.source["in_s"])
        if e.transition_in.type == "xfade" and head > 0.05:
            groups.append([i])
            fades.append(head)
        else:
            groups[-1].append(i)

    group_files: list[Path] = []
    group_lens: list[float] = []
    for gi, idxs in enumerate(groups):
        seg_files = []
        for j, i in enumerate(idxs):
            head = fades[gi - 1] if (gi > 0 and j == 0) else 0.0
            seg_files.append(render_segment(entries[i], w, h, cache_dir,
                                            target_dur=targets[i], head_ext=head,
                                            preset=preset))
        gf = seg_files[0] if len(seg_files) == 1 else \
            _concat_reencode(seg_files, cache_dir / f"group_{gi}.mp4", preset)
        group_files.append(gf)
        group_lens.append(_probe_duration(gf))

    if len(group_files) == 1:
        return group_files[0], group_lens[0]

    # cadeia de xfades (todas as junções aqui têm fade>0 por construção)
    inputs: list[str] = []
    for gf in group_files:
        inputs += ["-i", str(gf)]
    chains = []
    acc, acc_len = "[0:v]", group_lens[0]
    for i in range(1, len(group_files)):
        fade = fades[i - 1]
        out_label = f"[v{i}]"
        chains.append(f"{acc}[{i}:v]xfade=transition=fade:duration={fade:.3f}:"
                      f"offset={acc_len - fade:.3f}{out_label}")
        acc_len = acc_len + group_lens[i] - fade
        acc = out_label
    out = cache_dir / "assembled.mp4"
    _run([*inputs, "-filter_complex", ";".join(chains), "-map", acc,
          "-c:v", "libx264", "-preset", preset, "-pix_fmt", "yuv420p", str(out)])
    return out, acc_len


def _measure_loudness(path: Path) -> dict:
    proc = subprocess.run(
        ["ffmpeg", "-i", str(path), "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json",
         "-f", "null", "-"], capture_output=True, text=True)
    raw = proc.stderr[proc.stderr.rfind("{"):proc.stderr.rfind("}") + 1]
    return json.loads(raw)


def _audio_filter(measured: dict | None, narr_idx: int, music_idx: int | None) -> str:
    if measured:  # 2ª passagem com valores medidos (linear)
        ln = (f"loudnorm=I=-14:TP=-1.5:LRA=11:linear=true:"
              f"measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:"
              f"measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}")
    else:
        ln = "loudnorm=I=-14:TP=-1.5:LRA=11"
    if music_idx is not None:
        # ducking real: música comprimida pela narração (sidechain)
        return (f"[{music_idx}:a]volume=0.35[bg];[{narr_idx}:a]asplit=2[nar][key];"
                f"[bg][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck];"
                f"[nar][duck]amix=inputs=2:duration=first:normalize=0,{ln}[aout]")
    return f"[{narr_idx}:a]{ln}[aout]"


def render_video(timeline: Timeline, out_path: Path, settings: Settings, *,
                 proxy: bool = False, ass_path: Path | None = None,
                 burn_overlay: bool = False) -> Path:
    """Render completo: vídeo montado + narração (+música) + legendas."""
    w, h = (854, 480) if proxy else (settings.output_width, settings.output_height)
    preset = "ultrafast" if proxy else settings.render_preset
    cache_dir = out_path.parent / ("segments_proxy" if proxy else "segments_final")

    video, _ = _assemble_video(timeline, w, h, cache_dir, preset)
    narration = Path(timeline.audio["narration"])
    music = timeline.audio.get("music_track")

    vf: list[str] = []
    if burn_overlay:  # scene-id + timecode para o revisor (Fase 6)
        vf.append("drawtext=text='%{pts\\:hms}':x=20:y=20:fontsize=28:"
                  "fontcolor=white:box=1:boxcolor=black@0.5")
    if ass_path is not None:
        vf.append(f"ass={ass_path}")

    measured = None
    if not proxy:  # loudnorm 2-pass só no final (proxy não precisa)
        measured = _measure_loudness(narration)

    args: list[str] = ["-i", str(video), "-i", str(narration)]
    afilter = _audio_filter(measured, narr_idx=1, music_idx=None)
    if music:
        args = ["-i", str(video), "-i", str(narration), "-stream_loop", "-1",
                "-i", str(music)]
        afilter = _audio_filter(measured, narr_idx=1, music_idx=2)
    filter_complex = afilter
    maps = ["-map", "0:v", "-map", "[aout]"]
    if vf:
        filter_complex = f"[0:v]{','.join(vf)}[vout];" + afilter
        maps = ["-map", "[vout]", "-map", "[aout]"]

    _run([*args, "-filter_complex", filter_complex, *maps,
          "-c:v", "libx264", "-preset", preset,
          "-c:a", "aac", "-b:a", "192k", "-shortest", str(out_path)])
    log.info("render %s: %s (%.1fs)", "proxy" if proxy else "final",
             out_path.name, _probe_duration(out_path))
    return out_path
