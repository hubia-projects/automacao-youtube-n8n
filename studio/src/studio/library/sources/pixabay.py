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
from studio.library.text_match import rank_by_hints

log = logging.getLogger("studio.sources.pixabay")

SEARCH_URL = "https://pixabay.com/api/videos/"
_DOWNLOAD_TIMEOUT_S = 120
_DOWNLOAD_RETRIES = 3


@dataclass
class CandidateMetadata:
    """Espelha `pexels.py::CandidateMetadata` (mesmo contrato two-phase).

    `tags`/`duration`/`width`/`height` (PORTO FINAL RETRIEVAL FIX, secção
    9): Pixabay devolve tags reais (curadoria humana, ao contrário do
    slug de URL do Pexels) — antes descartadas; agora preservadas para
    ranking (`rank_by_hints`) e observabilidade/proveniência."""
    provider: str
    provider_id: str
    source_url: str
    download_url: str
    license: dict = field(default_factory=dict)
    tags: str = ""
    duration: float = 0.0
    width: int = 0
    height: int = 0


def search(query_en: str, count: int, settings: Settings,
          *, canonical_hints: tuple[str, ...] = ()) -> list[CandidateMetadata]:
    """Fase 1 (só SEARCH): zero downloads de vídeo.

    Sem `canonical_hints`: comportamento legacy (1 página, `per_page=
    min(max(count,3),200)`).

    Com `canonical_hints` (PORTO FINAL RETRIEVAL FIX, secções 9, 24-26):
    pool de metadata maior (`settings.pixabay_search_pool`, default 60)
    via paginação (até `settings.pixabay_search_max_pages`, default 3,
    pára cedo numa página vazia), ranking local por `rank_by_hints`
    (tags + pageURL — tags são curadoria humana, sinal forte), devolve só
    os `count` melhores."""
    if not settings.pixabay_api_key:
        raise RuntimeError("PIXABAY_API_KEY em falta")

    hints = tuple(h.strip() for h in canonical_hints if h and h.strip())
    pool_limit = max(count, int(getattr(settings, "pixabay_search_pool", 60)
                                or 60)) if hints else count
    max_pages = int(getattr(settings, "pixabay_search_max_pages", 3)
                    or 3) if hints else 1

    t0 = time.perf_counter()
    pool: list[CandidateMetadata] = []
    seen_ids: set[str] = set()
    page = 1
    with httpx.Client(timeout=30) as c:
        while len(pool) < pool_limit and page <= max_pages:
            per_page = min(max(pool_limit - len(pool), 3), 200)
            resp = c.get(
                SEARCH_URL,
                params={"key": settings.pixabay_api_key, "q": query_en,
                        "per_page": per_page, "page": page,
                        "safesearch": "true"},
            )
            resp.raise_for_status()
            hits = resp.json().get("hits", [])
            if not hits:
                break
            for hit in hits:
                hit_id = str(hit["id"])
                if hit_id in seen_ids:
                    continue
                videos = hit.get("videos", {})
                variant = (videos.get("large") or videos.get("medium")
                          or videos.get("small"))
                if not variant or not variant.get("url"):
                    continue
                page_url = hit.get("pageURL", "")
                seen_ids.add(hit_id)
                pool.append(CandidateMetadata(
                    provider="pixabay",
                    provider_id=hit_id,
                    source_url=page_url,
                    download_url=variant["url"],
                    tags=hit.get("tags", "") or "",
                    duration=float(hit.get("duration", 0.0) or 0.0),
                    width=int(variant.get("width", 0) or 0),
                    height=int(variant.get("height", 0) or 0),
                    license={
                        "source": "pixabay",
                        "source_url": page_url,
                        "license": "pixabay",
                        "author": hit.get("user", ""),
                        "verified_by": "api",
                    },
                ))
            page += 1
    search_elapsed = time.perf_counter() - t0

    def _text(c: CandidateMetadata) -> str:
        return f"{c.tags} {c.source_url}"

    ranked = rank_by_hints(pool, hints, _text) if hints else pool
    out = ranked[:count]
    log.info("pixabay-search '%s' (hints=%s): pool=%d -> top=%d candidatos "
             "(search=%.1fs, pages=%d) — 0 bytes de vídeo transferidos",
             query_en, hints, len(pool), len(out), search_elapsed, page - 1)
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
