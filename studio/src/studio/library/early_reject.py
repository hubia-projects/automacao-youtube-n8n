"""Early rejection — corta footage inutilizavel ANTES de SceneDetect/SigLIP/Vision.

Fase 2 Optimização (Pass 2): SceneDetect + SigLIP embedding + Vision metadata
sao caros (~30s+ por ficheiro num 4GB VRAM). Rejeitar pre-pipeline evita este
trabalho e ainda marca o shot no provider_cache (negative cache wired em
Pass 3) para nao repetir em proximos runs.

Pre-flight checks (ffprobe):
  - Duracao >= settings.early_reject_min_duration_s (default 2.0s)
  - Resolucao >= settings.early_reject_min_resolution (default 720p)
  - Codec em {h264, hevc, vp9, av1}

Post-flight checks (Vision metadata pre-cacheada):
  - Watermark heuristico (palavras getty, shutterstock, etc.)
  - Wrong-location: Vision nao menciona expected_location nos places

Fail-soft: cada check e independente. ffprobe exception NAO derruba o loop
- so rejeita o ficheiro com reject_code="probe_failed" registado em
cache_mark_rejected (caller decide).
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from studio.config import Settings

log = logging.getLogger("studio.early_reject")


_ACCEPTABLE_CODECS = frozenset({"h264", "hevc", "vp9", "av1"})

# Watermark heuristics - vision keywords + padroes comuns.
_WATERMARK_PATTERNS = (
    re.compile(r"\b(getty|shutterstock|istock|alamy|adobe stock)\b", re.IGNORECASE),
    re.compile(r"\bwatermark\b", re.IGNORECASE),
)

_PROBE_TIMEOUT_S = 15


@dataclass(frozen=True)
class RejectReason:
    """Estrutura imutavel - usada como chave de cache_mark_rejected (reason).

    code: identificador curto para logging/filtros (low_resolution, etc).
    message: explicacao humana para debug.
    """
    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


def _probe(path: Path) -> dict:
    """ffprobe JSON dump. Returns {} se read falhar (caller decide).

    Wrapped com try/except explicito - NAO re-raise para nao interromper
    o topup loop. O caller emite cache_mark_rejected com reason derivado
    desta excecao.
    """
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            timeout=_PROBE_TIMEOUT_S,
            stderr=subprocess.DEVNULL,
        )
        return json.loads(out)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            json.JSONDecodeError) as exc:
        log.warning("ffprobe falhou para %s: %s",
                    path.name, exc.__class__.__name__)
        return {}


def preflight(path: Path, settings: Settings) -> RejectReason | None:
    """Pre-validar file ANTES de ingest (chamado em topup.py loop).

    Returns None se file OK; RejectReason caso contrario.

    Independente de analyze_shot / ingest - so le ffprobe JSON. ~0.1s por
    file (vs ~30s para SceneDetect+SigLIP+Vision). Grande saver quando
    aplicavel.
    """
    # Le Settings com fallback defensivo (mock-incompleto de pytest)
    er_min_duration = float(getattr(settings, "early_reject_min_duration_s", 2.0)
                            or 2.0)
    er_min_resolution = int(getattr(settings, "early_reject_min_resolution", 720)
                             or 720)

    if not path.exists():
        return RejectReason("missing_file", f"path nao existe: {path}")
    if path.stat().st_size < 1024:
        return RejectReason("empty_file", f"{path.name} < 1 KB")

    probe = _probe(path)
    if not probe:
        return RejectReason("probe_failed",
                            f"ffprobe incapaz de ler {path.name}")

    # 1. Duration check
    fmt = probe.get("format") or {}
    try:
        duration = float(fmt.get("duration", 0) or 0)
    except (TypeError, ValueError):
        return RejectReason("invalid_duration",
                            f"{path.name} sem duration valida")
    if duration < er_min_duration:
        return RejectReason(
            "low_duration",
            f"duracao {duration:.2f}s < {er_min_duration}s",
        )

    # 2. Stream video + resolucao + codec
    streams = probe.get("streams") or []
    video_stream = next(
        (s for s in streams
         if (s.get("codec_type") or "").lower() == "video"),
        None,
    )
    if video_stream is None:
        return RejectReason("no_video_stream",
                            f"{path.name} sem stream video")
    try:
        height = int(video_stream.get("height", 0) or 0)
    except (TypeError, ValueError):
        return RejectReason("invalid_resolution",
                            f"{path.name} sem altura valida")
    if height < er_min_resolution:
        return RejectReason(
            "low_resolution",
            f"altura {height}p < {er_min_resolution}p",
        )

    codec = (video_stream.get("codec_name") or "").lower()
    if codec not in _ACCEPTABLE_CODECS:
        return RejectReason(
            "unsupported_codec",
            f"codec '{codec}' nao esta nos aceitaveis {sorted(_ACCEPTABLE_CODECS)}",
        )

    return None


_ACCEPTABLE_IMAGE_FORMATS = frozenset({"JPEG", "PNG", "WEBP"})


def preflight_image(path: Path, settings: Settings) -> RejectReason | None:
    """Pre-validar IMAGEM antes de ingest (item MediaKind — closure de
    cobertura multi-provider). Paralelo a `preflight()`, NUNCA partilhado
    com ele: vídeo exige duration+codec de vídeo (inaplicável a uma
    still); imagem exige resolução mínima + formato — usa PIL (já
    dependência existente via embed.py), não ffprobe.

    Returns None se OK; RejectReason caso contrário.
    """
    img_min_w = int(getattr(settings, "image_min_width", 1280) or 1280)
    img_min_h = int(getattr(settings, "image_min_height", 720) or 720)

    if not path.exists():
        return RejectReason("missing_file", f"path não existe: {path}")
    if path.stat().st_size < 1024:
        return RejectReason("empty_file", f"{path.name} < 1 KB")

    try:
        from PIL import Image
        with Image.open(path) as img:
            fmt = (img.format or "").upper()
            width, height = img.size
    except Exception as exc:
        return RejectReason("probe_failed",
                            f"PIL incapaz de ler {path.name}: "
                            f"{exc.__class__.__name__}")

    if fmt not in _ACCEPTABLE_IMAGE_FORMATS:
        return RejectReason(
            "unsupported_format",
            f"formato '{fmt}' não está nos aceitáveis "
            f"{sorted(_ACCEPTABLE_IMAGE_FORMATS)}")
    if width < img_min_w or height < img_min_h:
        return RejectReason(
            "low_resolution",
            f"{width}x{height} < mínimo {img_min_w}x{img_min_h}")

    return None


def postflight(metadata: dict,
                expected_location: str | None = None) -> RejectReason | None:
    """Pos-validar metadata de Vision: watermark + wrong-location.

    Args:
        metadata: meta_json dumped (dict) da analyze_shot.
                  Campos esperados: summary, places, objects.
        expected_location: nome canonico da location esperada ("Porto", etc.).
                            None = sem constraint de location.

    Returns None se OK; RejectReason caso contrario.
    """
    summary = (metadata.get("summary") or "").lower()
    places = [str(p).lower() for p in (metadata.get("places") or [])]
    objects = [str(o).lower() for o in (metadata.get("objects") or [])]
    haystack = "\n".join([summary] + places + objects)

    # 1. Watermark heuristic
    for pattern in _WATERMARK_PATTERNS:
        if pattern.search(haystack):
            return RejectReason(
                "watermark",
                f"watermark detectado via Vision: pattern {pattern.pattern!r}",
            )

    # 2. Wrong-location (so se expected_location fornecido)
    if expected_location:
        loc_lower = expected_location.strip().lower()
        if loc_lower and places:
            mentioned = any(loc_lower in p for p in places)
            if not mentioned:
                detected = ", ".join(places[:3])
                return RejectReason(
                    "wrong_location",
                    f"esperado '{expected_location}' mas Vision viu: {detected}",
                )

    return None
