"""logging_setup.py — configuração central de logging com redaction de secrets.

Motivo: `studio/porto_closure.log` teve uma API key Gemini real leaked porque
httpx loga `HTTP Request: POST <url>?key=... "HTTP/1.1 200 OK"` a nível INFO,
e vários entrypoints chamavam `logging.basicConfig(level=logging.INFO)` sem
nenhuma redaction — qualquer stdout/stderr redirecionado para ficheiro (ex.:
`python script.py > out.log`) capturava a key em texto plano.

`configure_logging()` substitui `logging.basicConfig(...)` direto nos
entrypoints (`cli.py`, `reconcile.py`, `scripts/*.py`): mantém o mesmo nível
para o resto da app, mas (1) sobe o nível do logger "httpx"/"httpcore" para
WARNING — a única fonte real do leak — e (2) instala um `SecretRedactionFilter`
no root logger para apanhar qualquer outro caso em que uma URL/credencial
apareça formatada dentro de uma mensagem de log (ex.: `log.warning(f"... {exc}")`
onde `exc` é um `httpx.HTTPStatusError` cujo `str()` inclui a URL completa).
"""
from __future__ import annotations

import logging
import re

_SENSITIVE_QUERY = re.compile(
    r"(?i)([?&](?:key|token|access_token|api_key|apikey|secret)=)[^&\s\"'>]+"
)
_BEARER = re.compile(r"(?i)(Bearer\s+)[A-Za-z0-9._\-]+")


def redact_secrets(text: str) -> str:
    text = _SENSITIVE_QUERY.sub(r"\1<REDACTED>", text)
    text = _BEARER.sub(r"\1<REDACTED>", text)
    return text


class SecretRedactionFilter(logging.Filter):
    """Redige a mensagem final (já formatada) de qualquer LogRecord."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        record.msg = redact_secrets(msg)
        record.args = ()
        return True


def configure_logging(level: int = logging.INFO, fmt: str | None = None) -> None:
    kwargs: dict = {"level": level}
    if fmt is not None:
        kwargs["format"] = fmt
    logging.basicConfig(**kwargs)

    root = logging.getLogger()
    if not any(isinstance(f, SecretRedactionFilter) for f in root.filters):
        root.addFilter(SecretRedactionFilter())
    for handler in root.handlers:
        if not any(isinstance(f, SecretRedactionFilter) for f in handler.filters):
            handler.addFilter(SecretRedactionFilter())

    # httpx/httpcore logam a URL completa (incl. query string com API keys)
    # a nível INFO — nunca precisamos disso acima de WARNING.
    logging.getLogger("httpx").setLevel(max(level, logging.WARNING))
    logging.getLogger("httpcore").setLevel(max(level, logging.WARNING))
