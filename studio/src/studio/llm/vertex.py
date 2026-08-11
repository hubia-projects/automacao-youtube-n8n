"""Vertex AI courier (REST via httpx).

Substitui Gemini AI Studio direta quando `GEMINI_VERTEX_ENABLED=true`.

Auth OAuth2 JWT Bearer — implementação MANUAL via `cryptography` +
`httpx`. Razão: o `google-auth` padrão pendura indefinidamente no refresh
neste ambiente (transport `requests.Session` sem timeout default; obras com
HttpxTransport wrapper também ficaram hanging — causa-raiz não isolada na
transport layer, suspeita é no próprio retry/state interno do google-auth).
Manual é determinístico, ~80 linhas, thread-safe, sem dependências
ocultas.

Spec Google: https://developers.google.com/identity/protocols/oauth2/service-account
Flow: ler JSON service account → construir JWT (header.payload.signature
com RS256) → POST `https://oauth2.googleapis.com/token` com
`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={JWT}`.

Importa `_http_with_retry`, `_price`, `_TIMEOUT_STRUCT`, `log_call`
(underscore-prefixed) do `gemini.py` de propósito: são co-located LLM
helpers partilhados entre Gemini AI Studio e Vertex.
"""

from __future__ import annotations

import base64
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from studio.config import Settings
from studio.llm.gemini import _TIMEOUT_STRUCT, _http_with_retry, _price, log_call

log = logging.getLogger("studio.llm.vertex")

_SCOPES = "https://www.googleapis.com/auth/cloud-platform"
_TOKEN_URI = "https://oauth2.googleapis.com/token"
# 5min skew — Google recomenda clock skew tolerance para evitar race com
# expiry exacto do access token (1h).
_TOKEN_SKEW_S = 300
# OAuth2 POST timeout (sub-segundo validado network, mas tolera cold start).
_TOKEN_HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)


@dataclass
class _TokenCache:
    access_token: str
    expires_at: float
    sa_email: str


# Cache em módulo (1 por processo)
_CACHED_TOKEN: _TokenCache | None = None


def _b64url(data: bytes) -> str:
    """Base64Url encode sem padding (RFC 7515 §2)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _generate_jwt(sa_info: dict) -> str:
    """Constrói e assina JWT RS256 (claims: iss/scope/aud/iat/exp)."""
    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    payload = {
        "iss": sa_info["client_email"],
        "scope": _SCOPES,
        "aud": _TOKEN_URI,
        "iat": now,
        "exp": now + 3600,
    }
    header_enc = _b64url(json.dumps(header, separators=(",", ":")).encode())
    payload_enc = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    msg = f"{header_enc}.{payload_enc}".encode("ascii")

    private_key = serialization.load_pem_private_key(
        sa_info["private_key"].encode("utf-8"), password=None)
    sig = private_key.sign(msg, padding.PKCS1v15(), hashes.SHA256())
    return f"{header_enc}.{payload_enc}.{_b64url(sig)}"


def _load_sa_info(settings: Settings) -> dict:
    """Lê e valida JSON do service account; cached em módulo por path."""
    path_str = settings.google_application_credentials
    if not path_str:
        raise FileNotFoundError(
            "Vertex enabled mas GOOGLE_APPLICATION_CREDENTIALS vazio no .env")
    path = Path(path_str)
    if not path.is_file():
        raise FileNotFoundError(f"Vertex auth file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _get_vertex_token(settings: Settings) -> str:
    """Devolve Bearer token, gerando novo via JWT se expirado."""
    global _CACHED_TOKEN

    if _CACHED_TOKEN and _CACHED_TOKEN.expires_at > time.time() + _TOKEN_SKEW_S:
        return _CACHED_TOKEN.access_token

    sa_info = _load_sa_info(settings)
    jwt_token = _generate_jwt(sa_info)

    log.info("vertex: a obter novo access token para %s", sa_info["client_email"])
    # _http_with_retry: usa a mesma retry/backoff do resto do LLM pipeline
    # (429/5xx com Retry-After). Consistente com `generate()`.
    resp = _http_with_retry(
        _TOKEN_URI,
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": jwt_token,
        },
        timeout=_TOKEN_HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    token_data = resp.json()
    # Defensive: `expires_in` pode vir como int (Google) ou string ("3600") em
    # versões antigas / proxies; `int(float(...))` cobre ambos.
    expires_in = int(float(token_data.get("expires_in", 3600)))
    _CACHED_TOKEN = _TokenCache(
        access_token=token_data["access_token"],
        expires_at=time.time() + expires_in,
        sa_email=sa_info["client_email"],
    )
    log.info("vertex: token OK (expira em %ds)", expires_in)
    return _CACHED_TOKEN.access_token


def _endpoint(settings: Settings, model: str) -> str:
    return (
        f"https://{settings.google_cloud_location}-aiplatform.googleapis.com/"
        f"v1/projects/{settings.google_cloud_project}/locations/"
        f"{settings.google_cloud_location}/publishers/google/models/"
        f"{model}:generateContent"
    )


def generate(prompt: str, settings: Settings, *, model: str | None = None,
             json_mode: bool = False, search_grounding: bool = False,
             temperature: float = 0.7,
             timeout: httpx.Timeout = _TIMEOUT_STRUCT,
             tag: str = "") -> tuple[str, float]:
    """Vertex AI generateContent — mesmo contrato que `gemini.generate()`."""
    model = model or settings.model_flash
    if not settings.google_cloud_project:
        raise RuntimeError(
            "Vertex enabled mas GOOGLE_CLOUD_PROJECT vazio no .env")

    url = _endpoint(settings, model)
    body: dict = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature},
    }
    if json_mode:
        body["generationConfig"]["response_mime_type"] = "application/json"
    if search_grounding:
        body["tools"] = [{"google_search": {}}]

    headers = {"Authorization": f"Bearer {_get_vertex_token(settings)}"}

    resp = _http_with_retry(url, headers=headers, json=body, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()

    text = "".join(p.get("text", "") for p in
                   data["candidates"][0]["content"]["parts"])
    usage = data.get("usageMetadata", {})
    prompt_tokens = usage.get("promptTokenCount", 0)
    output_tokens = usage.get("candidatesTokenCount", 0)
    p_in, p_out = _price(model)
    cost = prompt_tokens * p_in + output_tokens * p_out

    log_call(settings, tag=tag, model=f"vertex:{model}",
             prompt_tokens=prompt_tokens, output_tokens=output_tokens,
             cost_usd=cost)
    return text, cost
