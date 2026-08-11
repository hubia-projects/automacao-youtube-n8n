"""Testes do Whisper auto-GPU (Fase 1 Optimização Profunda).

Cobre:
1. STUDIO_WHISPER_DEVICE=auto detecta CUDA via torch se disponível.
2. auto + torch ausente → CPU.
3. auto + torch.cuda.is_available()=False → CPU.
4. STUDIO_WHISPER_DEVICE=cpu explícito → CPU sempre.
5. STUDIO_WHISPER_DEVICE=cuda explícito → retorna "cuda".
6. translcribe_words loga linha obrigatória (model/requested/selected/.../rt_factor).
7. transcribe_words chama Profiler para a categoria "whisper".
8. Em CUDA-init fail, RuntimeError é levantado com mensagem clara.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# --------- _pick_whisper_device ---------

def test_pick_device_explicit_cpu():
    from studio.audio.whisper import _pick_whisper_device
    s = MagicMock()
    s.whisper_device = "cpu"
    assert _pick_whisper_device(s) == "cpu"


def test_pick_device_explicit_cuda():
    from studio.audio.whisper import _pick_whisper_device
    s = MagicMock()
    s.whisper_device = "cuda"
    assert _pick_whisper_device(s) == "cuda"


def test_pick_device_auto_no_torch(monkeypatch):
    """auto + torch ausente → CPU."""
    from studio.audio import whisper
    import builtins
    real = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "torch":
            raise ImportError("torch missing (test)")
        return real(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    s = MagicMock()
    s.whisper_device = "auto"
    assert whisper._pick_whisper_device(s) == "cpu"


def test_pick_device_auto_torch_no_cuda(monkeypatch):
    """auto + torch.cuda.is_available()=False → CPU."""
    from studio.audio import whisper

    fake_torch = MagicMock()
    fake_torch.cuda.is_available.return_value = False
    monkeypatch.setitem(whip := __import__("importlib").__import__
                        ("sys").modules, "torch", fake_torch)
    s = MagicMock()
    s.whisper_device = "auto"
    assert whisper._pick_whisper_device(s) == "cpu"


def test_pick_device_auto_torch_with_cuda(monkeypatch):
    """auto + torch.cuda.is_available()=True → cuda."""
    from studio.audio import whisper

    fake_torch = MagicMock()
    fake_torch.cuda.is_available.return_value = True
    monkeypatch.setitem(__import__("sys").modules, "torch", fake_torch)
    s = MagicMock()
    s.whisper_device = "auto"
    assert whisper._pick_whisper_device(s) == "cuda"


# --------- init_whisper_model -- fail-closed quando CUDA init quebra ---------

def test_init_whisper_model_returns_none_on_failure(monkeypatch):
    """Se WhisperModel(...) falha, devolve (None, compute, erro)."""
    from studio.audio import whisper

    class _Boom:
        def __init__(self, *a, **kw):
            raise RuntimeError("CTranslate2 CUDA init fail (Pascal)")

    monkeypatch.setattr("faster_whisper.WhisperModel", _Boom)
    model, compute, err = whisper._init_whisper_model("base", "cuda")
    assert model is None
    assert compute == "int8_float16"
    assert "CTranslate2" in err or "CUDA" in err


def test_transcribe_words_raises_runtime_error_on_cuda_init_fail(monkeypatch):
    """transcribe_words levanta RuntimeError explícito quando init falha."""
    from studio.audio import whisper

    class _Boom:
        def __init__(self, *a, **kw):
            raise RuntimeError("CTranslate2 GPU fail")

    monkeypatch.setattr("faster_whisper.WhisperModel", _Boom)
    monkeypatch.setattr(whisper, "_downsample_audio", lambda p: p)
    s = MagicMock(spec=["whisper_model", "mock_mode", "whisper_device"])
    s.whisper_model = "base"
    s.mock_mode = False
    s.whisper_device = "cuda"
    with pytest.raises(RuntimeError, match="whisper init falhou"):
        whisper.transcribe_words(Path("fake.wav"), s, script_text="ola")


# --------- transcribe_words LOG + Profiler ---------

def test_transcribe_words_logs_realtime_factor(monkeypatch, caplog):
    """Logs obrigatórios: model, requested/selected device, audio, elapsed,
    realtime_factor, words."""
    from studio.audio import whisper
    from studio.perf import Profiler

    fake_model_instance = MagicMock()
    fake_info = MagicMock(duration=10.0)

    def fake_transcribe(_self, *a, **kw):
        seg = MagicMock()
        w1 = MagicMock(word="ola", start=0.0, end=0.5)
        w2 = MagicMock(word="mundo", start=0.5, end=1.0)
        seg.words = [w1, w2]
        return [seg], fake_info
    fake_model_instance.transcribe.side_effect = fake_transcribe

    fake_WM = MagicMock(return_value=fake_model_instance)
    monkeypatch.setattr("faster_whisper.WhisperModel", fake_WM)
    monkeypatch.setattr(whisper, "_downsample_audio", lambda p: p)
    monkeypatch.setattr(whisper, "_pick_whisper_device", lambda s: "cpu")

    # Força tempo de medição mínimo (time.sleep seria mais lento)
    s = MagicMock(spec=["whisper_model", "mock_mode", "whisper_device",
                        "prompts_root", "gemini_api_key"])
    s.whisper_model = "base"
    s.mock_mode = False
    s.whisper_device = "cpu"
    Profiler.reset()

    with caplog.at_level(logging.INFO, logger="studio.whisper"):
        words = whisper.transcribe_words(Path("fake.wav"), s, script_text="ola mundo")

    assert words == [{"word": "ola", "start": 0.0, "end": 0.5},
                     {"word": "mundo", "start": 0.5, "end": 1.0}]

    joined = " ".join(r.message for r in caplog.records)
    assert "model=base" in joined
    assert "requested_device=cpu" in joined
    assert "selected_device=cpu" in joined
    assert "compute_type=int8" in joined
    assert "audio=10.0s" in joined
    assert "realtime_factor=" in joined
    assert "words=2" in joined

    # Profiler acumulou exatamente 2 items (palavras) em "whisper"
    op = Profiler.snapshot()["operations"].get("whisper", {})
    assert op.get("items", 0) == 2


def test_transcribe_words_mock_records_profiler_mock_cat(monkeypatch):
    """Em mock_mode a contabilidade cai em "whisper_mock"."""
    from studio.audio import whisper
    from studio.perf import Profiler

    Profiler.reset()
    s = MagicMock()
    s.mock_mode = True
    s.words_per_minute = 120
    words = whisper.transcribe_words(Path("ignore.wav"), s, script_text="a b c d")
    assert len(words) == 4
    op = Profiler.snapshot()["operations"]["whisper_mock"]
    assert op["items"] == 4
