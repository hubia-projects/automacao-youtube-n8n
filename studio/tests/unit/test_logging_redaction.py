"""Testes de redaction de secrets em logging (item 2 do master task).

Contexto: studio/porto_closure.log tinha uma API key Gemini real committed,
vazada porque httpx loga a URL completa (com `?key=...`) a nivel INFO, e
`logging.basicConfig(level=logging.INFO)` deixava isso propagar para
stdout/stderr (e portanto para qualquer redirect > ficheiro.log).
"""
from __future__ import annotations

import logging

from studio.logging_setup import (
    SecretRedactionFilter,
    configure_logging,
    redact_secrets,
)


def test_redact_secrets_masks_key_query_param():
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           "gemini-flash-latest:generateContent?key=AIzaSyD2GUVbSQj4Jp8R6ZpE6tri4qhbhbz-taY")
    out = redact_secrets(f"HTTP Request: POST {url} \"HTTP/1.1 200 OK\"")
    assert "AIzaSy" not in out
    assert "key=<REDACTED>" in out


def test_redact_secrets_masks_bearer_token():
    out = redact_secrets("Authorization: Bearer abc123.def456-ghi")
    assert "abc123" not in out
    assert "Bearer <REDACTED>" in out


def test_redact_secrets_leaves_normal_text_untouched():
    text = "shot ad7facb2586f_000 saltado (legacy analyze_shot falhou)"
    assert redact_secrets(text) == text


def test_secret_redaction_filter_scrubs_log_record(caplog):
    log = logging.getLogger("test.redaction")
    log.addFilter(SecretRedactionFilter())
    with caplog.at_level(logging.INFO, logger="test.redaction"):
        log.info("GET %s?key=%s", "https://api.example.com/x", "SECRET_VALUE_123")
    assert "SECRET_VALUE_123" not in caplog.text
    assert "<REDACTED>" in caplog.text


def test_configure_logging_raises_httpx_logger_level():
    configure_logging(level=logging.INFO)
    assert logging.getLogger("httpx").level >= logging.WARNING
    assert logging.getLogger("httpcore").level >= logging.WARNING


def test_configure_logging_installs_filter_on_root_handlers():
    configure_logging(level=logging.INFO)
    root = logging.getLogger()
    assert any(isinstance(f, SecretRedactionFilter) for f in root.filters) or any(
        isinstance(f, SecretRedactionFilter)
        for h in root.handlers
        for f in h.filters
    )
