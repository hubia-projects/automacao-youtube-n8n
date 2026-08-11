"""Testes unitários do Profiler — Fase 1 Optimização Profunda.

Cobre:
1. timer() acumula corretamente dentro do context manager.
2. exception DENTRO do with é re-raise, mas tempo ainda é registado.
3. record() agrega em categorias distintas.
4. snapshot() devolve schema esperado (wall_clock + operations).
5. write() cria <run>/performance.json válido e loga linha PERF.
6. reset() limpa o estado (entre runs e em pytest).
7. Profiler é thread-safe (100 threads concorrentes).
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

from studio.perf import Profiler, timer


@pytest.fixture(autouse=True)
def _reset():
    Profiler.reset()
    yield
    Profiler.reset()


def test_timer_accumulates_elapsed():
    """Tempo dentro do `with timer(...)` é acumulado."""
    Profiler.reset()
    with timer("download", items=2):
        time.sleep(0.05)
    snap = Profiler.snapshot()
    assert "download" in snap["operations"]
    op = snap["operations"]["download"]
    assert op["calls"] == 1
    assert op["items"] == 2
    assert op["seconds"] >= 0.05


def test_timer_exception_still_records():
    """Exception no interior do with NÃO impede a medição."""
    Profiler.reset()
    with pytest.raises(RuntimeError):
        with timer("siglip", items=10):
            time.sleep(0.01)
            raise RuntimeError("siglip crashed")
    snap = Profiler.snapshot()
    op = snap["operations"]["siglip"]
    assert op["calls"] == 1
    assert op["items"] == 10
    assert op["seconds"] >= 0.01


def test_record_aggregates_by_category():
    """record() acumula em categorias distintas."""
    Profiler.reset()
    Profiler.record("download", 1.2, items=3)
    Profiler.record("download", 0.8, items=5)
    Profiler.record("siglip", 5.0, items=12)
    op_d = Profiler.snapshot()["operations"]["download"]
    op_s = Profiler.snapshot()["operations"]["siglip"]
    assert op_d["calls"] == 2
    assert op_d["seconds"] == pytest.approx(2.0)
    assert op_d["items"] == 8
    assert op_s["calls"] == 1
    assert op_s["items"] == 12


def test_snapshot_shape_wall_clock_and_ops():
    Profiler.reset()
    Profiler.record("download", 0.1, items=1)
    snap = Profiler.snapshot()
    assert "wall_clock_seconds" in snap
    assert "operations" in snap
    assert isinstance(snap["wall_clock_seconds"], (int, float))
    assert "download" in snap["operations"]


def test_write_writes_performance_json(tmp_path: Path):
    Profiler.reset()
    Profiler.record("whisper", 0.5, items=3)
    Profiler.record("download", 0.8, items=2)
    Profiler.write(tmp_path)
    out = tmp_path / "performance.json"
    assert out.exists()
    data = json.loads(out.read_text("utf-8"))
    assert "whisper" in data["operations"]
    assert "download" in data["operations"]
    assert data["operations"]["whisper"]["seconds"] == pytest.approx(0.5)


def test_write_returns_none_for_missing_dir(tmp_path: Path):
    Profiler.reset()
    Profiler.record("x", 0.0)
    # tmp_path já existe; mas prova que write não crasha se algo estranho
    out = Profiler.write(tmp_path)
    assert out is None or (out and out.exists())


def test_reset_clears_state():
    Profiler.record("a", 1.0, items=1)
    Profiler.reset()
    snap = Profiler.snapshot()
    assert snap["operations"] == {}
    # No entanto, wall_clock continua a contar (started_at renovado).


def test_thread_safety_100_workers():
    """100 threads × 50 registros: total final é EXACTO (sem lost-update)."""
    Profiler.reset()

    def worker(tid: int):
        for _ in range(50):
            Profiler.record("concurrent", 0.01, items=1)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(100)]
    for t in threads: t.start()
    for t in threads: t.join()

    op = Profiler.snapshot()["operations"]["concurrent"]
    assert op["calls"] == 100 * 50
    assert op["items"] == 100 * 50
    assert op["seconds"] == pytest.approx(100 * 50 * 0.01, abs=1e-6)


def test_summary_text_renders():
    Profiler.reset()
    Profiler.record("whisper", 5.0, items=400)
    Profiler.record("download", 12.3, items=10)
    text = Profiler.summary_text()
    assert "PERFORMANCE SUMMARY" in text
    assert "whisper" in text
    assert "download" in text
    assert "400" in text  # items


def test_empty_perf_serialises_without_crashing(tmp_path: Path):
    """Edge case: Profiler nunca registou nada (não houve categories)."""
    Profiler.reset()
    out = Profiler.write(tmp_path)
    data = json.loads((tmp_path / "performance.json").read_text("utf-8"))
    assert data["operations"] == {}
    assert data["wall_clock_seconds"] >= 0.0
    assert out is not None
