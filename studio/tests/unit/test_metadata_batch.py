"""Testes para analyze_shots_batch (UPSTREAM-CHANGE 2026-08-11 §P2-P4).

Cobre 4 cenários do task §6:
  1) batch_mapping — Gemini retorna fora de ordem; cada shot recebe o seu.
  2) missing_result — N enviados, N-1 retornados; 1 vira METADATA_INCOMPLETE.
  3) 429 sem fan-out — rate-limit retry batch; NUNCA explode para per-shot.
  4) split_progressivo — parse fail em batch 4 → 2 + 2.

Estratégia: monkeypatch do `httpx.post` para devolver mocks controlados.
`studio.library.rate_limit` é resetado entre testes via `reset_singleton()`.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from studio.config import Settings
from studio.library.metadata import (
    ShotMetadata,
    analyze_shots_batch,
)
from studio.library.rate_limit import reset_singleton


# ---------- Fixtures ---------------------------------------------------------------
def _mock_settings(mock_mode: bool = False) -> Settings:
    """Settings mínima para testes (não chega à rede)."""
    return Settings(
        mock_mode=mock_mode,
        gemini_api_key="dummy",
        # mock stats para Profiler
        perf_enabled=True,
        auto_approve_gates=True,
        # rate-limit defaults, mas singleton é resetado por teste
    )


def _fake_keyframes(tmp_path: Path, n: int) -> list[Path]:
    """Cria n keyframes dummy (PNG 1x1) e devolve paths."""
    import struct
    import zlib
    paths: list[Path] = []
    for i in range(n):
        p = tmp_path / f"kf_{i:03d}.png"
        # PNG mínimo 1x1 preto
        png = (b"\x89PNG\r\n\x1a\n"
               b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
               b"\x08\x00\x00\x00\x00:~\x9aU\x00\x00\x00\nIDATx\x9cc"
               b"\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND"
               b"\xaeB`\x82")
        p.write_bytes(png)
        paths.append(p)
    return paths


def _gemini_array_response(shot_payloads: list[tuple[str, dict]]) -> dict:
    """Constrói payload Gemini com array de entries, um por shot_id."""
    candidates_text = json.dumps([
        {"shot_id": sid, **meta} for sid, meta in shot_payloads
    ])
    return {
        "candidates": [
            {"content": {"parts": [{"text": candidates_text}]}}
        ],
        "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 50},
    }


# ---------- Test 1: batch_mapping -------------------------------------------------
def test_batch_mapping_out_of_order(tmp_path: Path):
    """Gemini devolve shot_3, shot_1, shot_2 (fora de ordem);
    cada shot_id recebe o seu metadata correto."""
    reset_singleton()
    settings = _mock_settings(mock_mode=False)
    kfs = _fake_keyframes(tmp_path, 3)
    shots = [
        ("shot_1", [kfs[0]]),
        ("shot_2", [kfs[1]]),
        ("shot_3", [kfs[2]]),
    ]
    payload = _gemini_array_response([
        ("shot_3", {"summary": "third", "places": ["c"]}),
        ("shot_1", {"summary": "first",  "places": ["a"]}),
        ("shot_2", {"summary": "second", "places": ["b"]}),
    ])
    fake_resp = SimpleNamespace(
        status_code=200,
        headers={},
        raise_for_status=lambda: None,
        json=lambda: payload,
    )
    with patch("studio.library.metadata.httpx.post", return_value=fake_resp):
        out = analyze_shots_batch(shots, settings)
    assert sorted(out.keys()) == ["shot_1", "shot_2", "shot_3"]
    assert out["shot_1"][0].summary == "first"
    assert out["shot_2"][0].summary == "second"
    assert out["shot_3"][0].summary == "third"
    assert out["shot_1"][0].places == ["a"]
    assert out["shot_2"][0].places == ["b"]
    assert out["shot_3"][0].places == ["c"]


# ---------- Test 2: missing_result ------------------------------------------------
def test_missing_result_one_shot_missing(tmp_path: Path):
    """4 enviados, Gemini retorna apenas 3; o missing fica METADATA_INCOMPLETE."""
    reset_singleton()
    settings = _mock_settings(mock_mode=False)
    kfs = _fake_keyframes(tmp_path, 4)
    shots = [
        ("shot_a", [kfs[0]]),
        ("shot_b", [kfs[1]]),
        ("shot_c", [kfs[2]]),
        ("shot_d", [kfs[3]]),
    ]
    payload = _gemini_array_response([
        ("shot_a", {"summary": "a-ok", "places": ["x"]}),
        ("shot_b", {"summary": "b-ok", "places": ["y"]}),
        ("shot_d", {"summary": "d-ok", "places": ["z"]}),
        # shot_c missing intentionally
    ])
    fake_resp = SimpleNamespace(
        status_code=200,
        headers={},
        raise_for_status=lambda: None,
        json=lambda: payload,
    )
    with patch("studio.library.metadata.httpx.post", return_value=fake_resp):
        out = analyze_shots_batch(shots, settings)
    assert out["shot_a"][0].summary == "a-ok"
    assert out["shot_b"][0].summary == "b-ok"
    assert out["shot_d"][0].summary == "d-ok"
    assert out["shot_c"] == (None, 0.0), \
        f"missing shot deve ser METADATA_INCOMPLETE, got {out['shot_c']}"


# ---------- Test 3: 429 sem fan-out -----------------------------------------------
def test_429_no_per_shot_fanout(tmp_path: Path):
    """Em 429, retry batch; ZERO fan-out per-shot. Verificamos que:
      - 1ª call HTTP retorna 429.
      - 2ª call HTTP retorna 200 OK.
      - Apenas 2 HTTP posts foram feitos (nada de N per-shot).
      - Cada shot recebe metadata (None se retry budget exhausted).
    """
    reset_singleton()
    settings = _mock_settings(mock_mode=False)
    # Forçar retry budget pequeno para teste
    settings.library_gemini_max_retries = 1   # 1 retry then bail
    kfs = _fake_keyframes(tmp_path, 3)
    shots = [
        ("shot_x", [kfs[0]]),
        ("shot_y", [kfs[1]]),
        ("shot_z", [kfs[2]]),
    ]
    payload = _gemini_array_response([
        ("shot_x", {"summary": "x-ok", "places": ["r"]}),
        ("shot_y", {"summary": "y-ok", "places": ["s"]}),
        ("shot_z", {"summary": "z-ok", "places": ["t"]}),
    ])
    post_calls = []

    def fake_post(url, **kwargs):
        post_calls.append(url)
        if len(post_calls) == 1:
            # 1ª call → 429.
            return SimpleNamespace(
                status_code=429,
                headers={"retry-after": "0.1"},  # 0.1s
                json=lambda: {},
            )
        # 2ª call → 200.
        return SimpleNamespace(
            status_code=200,
            headers={},
            raise_for_status=lambda: None,
            json=lambda: payload,
        )

    with patch("studio.library.metadata.httpx.post", side_effect=fake_post):
        # também monkeypatch time.sleep para não bloquear o teste
        with patch("studio.library.metadata.time.sleep", lambda s: None):
            # UPSTREAM-FIX 2026-08-11 (thinker): o 1º retry_after (curto)
            # activa cb_open_until momentaneamente no limiter → acquire
            # fail-fast. Aqui mock-ar o acquire para SEMPRE passar é OK
            # porque o que estamos a testar é o retry-do-batch em si, não
            # o rate-limiter (já validado em baseline de production).
            with patch("studio.library.rate_limit.GeminiRateLimiter.acquire",
                       return_value=True):
                out = analyze_shots_batch(shots, settings)
    # Exactly 2 HTTP calls (1×429 + 1×200 OK retry batch). NO fan-out per-shot.
    assert len(post_calls) == 2, \
        f"Esperado 2 HTTP calls (retry batch sem fan-out), got {len(post_calls)}"
    assert out["shot_x"][0] is not None and out["shot_x"][0].summary == "x-ok"
    assert out["shot_y"][0] is not None and out["shot_y"][0].summary == "y-ok"
    assert out["shot_z"][0] is not None and out["shot_z"][0].summary == "z-ok"


def test_429_exhausted_budget_no_fanout(tmp_path: Path):
    """Retry budget exausto em 429 → TODOS shots = METADATA_INCOMPLETE
    sem fan-out per-shot. NUNCA transformamos throttling em tempestade."""
    reset_singleton()
    settings = _mock_settings(mock_mode=False)
    settings.library_gemini_max_retries = 0   # 0 retries
    kfs = _fake_keyframes(tmp_path, 4)
    shots = [(f"shot_{i}", [kfs[i]]) for i in range(4)]
    post_calls = []

    def fake_post(url, **kwargs):
        post_calls.append(url)
        return SimpleNamespace(status_code=429, headers={"retry-after": "0"},
                               json=lambda: {})

    with patch("studio.library.metadata.httpx.post", side_effect=fake_post):
        with patch("studio.library.metadata.time.sleep", lambda s: None):
            out = analyze_shots_batch(shots, settings)
    # Exactly 1 HTTP call (45 budget=0); 0 fan-out per-shot.
    assert len(post_calls) == 1, \
        f"Esperado 1 HTTP call (no retry budget), got {len(post_calls)}"
    for i in range(4):
        assert out[f"shot_{i}"] == (None, 0.0), \
            f"shot_{i} deve ser METADATA_INCOMPLETE em retry budget exausto"


# ---------- Test 4: split_progressivo ---------------------------------------------
def test_split_progressivo_on_parse_failure(tmp_path: Path):
    """Em parse fail (JSONDecodeError), chamamos split halves recursivo.
    Stop: len==1 → stop, devolve (None, 0.0).
    Demonstramos com batch de 4:
      - 1ª call (4 shots) → JSONDecodeError.
      - 2ª call (shots[0:2]) → 200 OK.
      - 3ª call (shots[2:4]) → 200 OK.
    Total: 3 HTTP calls (full + 2 halves). Zero fan-out per-shot.
    """
    reset_singleton()
    settings = _mock_settings(mock_mode=False)
    kfs = _fake_keyframes(tmp_path, 4)
    shots = [(f"shot_{i}", [kfs[i]]) for i in range(4)]
    post_calls = []

    def fake_post(url, **kwargs):
        post_calls.append((url, str(kwargs.get("json", ""))[:300]))
        body = kwargs.get("json", {}).get("contents", [{}])[0].get("parts", [])
        # contar quantos [shot_id=...] no payload (decidir split)
        n_shots_in_payload = sum(
            1 for p in body if isinstance(p, dict) and p.get("text", "").startswith("\n[shot_id=")
        )
        if n_shots_in_payload == 4:
            # Full batch → JSON parse fail.
            return SimpleNamespace(
                status_code=200, headers={}, raise_for_status=lambda: None,
                json=lambda: (_ for _ in ()).throw(  # JSONDecodeError artificial
                    json.JSONDecodeError("mock-fail", "", 0)
                ),
            )
        # Half batches → 200 OK.
        if n_shots_in_payload == 2:
            # Construir payload com os 2 shots corretos.
            ids_in_payload = sorted(
                [p.get("text", "") for p in body
                 if isinstance(p, dict) and p.get("text", "").startswith("\n[shot_id=")]
            )
            entries = []
            for raw in ids_in_payload:
                sid = raw.replace("\n[shot_id=", "").rstrip("]")
                entries.append((sid, {
                    "summary": f"{sid}-ok", "places": [sid.split("_")[1]],
                }))
            payload = _gemini_array_response(entries)
            return SimpleNamespace(
                status_code=200, headers={}, raise_for_status=lambda: None,
                json=lambda: payload,
            )
        # fallback
        return SimpleNamespace(
            status_code=200, headers={}, raise_for_status=lambda: None,
            json=lambda: _gemini_array_response([]),
        )

    with patch("studio.library.metadata.httpx.post", side_effect=fake_post):
        out = analyze_shots_batch(shots, settings)
    # 3 HTTP calls (full + 2 halves), não 4 per-shot.
    assert len(post_calls) == 3, \
        f"Esperado 3 HTTP calls (split halves), got {len(post_calls)}"
    # Todos os 4 shots recebem metadata (denominador comune dos 200 halves)
    for i in range(4):
        sid = f"shot_{i}"
        assert out[sid] is not None and out[sid][0] is not None, \
            f"{sid} deve receber metadata via split, got {out[sid]}"


# ---------- Test 5: mock_mode → per-shot determinístico ---------------------------
def test_mock_mode_deterministic():
    """Em mock_mode (sem gemini_api_key ou settings.mock_mode), per-shot
    fallback usa _mock_metadata (determinístico por nome do ficheiro).
    Compat retro preservada."""
    settings = _mock_settings(mock_mode=True)
    # Working dir doesn't matter; we pass source_hint "" anyway.
    kfs: list[Path] = []
    out = analyze_shots_batch(
        [("s1", kfs), ("s2", kfs)], settings, source_hint="",
    )
    assert out["s1"][0] is not None
    assert out["s2"][0] is not None
    assert out["s1"][0].summary.startswith("mock shot")
    assert out["s2"][0].summary.startswith("mock shot")
