"""provider_errors.py — item PORTO FINAL ASSET TEST (secções 7-10):
excepção partilhada para "este provider está temporariamente
rate-limited" — distinta de uma falha genérica (rede, parse, schema).

Módulo neutro (zero dependências do resto do studio) para evitar import
circular: `library/sources/*.py` levanta-a, `acquisition.py` apanha-a —
nenhum dos dois precisa de importar o outro só por causa disto.

Comportamento esperado do caller ao apanhar isto (nunca esperar
indefinidamente por um provider em cima do rate-limit):
    provider rate-limited
    -> marcar esse provider como temporariamente indisponível
    -> abandonar as restantes tentativas PARA ESSE provider nesta wave
    -> avançar para o próximo provider da waterfall (nunca hang)
"""
from __future__ import annotations


class ProviderRateLimitedError(RuntimeError):
    """Levantada por um provider (`sources/*.py`) quando detecta rate-limit
    sustentado (ex.: 429 repetido mesmo após backoff) — não uma falha
    pontual de rede. `provider` identifica qual (ex.: "wikimedia") para o
    caller decidir a waterfall sem inspeccionar strings de mensagem."""

    def __init__(self, provider: str, message: str = ""):
        self.provider = provider
        super().__init__(message or f"{provider}: rate-limited (temporary)")
