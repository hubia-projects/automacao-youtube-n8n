"""Profiler — Fase 1 da Optimização Profunda do Studio v2.

Fornece:
* `timer(category, items=1)` — context manager exception-safe.
* `Profiler.record(name, seconds, items=1)` — entrada programática
  para sítios onde bloqueios não cabem num `with` único.
* `Profiler.snapshot()` — dicionário com wall_clock_seconds + per-op
  {calls, seconds, items}.
* `Profiler.write(run_dir)` — escreve `<run>/performance.json` E loga
  a linha resumo "PERF name1=Xs name2=Ys …" (8 maiores consumidores).
* `Profiler.reset()` — limpa o estado (entre rounds ou entre pytest).

Thread-safe via `_lock`. Custo praticamente zero (<1μs por `timer`).

Design:
    with timer("whisper", items=info.duration):
        words = faster_whisper.transcribe(...)
    # ou programático:
    t0 = time.perf_counter()
    ... do work ...
    Profiler.record("download", time.perf_counter() - t0, items=n_files)
"""

from __future__ import annotations

import json
import logging
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

log = logging.getLogger("studio.perf")


class _OpStats:
    __slots__ = ("calls", "seconds", "items", "counters")

    def __init__(self) -> None:
        self.calls = 0
        self.seconds = 0.0
        self.items = 0
        self.counters: dict[str, int] = {}


class Profiler:
    """Agregador global de métricas por operação."""

    _lock = threading.Lock()
    _ops: dict[str, _OpStats] = {}
    _started_at: float | None = None

    @classmethod
    def reset(cls) -> None:
        """Limpa todas as métricas e reinicia o relógio de wall-clock."""
        with cls._lock:
            cls._ops.clear()
            cls._started_at = time.perf_counter()

    @classmethod
    def begin(cls) -> None:
        """Lazy init: cria _started_at se ainda não existir (sem reset)."""
        with cls._lock:
            if cls._started_at is None:
                cls._started_at = time.perf_counter()

    @classmethod
    def record(cls, category: str, seconds: float, items: int = 1) -> None:
        cls.begin()
        with cls._lock:
            s = cls._ops.setdefault(category, _OpStats())
            s.calls += 1
            s.seconds += float(seconds)
            s.items += int(items)

    @classmethod
    def add(cls, category: str, seconds: float, items: int = 0) -> None:
        """Acrescenta a uma operação existente (cria se não houver)."""
        with cls._lock:
            s = cls._ops.setdefault(category, _OpStats())
            s.seconds += float(seconds)
            s.items += int(items)

    @classmethod
    def snapshot(cls) -> dict:
        with cls._lock:
            out = {
                k: {"calls": v.calls, "seconds": round(v.seconds, 3),
                    "items": v.items}
                for k, v in cls._ops.items()
            }
            total = (time.perf_counter() - cls._started_at
                     if cls._started_at else 0.0)
        return {"wall_clock_seconds": round(total, 3),
                "operations": out}

    @classmethod
    def write(cls, run_dir: Path) -> Path | None:
        """Escreve performance.json + linha resumo (top 8 ops por tempo)."""
        snap = cls.snapshot()
        try:
            run_dir.mkdir(parents=True, exist_ok=True)
            out = run_dir / "performance.json"
            out.write_text(
                json.dumps(snap, ensure_ascii=False, indent=2), "utf-8")
            # linha resumo em formato "PERF" (top 8 operações por tempo
            # descendente) — facilita tail em logs / dashboards.
            top = sorted(snap["operations"].items(),
                         key=lambda kv: -kv[1]["seconds"])[:8]
            log.info("PERF run_dir=%s total=%.1fs %s",
                     run_dir, snap["wall_clock_seconds"],
                     " ".join(f"{k}={v['seconds']:.1f}s"
                              for k, v in top))
            return out
        except Exception as exc:
            log.warning("Profiler.write falhou (%s): %s",
                        run_dir, exc.__class__.__name__)
            return None

    @classmethod
    def summary_text(cls) -> str:
        """Texto legível para Telegram / monitor (não bloqueia)."""
        snap = cls.snapshot()
        total = snap["wall_clock_seconds"]
        top = sorted(snap["operations"].items(),
                     key=lambda kv: -kv[1]["seconds"])
        lines = [f"PERFORMANCE SUMMARY", f"Total: {total:.1f}s", ""]
        for k, v in top:
            lines.append(f"{k}: {v['seconds']:.1f}s "
                         f"({v['calls']} calls, {v['items']} items)")
        return "\n".join(lines)


@contextmanager
def timer(category: str, items: int = 1) -> Iterator[None]:
    """Context manager: mede elapsed time e reporta a Profiler.

    Exception-safe: se a lógica interna levantar, a medição é acumulada
    ANTES de re-raise (caller vê a métrica mesmo em fail-closed).

    Args:
        category: nome da operação (whisper, download, siglip, vision…).
        items: nº de items processados (palavras, shots, MB, ficheiros, etc.).
    """
    Profiler.begin()
    t0 = time.perf_counter()
    try:
        yield
    finally:
        elapsed = time.perf_counter() - t0
        Profiler.record(category, elapsed, items=items)
