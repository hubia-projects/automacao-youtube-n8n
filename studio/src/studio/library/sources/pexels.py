"""Fonte Pexels — pesquisa e download de vídeos com licença autopreenchida.

Sprint B (Fase 1 + 2): downloads paralelos dentro de UMA query + retry
exponencial + escrita atómica (.tmp + os.replace). Mantém a assinatura
`sweep(query_en, count, settings, dest) -> list[tuple[Path, dict]]`
para drop-in compat com assigner.py + cli.py + pixabay/wikimedia/vimeo
(mesmo padrão a replicar noutras fontes; ver plano Opção B 2026-08-07).

Trade-offs documentados:
- I/O (rede MP4) é GIL-livre → ThreadPoolExecutor é seguro e elimina
  ~3× no tempo de download (em vez de sequencial N× ~10-30s cada).
- A pesquisa (`httpx.get` da SEARCH_URL) MANTÉM-SE sequencial porque
  o resultado JSON define as próximas URLs e a sua ORDEM (que tem de
  ser preservada por `executor.map`).
- Escrita atómica via `.tmp` + `os.replace` defende contra SIGTERM ou
  crash a meio do download (`shutil.copy2` em ingest.py não é atómico).
- Retry exponencial manual (1s, 4s, 10s) cobre 429/503/timeouts sem
  adicionar dep (`tenacity` não está no pyproject.toml).
"""

from __future__ import annotations

import concurrent.futures
import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from studio.config import Settings

log = logging.getLogger("studio.sources.pexels")

SEARCH_URL = "https://api.pexels.com/videos/search"
MAX_HEIGHT = 1080  # não descarregar 4K na ingestão — proxy chega para indexar

# Defaults alinhados com limites públicos Pexels (200 req/min, 20k req/mês)
_DOWNLOAD_TIMEOUT_S = 120
_DOWNLOAD_RETRIES = 3
_DOWNLOAD_MAX_WORKERS = 4
_tls = threading.local()  # 1 httpx.Client por thread (reutiliza connection pool)


def _client() -> httpx.Client:
    """httpx.Client por thread — reusa connection pool, thread-safe."""
    c = getattr(_tls, "c", None)
    if c is None:
        c = httpx.Client(
            timeout=_DOWNLOAD_TIMEOUT_S,
            follow_redirects=True,
            headers={"User-Agent": "studio-hubia/0"},
        )
        _tls.c = c
    return c


def _sleep_backoff(attempt: int) -> None:
    # 1s, 4s, 10s — cap em 10s para não esticar timings em séries longas
    delay = {0: 1, 1: 4, 2: 10}.get(attempt, 10)
    time.sleep(delay)


def _download_one(url: str, target: Path) -> Path:
    """Descarrega UM MP4 com retry exp + escrita atómica. Idempotente."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0:  # dedupe em disco
        return target
    tmp = target.with_suffix(target.suffix + ".tmp")
    last_exc: Exception | None = None
    for attempt in range(_DOWNLOAD_RETRIES):
        try:
            with _client().stream("GET", url) as r:
                if r.status_code in (429, 500, 502, 503, 504):
                    # Retryable HTTP — limpar partial tmp antes de dormir
                    tmp.unlink(missing_ok=True)
                    log.warning("pexels: %s HTTP %d (tentativa %d/%d)",
                                target.name, r.status_code, attempt + 1, _DOWNLOAD_RETRIES)
                    last_exc = httpx.HTTPStatusError(
                        f"{r.status_code}", request=r.request, response=r)
                    _sleep_backoff(attempt)
                    continue
                r.raise_for_status()
                # headers de rate-limit (se Pexels enviar)
                rl_remaining = r.headers.get("x-ratelimit-remaining")
                rl_limit = r.headers.get("x-ratelimit-limit")
                if rl_remaining is not None:
                    log.debug("pexels rate-limit: %s/%s", rl_remaining, rl_limit)
                with tmp.open("wb") as fh:
                    for chunk in r.iter_bytes(1 << 20):
                        fh.write(chunk)
            # Sucesso: rename atómico (POSIX rename(2) é atómico)
            os_replace = __import__("os").replace
            os_replace(tmp, target)
            return target
        except (httpx.TimeoutException, httpx.NetworkError,
                httpx.RemoteProtocolError, httpx.ConnectError) as exc:
            last_exc = exc
            tmp.unlink(missing_ok=True)
            log.warning("pexels: %s falhou (%s) tentativa %d/%d",
                        target.name, exc, attempt + 1, _DOWNLOAD_RETRIES)
            _sleep_backoff(attempt)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    # esgotaram-se retries — devolve None-equivalente via raising
    raise last_exc if last_exc else RuntimeError("pexels: retries esgotados")


@dataclass
class CandidateMetadata:
    """Resultado de `search()` — ZERO bytes de vídeo transferidos ainda
    (item P do closure pass: separa search de download para permitir
    dedup ANTES do byte vir da rede)."""
    provider: str
    provider_id: str
    source_url: str
    download_url: str
    license: dict = field(default_factory=dict)


def search(query_en: str, count: int, settings: Settings) -> list[CandidateMetadata]:
    """Fase 1 (só SEARCH): 1 GET à SEARCH_URL, zero downloads de vídeo.
    Devolve candidatos NA ORDEM do ranking Pexels."""
    if not settings.pexels_api_key:
        raise RuntimeError("PEXELS_API_KEY em falta")

    t0 = time.perf_counter()
    with httpx.Client(timeout=30) as c:
        resp = c.get(
            SEARCH_URL,
            headers={"Authorization": settings.pexels_api_key},
            params={"query": query_en, "per_page": min(count, 80),
                    "orientation": "landscape"},
        )
        resp.raise_for_status()
    videos = resp.json().get("videos", [])[:count]
    search_elapsed = time.perf_counter() - t0

    out: list[CandidateMetadata] = []
    for video in videos:
        files = [f for f in video.get("video_files", [])
                 if f.get("height") and f["height"] <= MAX_HEIGHT]
        if not files:
            continue
        best = max(files, key=lambda f: f["height"])
        vid_id = int(video["id"])
        author = (video.get("user") or {}).get("name", "")
        out.append(CandidateMetadata(
            provider="pexels",
            provider_id=str(vid_id),
            source_url=f"https://www.pexels.com/video/{vid_id}/",
            download_url=best["link"],
            license={
                "source": "pexels",
                "source_url": f"https://www.pexels.com/video/{vid_id}/",
                "license": "pexels",
                "author": author,
                "verified_by": "api",
            },
        ))
    log.info("pexels-search '%s': %d candidatos (search=%.1fs) — "
             "0 bytes de vídeo transferidos", query_en, len(out), search_elapsed)
    return out


def download(candidate: CandidateMetadata, settings: Settings, dest: Path) -> Path:
    """Fase 2 (só DOWNLOAD): 1 candidato já filtrado por dedup (pre-download,
    item P). Caller decide QUAIS candidatos chegam aqui."""
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / f"pexels_{candidate.provider_id}.mp4"
    return _download_one(candidate.download_url, target)


def sweep(query_en: str, count: int, settings: Settings, dest: Path) -> list[tuple[Path, dict]]:
    """Wrapper legacy (compat CLI/testes/callers antigos): search()+
    download() paralelo, SEM dedup pré-download — quem quiser dedup real
    antes do byte vir da rede usa `search()`+`download()` directamente
    (ver `acquisition.make_provider_resolver`). Devolve [(ficheiro,
    licença)] NA ORDEM do ranking Pexels (determinístico — `executor.map`
    preserva inputs)."""
    candidates = search(query_en, count, settings)
    if not candidates:
        return []
    dest.mkdir(parents=True, exist_ok=True)

    t1 = time.perf_counter()
    workers = min(_DOWNLOAD_MAX_WORKERS, len(candidates))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        run_with_retries = lambda cand: download(cand, settings, dest)
        results = list(ex.map(run_with_retries, candidates))
    download_elapsed = time.perf_counter() - t1
    log.info("pexels-sweep '%s': %d/%d download em %.1fs (workers=%d)",
             query_en, len(results), len(candidates), download_elapsed, workers)

    out: list[tuple[Path, dict]] = []
    for cand, path in zip(candidates, results):
        out.append((path, cand.license))
        log.info("pexels: %s", path.name)
    return out
