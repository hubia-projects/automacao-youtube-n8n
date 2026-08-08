"""Fase 1B — testes do Whisper base + GPU.

Cobertura:
1. _pick_whisper_device respeita override explícita; auto-detect quando
   `whisper_device` é string inválida ("auto").
2. _downsample_audio é idempotente (re-chamada não re-executa ffmpeg).
3. transcribe_words usa modelo "base" + compute_type certo por device.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


def test_pick_whisper_device_respects_explicit():
    from studio.audio.whisper import _pick_whisper_device
    s = MagicMock()
    s.whisper_device = "cuda"
    assert _pick_whisper_device(s) == "cuda"
    s.whisper_device = "cpu"
    assert _pick_whisper_device(s) == "cpu"


def test_pick_whisper_device_auto_falls_back_when_no_torch(monkeypatch):
    from studio.audio.whisper import _pick_whisper_device
    # Quando torch indisponível e whisper_device inválido, fallback cpu
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "torch":
            raise ImportError("torch not available")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    s = MagicMock()
    s.whisper_device = "auto"
    assert _pick_whisper_device(s) == "cpu"


def test_downsample_audio_idempotent(tmp_path: Path, monkeypatch):
    """Re-chamar deve ser no-op (não executa ffmpeg outra vez)."""
    from studio.audio import whisper
    audio = tmp_path / "in.wav"
    audio.write_bytes(b"fake-audio-content")
    down = audio.with_suffix(".16k.wav")
    # 1ª chamada: executa ffmpeg (mockado)
    with patch("subprocess.run") as run_mock:
        run_mock.return_value = MagicMock(returncode=0)
        # Cria o ficheiro output esperado
        down.write_bytes(b"")
        whisper._downsample_audio(audio)
    assert run_mock.called
    # 2ª chamada: NÃO executa ffmpeg (cache hit)
    with patch("subprocess.run") as run_mock:
        # Actualiza mtime para garantir cache hit
        import os
        new_mtime = audio.stat().st_mtime + 60
        os.utime(down, (new_mtime, new_mtime))
        whisper._downsample_audio(audio)
    assert not run_mock.called


def test_transcribe_words_uses_base_by_default(monkeypatch):
    """Quando settings.whisper_model="base" e device=cpu, compute=int8."""
    from studio.audio import whisper
    fake_model_instance = MagicMock()
    fake_model_instance.transcribe.return_value = ([], MagicMock(duration=5.0))
    fake_whisper_model = MagicMock(return_value=fake_model_instance)
    monkeypatch.setattr("faster_whisper.WhisperModel", fake_whisper_model)
    monkeypatch.setattr(whisper, "_pick_whisper_device", lambda s: "cpu")
    monkeypatch.setattr(whisper, "_downsample_audio", lambda p: p)
    s = MagicMock()
    s.whisper_model = "base"
    s.mock_mode = False
    whisper.transcribe_words(Path("fake.wav"), s, script_text="ola mundo")
    fake_whisper_model.assert_called_once()
    args, kwargs = fake_whisper_model.call_args
    assert args[0] == "base"
    assert kwargs["device"] == "cpu"
    assert kwargs["compute_type"] == "int8"
