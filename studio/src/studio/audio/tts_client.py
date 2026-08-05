"""Cliente multivozes (TTS local, API OpenAI-compatible em /v1/audio/speech).

Texto longo é dividido em chunks (~420 chars, fronteira de frase) — port do
comportamento comprovado do ttsService.js legacy — e concatenado com ffmpeg.
Mock: silêncio com duração proporcional às palavras (determinístico).
"""

from __future__ import annotations

import logging
import re
import subprocess
import tempfile
from pathlib import Path

import httpx

from studio.config import Settings

log = logging.getLogger("studio.tts")

CHUNK_CHARS = 420


def health(settings: Settings) -> bool:
    try:
        resp = httpx.get(settings.multivozes_base_url.rstrip("/") + "/models",
                         headers={"Authorization": f"Bearer {settings.multivozes_api_key}"},
                         timeout=5)
        return resp.status_code < 500
    except httpx.HTTPError:
        return False


def _chunks(text: str) -> list[str]:
    sentences = re.split(r"(?<=[.!?…])\s+", text.strip())
    out, cur = [], ""
    for s in sentences:
        if cur and len(cur) + len(s) + 1 > CHUNK_CHARS:
            out.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        out.append(cur)
    return out


def _tts_chunk(text: str, out_path: Path, settings: Settings, attempt_max: int = 3) -> None:
    url = settings.multivozes_base_url.rstrip("/") + "/audio/speech"
    last: Exception | None = None
    for attempt in range(1, attempt_max + 1):
        try:
            resp = httpx.post(
                url,
                headers={"Authorization": f"Bearer {settings.multivozes_api_key}"},
                json={"model": "tts-1", "input": text, "voice": settings.tts_voice,
                      "response_format": "mp3"},
                timeout=120,
            )
            resp.raise_for_status()
            out_path.write_bytes(resp.content)
            return
        except httpx.HTTPError as exc:
            last = exc
            log.warning("TTS chunk falhou (tentativa %d/%d): %s", attempt, attempt_max, exc)
    raise RuntimeError(f"TTS falhou após {attempt_max} tentativas: {last}")


def _mock_wav(text: str, out_wav: Path, settings: Settings) -> None:
    # tom (não silêncio): loudness mensurável nos testes de render
    seconds = max(1.0, len(text.split()) * 60.0 / settings.words_per_minute)
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", f"sine=frequency=220:sample_rate=24000:duration={seconds:.2f}",
         "-af", "volume=0.3", str(out_wav)],
        check=True,
    )


def _ensure_multivozes(settings: Settings) -> bool:
    """Healthcheck + auto-arranque via docker compose (best-effort)."""
    import time

    if health(settings):
        return True
    engine_dir = Path(__file__).resolve().parents[4] / "multivozes_br_engine"
    if engine_dir.exists():
        log.warning("multivozes DOWN — a tentar docker compose up -d")
        subprocess.run(["docker", "compose", "up", "-d"], cwd=engine_dir,
                       capture_output=True)
        for _ in range(20):
            time.sleep(3)
            if health(settings):
                return True
    return False


def _tts_chunk_elevenlabs(text: str, out_path: Path, settings: Settings) -> None:
    resp = httpx.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{settings.elevenlabs_voice_id}",
        headers={"xi-api-key": settings.elevenlabs_api_key},
        json={"text": text, "model_id": "eleven_multilingual_v2"},
        timeout=120,
    )
    resp.raise_for_status()
    out_path.write_bytes(resp.content)


def synthesize(text: str, out_wav: Path, settings: Settings) -> float:
    """Gera narração wav (24 kHz mono). Devolve duração em segundos.
    Cascata: multivozes (com auto-arranque) → ElevenLabs → erro (fail-closed)."""
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    if settings.mock_mode:
        _mock_wav(text, out_wav, settings)
    else:
        use_eleven = False
        if not _ensure_multivozes(settings):
            if settings.elevenlabs_api_key and settings.elevenlabs_voice_id:
                log.warning("multivozes indisponível — fallback ElevenLabs")
                use_eleven = True
            else:
                raise RuntimeError("multivozes DOWN e sem ELEVENLABS_API_KEY — "
                                   "TTS impossível (fail-closed)")
        with tempfile.TemporaryDirectory() as td:
            parts = []
            for i, chunk in enumerate(_chunks(text)):
                part = Path(td) / f"part_{i:03d}.mp3"
                if use_eleven:
                    _tts_chunk_elevenlabs(chunk, part, settings)
                else:
                    try:
                        _tts_chunk(chunk, part, settings)
                    except RuntimeError:
                        if not (settings.elevenlabs_api_key
                                and settings.elevenlabs_voice_id):
                            raise
                        log.warning("multivozes falhou a meio — ElevenLabs")
                        use_eleven = True
                        _tts_chunk_elevenlabs(chunk, part, settings)
                parts.append(part)
            concat_list = Path(td) / "list.txt"
            concat_list.write_text("".join(f"file '{p}'\n" for p in parts))
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
                 "-i", str(concat_list), "-ar", "24000", "-ac", "1", str(out_wav)],
                check=True,
            )
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(out_wav)],
        capture_output=True, text=True, check=True,
    )
    return float(probe.stdout.strip())
