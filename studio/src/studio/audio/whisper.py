"""Word timestamps locais — faster-whisper (custo $0, ADR §10).

Fase 1B: modelo "base" por default (accuracy ms suficiente para A/V sync,
~10× mais rápido que 'large-v3-turbo'). Auto-detect GPU entre fases
(SigLIP faz .unload() em CPU no fim do 08_matching — Whisper pode
reutilizar VRAM temporariamente). Pré-process: 16kHz mono é o formato
ideal para Whisper; passamos o áudio por ffmpeg uma vez (idempotente,
cache em tmp). Mock: timing uniforme determinístico a partir do texto
(~wpm config), como o fallback comprovado do sistema legacy.
"""

from __future__ import annotations

import logging
from pathlib import Path

from studio.config import Settings

log = logging.getLogger("studio.whisper")


def _mock_words(script_text: str, settings: Settings) -> list[dict]:
    words = script_text.split()
    per_word = 60.0 / settings.words_per_minute
    out, t = [], 0.0
    for w in words:
        out.append({"word": w, "start": round(t, 3), "end": round(t + per_word, 3)})
        t += per_word
    return out


def _pick_whisper_device(settings: Settings) -> str:
    """Fase 1B: respeita override explícita (cpu/cuda); default 'cpu' do
    .env é seguro se FORCE_GPU não estiver setado."""
    explicit = getattr(settings, "whisper_device", "cpu") or "cpu"
    if explicit in ("cpu", "cuda"):
        return explicit
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _downsample_audio(audio_path: Path, target_rate: int = 16000) -> Path:
    """Pré-processa áudio para Whisper: 16 kHz mono (formato ideal).
    Idempotente: se o ficheiro <audio>.16k.wav existe e é mais recente que
    o original, retorna-o sem reexecutar ffmpeg."""
    import subprocess

    out = audio_path.with_suffix(".16k.wav")
    try:
        if out.exists() and out.stat().st_mtime > audio_path.stat().st_mtime:
            return out
    except FileNotFoundError:
        pass
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(audio_path),
             "-ar", str(target_rate), "-ac", "1", "-c:a", "pcm_s16le",
             str(out)],
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        log.warning("whisper: downsampling falhou (%s); uso original", exc)
        return audio_path
    return out


def transcribe_words(audio_path: Path, settings: Settings,
                     script_text: str = "") -> list[dict]:
    """[{word, start, end}] — mock usa o texto do roteiro; real usa o áudio."""
    if settings.mock_mode:
        return _mock_words(script_text, settings)

    from faster_whisper import WhisperModel

    device = _pick_whisper_device(settings)
    audio_for_model = _downsample_audio(audio_path)
    # int8 em CPU; int8_float16 em CUDA (mais rápido com qualidade equivalente)
    compute = "int8" if device == "cpu" else "int8_float16"
    model = WhisperModel(settings.whisper_model, device=device,
                         compute_type=compute)
    segments, info = model.transcribe(
        str(audio_for_model), language="pt",
        word_timestamps=True, vad_filter=True,
    )
    words: list[dict] = []
    for seg in segments:
        for w in (seg.words or []):
            words.append({"word": w.word.strip(),
                          "start": round(w.start, 3),
                          "end": round(w.end, 3)})
    log.info("whisper: %d palavras, duração %.1fs, modelo %s device=%s",
             len(words), info.duration, settings.whisper_model, device)
    return words
