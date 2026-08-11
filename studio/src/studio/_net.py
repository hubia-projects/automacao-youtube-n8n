"""Networking utils — IPv4-only DNS workaround para IPv6 blackhole.

Esta máquina tem IPv6 com drop silencioso para os servers Google
(httpx/requests/urllib penduram ~60-120s à espera do SYN timeout do SO
quando Python devolve AF_INET6 como primeiro resultado de getaddrinfo).
`curl` resolve via Happy Eyeballs (RFC 6555) com fallback rápido para
AF_INET — por isso responde em 0.3s enquanto httpx pendura 30+.

Aqui forçamos o mesmo comportamento para Python stdlib: quando o caller
pede family=AF_UNSPEC (default, ~99% dos casos), re-chamamos getaddrinfo
com AF_INET explícito. Se o caller pedir AF_INET6 explicitamente,
respeitamos — não alteramos comportamento específico.

Aplicar via `apply_ipv4_only()` no orchestrator startup (`runner.py`).
Idempotente (uma chamada por processo).

Side-effects:
- DNS que só tem AAAA records (IPv6-only) continua a funcionar (caller
  explícito passa por nós; fallback original é honrado se tentativa
  AF_INErIN der vazio).
- DNS misto (Google: A + AAAA) devolve só A records → httpx/requests
  ligam a IPv4 → sem hang.

Referências:
- Python `socket.getaddrinfo(host, port, family=AF_UNSPEC, ...)`:
  https://docs.python.org/3/library/socket.html#socket.getaddrinfo
- Happy Eyeballs RFC 6555: https://www.rfc-editor.org/rfc/rfc6555

ADR-XXX — manter este workaround isolado em _net.py porque é ortogonal
à lógica do Studio. Quando a rede IPv6 tiver suporte real, basta remover
a chamada em runner.py e este ficheiro fica dead-code (manter 6 meses
para retro-compatibilidade).
"""

from __future__ import annotations

import logging
import socket

log = logging.getLogger("studio.net")

_APPLIED: bool = False


def apply_ipv4_only() -> None:
    """Monkeypatch `socket.getaddrinfo` para preferir IPv4 quando family=AF_UNSPEC.

    Idempotente. Chamada 1x por processo (ex: no orchestrator startup).
    """
    global _APPLIED
    if _APPLIED:
        log.debug("apply_ipv4_only já aplicado neste processo — skip (idempotente)")
        return
    _orig = socket.getaddrinfo

    def _patched(host, port, *args, **kwargs):
        """getaddrinfo patched: força AF_INET quando caller pede AF_UNSPEC.

        Se AF_INET-only der vazio (serviço verdadeiramente IPv6-only),
        cai para o original que pode devolver AF_INET6 — preserva
        comportamento "any" sem hangs de IPv6 (que eram o problema).
        """
        family = args[0] if args else kwargs.get("family", socket.AF_UNSPEC)
        if family == socket.AF_UNSPEC:
            try:
                ipv4_results = _orig(host, port, socket.AF_INET,
                                     *args[1:], **kwargs)
                if ipv4_results:
                    return ipv4_results
            except socket.gaierror:
                pass
        return _orig(host, port, *args, **kwargs)

    socket.getaddrinfo = _patched
    _APPLIED = True
    log.info("ipv4-only DNS monkeypatch aplicado (workaround IPv6 blackhole)")
