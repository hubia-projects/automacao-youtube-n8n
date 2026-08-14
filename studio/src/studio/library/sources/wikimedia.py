"""Fonte Wikimedia Commons — pesquisa e download via API oficial MediaWiki
(action=query, generator=search/categorymembers + prop=imageinfo). SEM
scraping HTML (item 7 do fecho de cobertura multi-provider).

Mesma forma de `pexels.py`: `search(query_en, count, settings) ->
list[CandidateMetadata]` (zero bytes de media transferidos) +
`download(candidate, settings, dest) -> Path`. Suporta VÍDEO e IMAGEM no
mesmo provider — `CandidateMetadata.media_kind` distingue os dois via
`mime` (confirmado ao vivo: `image/jpeg`/`image/png` vs `video/webm`/
`video/ogg`).

Licença: `extmetadata.LicenseShortName` (ex.: "CC BY-SA 4.0") é normalizada
para o vocabulário canónico de `licenses.ALLOWED_LICENSES["wikimedia"]`
({"cc-by","cc-by-sa","cc0","pd"}) — candidatos com licença não reconhecida
são descartados em `search()` (nunca inventar licença, item 11).

Category-aware (item 9): se a busca por keyword devolver poucos resultados,
tenta também `Category:<query>` via `generator=categorymembers` — capado a
`count`, nunca a categoria inteira.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from studio.config import Settings

log = logging.getLogger("studio.sources.wikimedia")

API_URL = "https://commons.wikimedia.org/w/api.php"
_TIMEOUT_S = 30
_DOWNLOAD_TIMEOUT_S = 120
_DOWNLOAD_RETRIES = 3
_IIPROP = "url|mime|size|extmetadata|duration"


def _normalize_license(short_name: str) -> str:
    """'CC BY-SA 4.0' -> 'cc-by-sa' etc. String vazia = não reconhecida
    (caller descarta — nunca inventar licença, item 11)."""
    s = (short_name or "").strip().lower()
    if "by-sa" in s:
        return "cc-by-sa"
    if re.search(r"\bby\b", s):
        return "cc-by"
    if "cc0" in s:
        return "cc0"
    if "public domain" in s or s in ("pd", "pd-old"):
        return "pd"
    return ""


@dataclass
class CandidateMetadata:
    """Espelha `pexels.py::CandidateMetadata` + campos extra necessários
    para distinguir vídeo/imagem (Wikimedia serve ambos)."""
    provider: str
    provider_id: str
    source_url: str
    download_url: str
    license: dict = field(default_factory=dict)
    media_kind: str = "video"
    width: int = 0
    height: int = 0
    duration: float = 0.0


def _page_to_candidate(page: dict) -> CandidateMetadata | None:
    infos = page.get("imageinfo") or []
    if not infos:
        return None
    info = infos[0]
    mime = (info.get("mime") or "").lower()
    if mime.startswith("image/"):
        media_kind = "image"
    elif mime.startswith("video/"):
        media_kind = "video"
    else:
        return None  # audio/pdf/etc — fora de scope

    meta = info.get("extmetadata") or {}
    license_short = (meta.get("LicenseShortName") or {}).get("value", "")
    norm_license = _normalize_license(license_short)
    if not norm_license:
        log.debug("wikimedia: '%s' licença não reconhecida (%r) — skip",
                 page.get("title", ""), license_short)
        return None

    author_raw = (meta.get("Artist") or {}).get("value", "")
    author = re.sub(r"<[^>]+>", "", author_raw).strip()
    attribution_required = norm_license in ("cc-by", "cc-by-sa")
    page_id = str(page.get("pageid", ""))
    descriptionurl = info.get("descriptionurl") or (
        f"https://commons.wikimedia.org/wiki/{page.get('title', '')}")

    return CandidateMetadata(
        provider="wikimedia",
        provider_id=page_id,
        source_url=descriptionurl,
        download_url=info.get("url", ""),
        media_kind=media_kind,
        width=int(info.get("width", 0) or 0),
        height=int(info.get("height", 0) or 0),
        duration=float(info.get("duration", 0.0) or 0.0),
        license={
            "source": "wikimedia",
            "source_url": descriptionurl,
            "license": norm_license,
            "author": author,
            "attribution_required": attribution_required,
            "attribution_text": f"{author}, {license_short}".strip(", "),
            "verified_by": "api",
            "media_kind": media_kind,
        },
    )


def _query(params: dict) -> dict:
    with httpx.Client(timeout=_TIMEOUT_S,
                      headers={"User-Agent": "studio-hubia/0 "
                              "(media acquisition; contact via repo)"}) as c:
        resp = c.get(API_URL, params=params)
        resp.raise_for_status()
        return resp.json()


def _search_generator(query_en: str, count: int, generator: str,
                      extra: dict) -> list[dict]:
    params = {
        "action": "query",
        "generator": generator,
        "prop": "imageinfo",
        "iiprop": _IIPROP,
        "format": "json",
        **extra,
    }
    try:
        data = _query(params)
    except Exception as exc:
        log.warning("wikimedia: query(%s) falhou para '%s': %s",
                    generator, query_en, exc.__class__.__name__)
        return []
    pages = (data.get("query") or {}).get("pages") or {}
    # `pages` é dict pageid->page; ordem de "index" (ranking) se presente.
    ordered = sorted(pages.values(), key=lambda p: p.get("index", 0))
    return ordered[:count]


def search(query_en: str, count: int, settings: Settings) -> list[CandidateMetadata]:
    """Fase 1 (só SEARCH): API oficial MediaWiki, zero bytes de media
    transferidos. `generator=search` (namespace File=6) + `Category:` best-
    effort (item 9 — category-aware, capado a `count`, nunca a categoria
    inteira)."""
    t0 = time.perf_counter()
    pages = _search_generator(
        query_en, count, "search",
        {"gsrsearch": query_en, "gsrnamespace": 6, "gsrlimit": count})

    seen_ids: set[str] = set()
    out: list[CandidateMetadata] = []
    for page in pages:
        cand = _page_to_candidate(page)
        if cand is None or cand.provider_id in seen_ids:
            continue
        seen_ids.add(cand.provider_id)
        out.append(cand)

    if len(out) < count:
        cat_pages = _search_generator(
            query_en, count - len(out), "categorymembers",
            {"gcmtitle": f"Category:{query_en}", "gcmnamespace": 6,
             "gcmlimit": count - len(out)})
        for page in cat_pages:
            cand = _page_to_candidate(page)
            if cand is None or cand.provider_id in seen_ids:
                continue
            seen_ids.add(cand.provider_id)
            out.append(cand)

    search_elapsed = time.perf_counter() - t0
    log.info("wikimedia-search '%s': %d candidatos (search=%.1fs) — "
             "0 bytes de media transferidos", query_en, len(out), search_elapsed)
    return out


def _sleep_backoff(attempt: int) -> None:
    time.sleep({0: 1, 1: 4, 2: 10}.get(attempt, 10))


def download(candidate: CandidateMetadata, settings: Settings, dest: Path) -> Path:
    """Fase 2 (só DOWNLOAD): 1 candidato já filtrado por dedup (pre-
    download). Extensão preservada do download_url (jpg/png/webm/ogg)."""
    dest.mkdir(parents=True, exist_ok=True)
    # BUG REAL (microvalidação real 2026-08-14): download_url do Commons
    # vem SEMPRE com querystring de tracking
    # ("...jpg?utm_source=commons.wikimedia.org&utm_campaign=..."inconn) —
    # Path(url).suffix sem urlparse pegava o resto da querystring como
    # "extensão" (ficheiro final literalmente
    # "wikimedia_121506761.org&utm_campaign=..."). urlparse().path isola
    # só o path real antes do "?".
    from urllib.parse import urlparse
    url_path = urlparse(candidate.download_url).path
    suffix = Path(url_path).suffix or (
        ".jpg" if candidate.media_kind == "image" else ".mp4")
    target = dest / f"wikimedia_{candidate.provider_id}{suffix}"
    if target.exists() and target.stat().st_size > 0:
        return target
    tmp = target.with_suffix(target.suffix + ".tmp")
    last_exc: Exception | None = None
    with httpx.Client(timeout=_DOWNLOAD_TIMEOUT_S, follow_redirects=True,
                      headers={"User-Agent": "studio-hubia/0"}) as c:
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
    raise last_exc if last_exc else RuntimeError("wikimedia: retries esgotados")
