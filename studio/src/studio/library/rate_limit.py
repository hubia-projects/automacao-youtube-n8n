"""Phase 3 — Token-bucket + circuit-breaker rate limiter para Gemini Flash.

Usado como Singleton (clientes partilham state) por:
    - studio.library.metadata.analyze_shot  (initial Vision)
    - studio.library.confirmation.generate_multimodal  (entity confirm)
    - studio.library.ingest_asset  (wrapper)

P16 (20-principles library plan):
    "Implementar rate limiter CENTRAL para Gemini. Não deixar cada função
    chamar Gemini independentemente sem coordenação. Responsável por:
    requests por segundo, requests simultâneos, 429, Retry-After,
    exponential backoff + jitter, cooldown global, retry budget,
    circuit breaker."

P17:
    Não paralelizar indiscriminadamente. Criar Settings:
    STUDIO_LIBRARY_SIGLIP_BATCH, STUDIO_LIBRARY_GEMINI_CONCURRENCY …

P16 circuit breaker: 3-5 consecutivos 429 → entra GEMINI_COOLDOWN
60-180s. Próximas calls fail-fast (não gastam quota do user).

Reset: report_success() zera consecutive_429; tokens refill dinâmico.

DOC: 20-principles library plan §P16 P17.
"""
from __future__ import annotations

import logging
import random
import threading
import time
from typing import Optional

from studio.config import Settings

log = logging.getLogger("studio.library.rate_limit")


class GeminiRateLimiter:
    """Token bucket + circuit-breaker. Singleton por invocação de Settings.

    Conceitos:
      - bucket capacity (burst)         — picos curtos OK
      - refill rate (RPS)               — sustained, configurável
      - cooldown window (after N 429)   — circuit-breaker open
      - CB open duration                — fail-fast antes de gastar quota
    """

    def __init__(self, settings: Settings,
                 *, rps: Optional[float] = None,
                 burst: Optional[int] = None,
                 cooldown_s: Optional[float] = None,
                 cb_threshold: Optional[int] = None) -> None:
        # Ler settings (override-OK por kwargs para testes/smoke).
        self._rps = float(rps if rps is not None
                          else getattr(settings, "gemini_rps", 5.0))
        self._burst = int(burst if burst is not None
                          else getattr(settings, "gemini_burst", 2))
        self._cooldown_s = float(cooldown_s if cooldown_s is not None
                                  else getattr(settings, "gemini_cooldown_s",
                                               60.0))
        self._cb_threshold = int(cb_threshold if cb_threshold is not None
                                  else getattr(settings, "gemini_cb_threshold",
                                               3))
        # Estado mutable (lock obrigatório).
        self._tokens = float(self._burst)
        self._last_refill = time.monotonic()
        self._consecutive_429 = 0
        self._cb_open_until = 0.0
        self._total_acquired = 0
        self._total_denied = 0
        self._lock = threading.Lock()

    def acquire(self, timeout: float = 30.0) -> bool:
        """Block até token disponível, ou até `timeout` expirar.

        Returns:
            True  → caller pode chamar Gemini
            False → timeout ou circuit-breaker aberto (fail-fast)
        """
        deadline = time.monotonic() + timeout
        while True:
            with self._lock:
                # Fail-fast se circuit-breaker aberto
                now = time.monotonic()
                if now < self._cb_open_until:
                    self._total_denied += 1
                    return False
                # Refill tokens (acumulado desde último acquire)
                elapsed = now - self._last_refill
                if elapsed > 0:
                    self._tokens = min(self._burst,
                                        self._tokens + elapsed * self._rps)
                    self._last_refill = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    self._total_acquired += 1
                    return True
            # Sem token — esperar um pouco antes de retry
            if time.monotonic() > deadline:
                self._total_denied += 1
                return False
            time.sleep(0.05)

    def report_rate_limit(self, retry_after: Optional[float] = None) -> None:
        """Caller chama após HTTP 429 (advertência Gemini enviou Retry-After).

        Efeitos:
          - consecutive_429 += 1
          - cb_open_until movido para max(atual, now+retry+jitter)
          - se consecutive_429 >= cb_threshold → TRIP breaker (cooldown longo)
        """
        ra = retry_after if (retry_after is not None and retry_after > 0) else 5.0
        jitter = random.uniform(0, 1.0)
        with self._lock:
            self._consecutive_429 += 1
            self._cb_open_until = max(
                self._cb_open_until, time.monotonic() + ra + jitter,
            )
            log.warning(
                "GeminiRateLimiter: 429 consecutive=%d — short cooldown %.2fs",
                self._consecutive_429, ra + jitter,
            )
            if self._consecutive_429 >= self._cb_threshold:
                open_for = self._cooldown_s + random.uniform(0, 30.0)
                self._cb_open_until = time.monotonic() + open_for
                log.error(
                    "GeminiRateLimiter: CIRCUIT BREAKER OPEN for %.1fs "
                    "(cb_threshold=%d consecutive_429=%d)",
                    open_for, self._cb_threshold, self._consecutive_429,
                )

    def report_success(self) -> None:
        """Caller's call succeeded — reset consecutive 429 counter."""
        with self._lock:
            if self._consecutive_429:
                log.info(
                    "GeminiRateLimiter: success após %d consecutivos — reset",
                    self._consecutive_429,
                )
            self._consecutive_429 = 0

    def stats(self) -> dict:
        with self._lock:
            return {
                "tokens_available": round(self._tokens, 3),
                "burst": self._burst,
                "rps": self._rps,
                "cooldown_s": self._cooldown_s,
                "cb_threshold": self._cb_threshold,
                "consecutive_429": self._consecutive_429,
                "circuit_open_in_s": round(
                    max(0.0, self._cb_open_until - time.monotonic()), 2
                ),
                "total_acquired": self._total_acquired,
                "total_denied_circuit": self._total_denied,
            }


# Singleton lazy por thread / por processo (idempotente em reimports).
_singleton: Optional[GeminiRateLimiter] = None
_singleton_lock = threading.Lock()


def get_gemini_limiter(settings: Settings) -> GeminiRateLimiter:
    """Devolve o limiter global. Singleton por processo."""
    global _singleton
    with _singleton_lock:
        if _singleton is None:
            _singleton = GeminiRateLimiter(settings)
            log.info(
                "GeminiRateLimiter: singleton instanciado rps=%.2f burst=%d "
                "cooldown_s=%.0f cb_threshold=%d",
                _singleton._rps, _singleton._burst,
                _singleton._cooldown_s, _singleton._cb_threshold,
            )
        return _singleton


def reset_singleton() -> None:
    """Testes / REPL — invalida o singleton para criar um novo."""
    global _singleton
    with _singleton_lock:
        _singleton = None


__all__ = [
    "GeminiRateLimiter",
    "get_gemini_limiter",
    "reset_singleton",
]
