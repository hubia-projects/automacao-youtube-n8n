"""Fase 1C — testes do TTS paralelo (versão final sem RecursionError).

Versão sem bug da RecursionError que a 1ª tentativa teve (o FakeExecutor
instanciava ThreadPoolExecutor real no __init__, criando loop infinito).
Aqui usamos mock context manager puro.

Cobertura:
1. synthesize() cria ThreadPoolExecutor com max_workers=4 quando multivozes
   está OK (TTS_MULTIVOZES_WORKERS).
2. synthesize() cria ThreadPoolExecutor com max_workers=3 quando cai em
   fallback ElevenLabs (TTS_ELEVENLABS_WORKERS, respeita rate-limit).
3. Ordem dos chunks submetidos via ex.map preservada (0,1,2,...,N-1).
"""

from __future__ import annotations

import concurrent.futures
from pathlib import Path
from unittest.mock import MagicMock, patch

# Texto com 25 sentenças curtas — força divisão em vários chunks (CHUNK_CHARS=420).
LONG_TEXT = " ".join(
    f"Frase número {i} com algum conteúdo longo o suficiente para encher o chunk."
    for i in range(25))


def _settings(eleven: bool = False) -> MagicMock:
    s = MagicMock()
    s.multivozes_base_url = "http://localhost:5050/v1"
    s.multivozes_api_key = "test-key"
    s.elevenlabs_api_key = "test-eleven" if eleven else ""
    s.elevenlabs_voice_id = "voice-id" if eleven else ""
    s.tts_voice = "pt-BR-AntonioNeural"
    s.words_per_minute = 150
    s.mock_mode = False
    return s


def _patched_synthesize(text: str, twelve: bool = False) -> dict:
    """Helper: corre synthesize com TUDO mockado e devolve dict com workers
    usados, ordem de submissão, e nº de chunks processados."""
    from studio.audio import tts_client

    max_workers_used: list[int] = []
    submissions_order: list[int] = []

    pool_mock = MagicMock()
    pool_mock.__enter__ = lambda self: pool_mock
    pool_mock.__exit__ = lambda self, *a: False

    def fake_map(fn, *iterables):
        # ex.map itera sequencialmente sobre o PRIMEIRO iterable; preserva
        # a ordem dos yields. Reproduzimos aqui para teste.
        for x in iterables[0]:
            submissions_order.append(x)
        return [fn(*a) for a in zip(*iterables)]
    pool_mock.map.side_effect = fake_map

    def fake_executor(max_workers):
        max_workers_used.append(max_workers)
        return pool_mock

    with patch.object(tts_client, "_ensure_multivozes",
                      return_value=not twelve), \
         patch.object(tts_client, "_render_chunk",
                      side_effect=lambda i, c, td, use, settings:
                          Path(td) / f"part_{i:03d}.mp3"), \
         patch.object(concurrent.futures, "ThreadPoolExecutor",
                      side_effect=fake_executor), \
         patch.object(tts_client.subprocess, "run") as ffprobe:
        ffprobe.return_value = MagicMock(stdout="42.0")
        tts_client.synthesize(text, Path("/tmp/out.wav"), _settings(eleven=twelve))

    return {
        "workers": max_workers_used,
        "submission_order": submissions_order,
        "n_chunks": len(submissions_order),
    }


def test_synthesize_uses_threadpool_with_4_workers_multivozes():
    """Quando multivozes OK, max_workers=4."""
    result = _patched_synthesize(LONG_TEXT, twelve=False)
    assert result["workers"] == [4], (
        f"Esperado max_workers=4 (TTS_MULTIVOZES_WORKERS), "
        f"obtido {result['workers']}")
    # Texto tem 25 sentenças × ~10 chars cada = ~250 chars total + espaço.
    # Hmm, ainda pode caber em 1 chunk. _chunks() divide por FRASES (não
    # por chars), portanto output = 25 chunks (uma frase cada).
    assert result["n_chunks"] >= 5, (
        f"Esperado ≥5 chunks para verificar paralelismo, "
        f"obtido {result['n_chunks']}")


def test_synthesize_uses_3_workers_when_elevenlabs_fallback():
    """Quando multivozes indisponível, max_workers=3 (rate-limit ElevenLabs)."""
    result = _patched_synthesize(LONG_TEXT, twelve=True)
    assert result["workers"] == [3], (
        f"Esperado max_workers=3 (TTS_ELEVENLABS_WORKERS), "
        f"obtido {result['workers']}")


def test_synthesize_preserves_chunk_submission_order():
    """ex.map preserva ordem dos chunks (0,1,2,...,N-1)."""
    result = _patched_synthesize(LONG_TEXT, twelve=False)
    n = result["n_chunks"]
    expected = list(range(n))
    assert result["submission_order"] == expected, (
        f"Orrom de submissões: obtido {result['submission_order']}, "
        f"esperado {expected}")
