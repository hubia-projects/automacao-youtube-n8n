"""Fonte Pixabay — pesquisa e download de vídeos com licença autopreenchida.

Rewrite two-phase (item 29 do fecho de cobertura multi-provider): antes só
tinha `sweep()` legacy (search+download acoplado, sem pre-download dedup).
Agora segue o MESMO contrato de `pexels.py`: `search()` (zero bytes de
vídeo) + `download()` (só candidatos já filtrados por dedup) — permite ao
`AcquisitionService` (acquisition.py::make_provider_resolver) aplicar
`is_provider_already_taken()` ANTES do byte vir da rede, como já faz para
Pexels/Wikimedia. `sweep()` mantém-se como wrapper de compat legacy.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from studio.config import Settings

log = logging.getLogger("studio.sources.pixabay")

SEARCH_URL = "https://pixabay.com/api/videos/"
_DOWNLOAD_TIMEOUT_S = 120
_DOWNLOAD_RETRIES = 3


@dataclass
class CandidateMetadata:
    """Espelha `pexels.py::CandidateMetadata` (mesmo contrato two-phase)."""
    provider: str
    provider_id: str
    source_url: str
    download_url: str
    license: dict = field(default_factory=dict)


def search(query_en: str, count: int, settings: Settings) -> list[CandidateMetadata]:
    """Fase 1 (só SEARCH): 1 GET à SEARCH_URL, zero downloads de vídeo."""
    if not settings.pixabay_api_key:
        raise RuntimeError("PIXABAY_API_KEY em falta")

    t0 = time.perf_counter()
    with httpx.Client(timeout=30) as c:
        resp = c.get(
            SEARCH_URL,
            params={"key": settings.pixabay_api_key, "q": query_en,
                    "per_page": min(max(count, 3), 200), "safesearch": "true"},
        )
        resp.raise_for_status()
    hits = resp.json().get("hits", [])[:count]
    search_elapsed = time.perf_counter() - t0

    out: list[CandidateMetadata] = []
    for hit in hits:
        videos = hit.get("videos", {})
        variant = videos.get("large") or videos.get("medium") or videos.get("small")
        if not variant or not variant.get("url"):
            continue
        hit_id = str(hit["id"])
        page_url = hit.get("pageURL", "")
        out.append(CandidateMetadata(
            provider="pixabay",
            provider_id=hit_id,
            source_url=page_url,
            download_url=variant["url"],
            license={
                "source": "pixabay",
                "source_url": page_url,
                "license": "pixabay",
                "author": hit.get("user", ""),
                "verified_by": "api",
            },
        ))
    log.info("pixabay-search '%s': %d candidatos (search=%.1fs) — "
             "0 bytes de vídeo transferidos", query_en, len(out), search_elapsed)
    return out


def _sleep_backoff(attempt: int) -> None:
    time.sleep({0: 1, 1: 4, 2: 10}.get(attempt, 10))


def download(candidate: CandidateMetadata, settings: Settings, dest: Path) -> Path:
    """Fase 2 (só DOWNLOAD): 1 candidato já filtrado por dedup (pre-
    download)."""
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / f"pixabay_{candidate.provider_id}.mp4"
    if target.exists() and target.stat().st_size > 0:
        return target
    tmp = target.with_suffix(target.suffix + ".tmp")
    last_exc: Exception | None = None
    with httpx.Client(timeout=_DOWNLOAD_TIMEOUT_S, follow_redirects=True) as c:
        for attempt in range(_DOWNLOAD_RETRIES):
            try:
                with c.stream("GET", candidate.download_url) as r:
                    if r.status_code in (429, 500, 502, 503, 504):
                        tmp.unlink(missing_ok=True)
                        last_exc = httpx.HTTPStatusError(
                            f"{r.status_code}", request=r.request, response=r)
                        _sleep_backoff(attempt)
                        continue
                    r.raise_for_status()
                    with tmp.open("wb") as fh:
                        for chunk in r.iter_bytes(1 << 20):
                            fh.write(chunk)
                import os
                os.replace(tmp, target)
                return target
            except (httpx.TimeoutException, httpx.NetworkError,
                    httpx.RemoteProtocolError, httpx.ConnectError) as exc:
                last_exc = exc
                tmp.unlink(missing_ok=True)
                _sleep_backoff(attempt)
            except Exception:
                tmp.unlink(missing_ok=True)
                raise
    raise last_exc if last_exc else RuntimeError("pixabay: retries esgotados")


def sweep(query_en: str, count: int, settings: Settings, dest: Path) -> list[tuple[Path, dict]]:
    """Wrapper legacy (compat CLI/testes/callers antigos): search()+
    download() sequencial, SEM pre-download dedup — mesmo papel de
    `pexels.py::sweep`."""
    candidates = search(query_en, count, settings)
    out: list[tuple[Path, dict]] = []
    for cand in candidates:
        path = download(cand, settings, dest)
        out.append((path, cand.license))
        log.info("pixabay: %s", path.name)
    return out
