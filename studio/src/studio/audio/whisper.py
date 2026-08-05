"""Word timestamps locais — faster-whisper (custo $0, ADR §10).

Default CPU int8 (VRAM dos 4 GB é partilhada com o desktop; whisper nunca
co-residente com SigLIP). Mock: timing uniforme determinístico a partir do
texto (~wpm config), como o fallback comprovado do sistema legacy.
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


def transcribe_words(audio_path: Path, settings: Settings,
                     script_text: str = "") -> list[dict]:
    """[{word, start, end}] — mock usa o texto do roteiro; real usa o áudio."""
    if settings.mock_mode:
        return _mock_words(script_text, settings)

    from faster_whisper import WhisperModel

    model = WhisperModel(settings.whisper_model, device=settings.whisper_device,
                         compute_type="int8")
    segments, info = model.transcribe(str(audio_path), language="pt",
                                      word_timestamps=True, vad_filter=True)
    words: list[dict] = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"word": w.word.strip(), "start": round(w.start, 3),
                          "end": round(w.end, 3)})
    log.info("whisper: %d palavras, duração %.1fs, modelo %s",
             len(words), info.duration, settings.whisper_model)
    return words
