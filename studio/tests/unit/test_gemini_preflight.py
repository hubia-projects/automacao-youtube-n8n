"""Item N (closure pass): preflight_gemini_credentials — 1 chamada barata
ANTES de qualquer confirmação Vision/aquisição longa. Doutrina explícita:
nunca gastar a sessão a repetir a mesma key inválida.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from studio.config import Settings
from studio.library.gemini_preflight import (
    CREDENTIALS_INVALID,
    CREDENTIALS_MISSING,
    preflight_gemini_credentials,
)


def test_mock_mode_fail_open_sem_chamada_de_rede():
    settings = Settings(STUDIO_MOCK="1")
    with patch("httpx.get") as mock_get:
        ok, reason = preflight_gemini_credentials(settings)
    assert ok is True
    assert reason == ""
    mock_get.assert_not_called()


def test_sem_key_configurada_falha_sem_chamada_de_rede():
    settings = Settings(STUDIO_MOCK="0", GEMINI_API_KEY="")
    with patch("httpx.get") as mock_get:
        ok, reason = preflight_gemini_credentials(settings)
    assert ok is False
    assert CREDENTIALS_MISSING in reason
    mock_get.assert_not_called()


def test_403_da_api_marca_credencial_invalida():
    settings = Settings(STUDIO_MOCK="0", GEMINI_API_KEY="key-invalida")
    with patch("httpx.get", return_value=SimpleNamespace(status_code=403)):
        ok, reason = preflight_gemini_credentials(settings)
    assert ok is False
    assert CREDENTIALS_INVALID in reason
    assert "key-invalida" not in reason, "nunca imprimir a key (segurança)"


def test_200_da_api_marca_credencial_valida():
    settings = Settings(STUDIO_MOCK="0", GEMINI_API_KEY="key-valida")
    with patch("httpx.get", return_value=SimpleNamespace(status_code=200)):
        ok, reason = preflight_gemini_credentials(settings)
    assert ok is True
    assert reason == ""


def test_falha_de_rede_e_fail_soft_nao_bloqueia():
    settings = Settings(STUDIO_MOCK="0", GEMINI_API_KEY="key-qualquer")
    with patch("httpx.get", side_effect=ConnectionError("dns falhou")):
        ok, reason = preflight_gemini_credentials(settings)
    assert ok is True, "falha de REDE não deve bloquear (só credencial invalida)"
