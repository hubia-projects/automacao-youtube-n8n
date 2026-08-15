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
from studio.library.text_match import rank_by_hints

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
    dedup ANTES do byte vir da rede).

    `title`/`preview_url` (PORTO FINAL RETRIEVAL FIX, secções 6-8):
    Pexels não tem campo "title" explícito para vídeo, mas `url` (página
    do vídeo) embute um slug descritivo (ex.: ".../video/gothic-cathedral-
    aerial-view-12345/") — `title` extrai esse slug para permitir ranking
    textual (`rank_by_hints`) igual ao já feito para Wikimedia, ANTES de
    gastar bytes a descarregar o MP4. `preview_url` (campo `image` da API)
    persiste a preview JPEG — base para triage visual futura (SigLIP
    sobre preview), não usada nesta passagem."""
    provider: str
    provider_id: str
    source_url: str
    download_url: str
    license: dict = field(default_factory=dict)
    title: str = ""
    preview_url: str = ""
    duration: float = 0.0
    width: int = 0
    height: int = 0


def _title_from_pexels_url(url: str) -> str:
    """".../video/gothic-cathedral-aerial-view-12345/" -> "gothic cathedral
    aerial view 12345" — mesmo padrão de `_source_title` (confirmation.py)/
    parsing de slug do Wikimedia, aplicado à URL de página do Pexels."""
    if not url:
        return ""
    path = url.rstrip("/").rsplit("/", 1)[-1]
    return path.replace("-", " ").replace("_", " ").strip()


def search(query_en: str, count: int, settings: Settings,
          *, canonical_hints: tuple[str, ...] = ()) -> list[CandidateMetadata]:
    """Fase 1 (só SEARCH): zero downloads de vídeo.

    Sem `canonical_hints`: comportamento legacy (1 página, `per_page=
    min(count,80)`, devolve tal como o ranking Pexels ordenou).

    Com `canonical_hints` (PORTO FINAL RETRIEVAL FIX, secções 4-8, 24-26 —
    "EXACT FIRST" + "high recall, low bandwidth"): pool de METADATA maior
    (`settings.pexels_search_pool`, default 60) via paginação (até
    `settings.pexels_search_max_pages`, default 3, pára cedo se uma
    página vier vazia), SEM filtro de orientação (secção 5 — um vídeo
    vertical certo é melhor que um landscape errado), ranking local por
    `rank_by_hints` (título derivado do slug da URL — secção 8), devolve
    só os `count` melhores. `sweep()`/callers legacy sem hints ficam
    intocados (mesmo nº de pedidos HTTP de sempre)."""
    if not settings.pexels_api_key:
        raise RuntimeError("PEXELS_API_KEY em falta")

    hints = tuple(h.strip() for h in canonical_hints if h and h.strip())
    pool_limit = max(count, int(getattr(settings, "pexels_search_pool", 60)
                                or 60)) if hints else count
    max_pages = int(getattr(settings, "pexels_search_max_pages", 3)
                    or 3) if hints else 1

    t0 = time.perf_counter()
    pool: list[CandidateMetadata] = []
    seen_ids: set[int] = set()
    page = 1
    with httpx.Client(timeout=30) as c:
        while len(pool) < pool_limit and page <= max_pages:
            per_page = min(pool_limit - len(pool), 80)
            params = {"query": query_en, "per_page": per_page, "page": page}
            # secção 5: orientation NUNCA enviado como filtro de discovery
            # — identidade certa importa mais que orientação; preferência
            # de orientação (se algum dia necessária) entra depois, na
            # selecção/ranking, nunca aqui excluindo candidatos à partida.
            resp = c.get(SEARCH_URL,
                        headers={"Authorization": settings.pexels_api_key},
                        params=params)
            resp.raise_for_status()
            videos = resp.json().get("videos", [])
            if not videos:
                break
            for video in videos:
                vid_id = int(video["id"])
                if vid_id in seen_ids:
                    continue
                files = [f for f in video.get("video_files", [])
                         if f.get("height") and f["height"] <= MAX_HEIGHT]
                if not files:
                    continue
                best = max(files, key=lambda f: f["height"])
                author = (video.get("user") or {}).get("name", "")
                page_url = video.get("url", "") or \
                    f"https://www.pexels.com/video/{vid_id}/"
                seen_ids.add(vid_id)
                pool.append(CandidateMetadata(
                    provider="pexels",
                    provider_id=str(vid_id),
                    source_url=page_url,
                    download_url=best["link"],
                    title=_title_from_pexels_url(page_url),
                    preview_url=video.get("image", "") or "",
                    duration=float(video.get("duration", 0.0) or 0.0),
                    width=int(video.get("width", 0) or 0),
                    height=int(video.get("height", 0) or 0),
                    license={
                        "source": "pexels",
                        "source_url": page_url,
                        "license": "pexels",
                        "author": author,
                        "verified_by": "api",
                    },
                ))
            page += 1
    search_elapsed = time.perf_counter() - t0

    ranked = rank_by_hints(pool, hints, lambda c: c.title) if hints else pool
    out = ranked[:count]
    log.info("pexels-search '%s' (hints=%s): pool=%d -> top=%d candidatos "
             "(search=%.1fs, pages=%d) — 0 bytes de vídeo transferidos",
             query_en, hints, len(pool), len(out), search_elapsed, page - 1)
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
