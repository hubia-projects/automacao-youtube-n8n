"""Word timestamps locais — faster-whisper (custo $0, ADR §10).

Fase 1B: modelo "base" por default (accuracy ms suficiente para A/V sync,
~10× mais rápido que 'large-v3-turbo'). Auto-detect GPU entre fases
(SigLIP faz .unload() em CPU no fim do 08_matching — Whisper pode
reutilizar VRAM temporariamente). Pré-process: 16kHz mono é o formato
ideal para Whisper; passamos o áudio por ffmpeg uma vez (idempotente,
cache em tmp). Mock: timing uniforme determinístico a partir do texto
(~wpm config), como o fallback comprovado do sistema legacy.

Fase 1 deep-optimization — STUDIO_WHISPER_DEVICE explícito:
* "auto"  (default): torch.cuda.is_available() ⇒ "cuda" se sim, "cpu" senão.
* "cuda": força CUDA; se a inicialização do faster-whisper falhar por
   incompatibilidade (Pascal SM6.x em drivers antigos), faz fail-closed
   e loga a falha em vez de fingir que usou GPU.
* "cpu":  força CPU (compute int8).

Log obrigatório (vai para Profiler + logger):
  whisper: model=base requested_device=auto selected_device=cuda
           compute_type=int8_float16 audio=487.2s elapsed=34.7s
           realtime_factor=0.071 words=812
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from studio.config import Settings
from studio.perf import Profiler

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
    """Fase 1 Optimização — 3 modos explícitos:
    * "auto": detect via torch.cuda.is_available(); cai para CPU em
        qualquer erro (torch não instalado, sem driver, Pascal SM6.x).
    * "cuda": força GPU; retorna exatamente "cuda" (fail-closed na
        fase de inicialização do WhisperModel fica a cargo do caller).
    * "cpu": força CPU.

    NÃO finge device para satisfazer o caller (compatibilidade CUDA).
    """
    explicit = (getattr(settings, "whisper_device", "auto") or "auto").strip().lower()
    if explicit == "cpu":
        return "cpu"
    if explicit == "cuda":
        return "cuda"
    # auto: detecta CUDA via torch
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        # torch indisponível, sem GPU, ou driver com erro — CPU é seguro
        pass
    return "cpu"


def _init_whisper_model(model_name: str, device: str):
    """Inicializa WhisperModel com fallback defensivo de compute_type.

    Tenta int8_float16 em CUDA (preferido por performance); se o backend
    CTranslate2 rejeitar (Pascal SM6.x / drivers antigos conhecidos por
    quebrar CTranslate2), fallback automático para int8 (compat universal).
    Devolve erro apenas se AMBOS os compute_types falharem.

    Returns: (WhisperModel_instance, compute_type_str, init_error_str)
    """
    from faster_whisper import WhisperModel

    # GPU-accelerated primeiro (int8_float16): prefer em CUDA/MPS
    if device != "cpu":
        try:
            return (
                WhisperModel(model_name, device=device, compute_type="int8_float16"),
                "int8_float16",
                "",
            )
        except ValueError as exc:
            if "int8_float16" in str(exc):
                log.warning(
                    "whisper: int8_float16 incompat com CUDA (%s) — fallback int8",
                    exc,
                )
                # cai para a tentativa abaixo
            else:
                return None, "int8_float16", repr(exc)

    # Fallback universal: int8 funciona em qualquer device (CPU + GPU antiga)
    try:
        return (
            WhisperModel(model_name, device=device, compute_type="int8"),
            "int8",
            "",
        )
    except Exception as exc:
        return None, "int8", repr(exc)


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
    """[{word, start, end}] — mock usa o texto do roteiro; real usa o áudio.

    Log obrigatório (Fase 1):
      whisper: model=base requested_device=auto selected_device=cuda
               compute_type=int8_float16 audio=487.2s elapsed=34.7s
               realtime_factor=0.071 words=812
    Adicionalmente reporta a `Profiler` na categoria "whisper" (items = nº
    de palavras, áudio = info.duration acumulado em segundos).
    """
    if settings.mock_mode:
        words = _mock_words(script_text, settings)
        Profiler.record("whisper_mock", 0.0, items=len(words))
        return words

    device = _pick_whisper_device(settings)
    audio_for_model = _downsample_audio(audio_path)
    model, compute, init_err = _init_whisper_model(
        settings.whisper_model, device)
    if model is None:
        # Fail-closed com mensagem clara. NÃO tentar de novo em CUDA (causa
        # nº1 de crashes intermitentes em máquinas com Pascal/GTX série).
        log.error("whisper: model=%s device=%s INIT FAIL: %s — fail-closed",
                  settings.whisper_model, device, init_err)
        raise RuntimeError(f"whisper init falhou: {init_err}")
    Profiler.begin()
    t0 = time.perf_counter()
    try:
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
    finally:
        elapsed = time.perf_counter() - t0
        # `record` (não `add`) para incrementar o calls counter —
        # caso contrário performance.json reporta calls=0 mesmo após runs.
        Profiler.record("whisper", elapsed, items=len(words))
    audio_s = float(getattr(info, "duration", 0.0) or 0.0)
    rt_factor = (elapsed / audio_s) if audio_s > 0 else 0.0
    log.info("whisper: model=%s requested_device=%s selected_device=%s "
             "compute_type=%s audio=%.1fs elapsed=%.1fs "
             "realtime_factor=%.3f words=%d",
             settings.whisper_model,
             getattr(settings, "whisper_device", "auto"),
             device, compute, audio_s, elapsed, rt_factor, len(words))
    return words
