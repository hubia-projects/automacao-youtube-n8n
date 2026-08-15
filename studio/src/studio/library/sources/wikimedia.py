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
from studio.library.provider_errors import ProviderRateLimitedError
from studio.library.text_match import rank_by_hints

log = logging.getLogger("studio.sources.wikimedia")

API_URL = "https://commons.wikimedia.org/w/api.php"
_TIMEOUT_S = 30
_DOWNLOAD_TIMEOUT_S = 120
_DOWNLOAD_RETRIES = 3
_IIPROP = "url|mime|size|extmetadata|duration"

# item PORTO FINAL ASSET TEST (secções 7-10): Wikimedia começou a devolver
# 429 sustentado numa run real (~2h, ~100% dos downloads) — o pipeline
# ficou preso a repetir o MESMO provider em vez de avançar para
# Pexels/Pixabay. Estado de cooldown por PROCESSO (nunca persistido —
# reinicia a cada resume, nunca "esgotado para sempre"): depois de
# `_RATE_LIMIT_THRESHOLD` 429 consecutivos (download OU search), marca
# rate-limited por `_RATE_LIMIT_COOLDOWN_S` e levanta
# `ProviderRateLimitedError` em vez de continuar a tentar — o caller
# (`acquisition.py`) apanha isto e avança a waterfall imediatamente.
_RATE_LIMIT_COOLDOWN_S = 300.0
_RATE_LIMIT_MAX_RETRY_AFTER_S = 60.0
_rate_limited_until = 0.0


def _check_not_rate_limited() -> None:
    if time.time() < _rate_limited_until:
        raise ProviderRateLimitedError(
            "wikimedia",
            f"wikimedia: em cooldown até {_rate_limited_until:.0f} "
            "(rate-limit sustentado detectado anteriormente)")


def _enter_rate_limited_cooldown() -> None:
    global _rate_limited_until
    _rate_limited_until = time.time() + _RATE_LIMIT_COOLDOWN_S
    log.warning("wikimedia: rate-limit sustentado detectado — cooldown de "
               "%.0fs (provider marcado temporariamente indisponível)",
               _RATE_LIMIT_COOLDOWN_S)


def _retry_after_seconds(response: httpx.Response) -> float | None:
    raw = response.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return min(float(raw), _RATE_LIMIT_MAX_RETRY_AFTER_S)
    except ValueError:
        return None


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
    # item PORTO (search+confirmation calibration): título da página +
    # categorias Commons (extmetadata.Categories, antes ignorado) — usados
    # só para ranking local por `canonical_hints` em `search()`, nunca
    # persistidos como license/proveniência (esses campos continuam os
    # mesmos de sempre).
    title: str = ""
    categories: tuple[str, ...] = ()


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
    title = page.get("title", "")
    descriptionurl = info.get("descriptionurl") or (
        f"https://commons.wikimedia.org/wiki/{title}")
    # extmetadata.Categories vem como string "Cat1|Cat2|Cat3" (raw HTML
    # às vezes) — nunca visto até agora (item 10-11), usado só p/ ranking.
    categories_raw = (meta.get("Categories") or {}).get("value", "")
    categories = tuple(
        re.sub(r"<[^>]+>", "", c).strip()
        for c in categories_raw.split("|") if c.strip()
    )

    return CandidateMetadata(
        provider="wikimedia",
        provider_id=page_id,
        source_url=descriptionurl,
        download_url=info.get("url", ""),
        media_kind=media_kind,
        width=int(info.get("width", 0) or 0),
        height=int(info.get("height", 0) or 0),
        duration=float(info.get("duration", 0.0) or 0.0),
        title=title,
        categories=categories,
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


_SEARCH_RETRIES = 2


def _query(params: dict) -> dict:
    """item PORTO FINAL ASSET TEST (secções 7-10): 429 na busca (metadata,
    não download) também entra em cooldown de provider — antes disto,
    `_search_generator` engolia QUALQUER excepção (incluindo 429) como "0
    resultados", que o caller regista como QueryHistory status="empty"
    (bug relacionado: 429 nunca deve virar "empty" permanente, ver secção
    9)."""
    _check_not_rate_limited()
    last_status: int | None = None
    with httpx.Client(timeout=_TIMEOUT_S,
                      headers={"User-Agent": "studio-hubia/0 "
                              "(media acquisition; contact via repo)"}) as c:
        for attempt in range(_SEARCH_RETRIES):
            resp = c.get(API_URL, params=params)
            if resp.status_code == 429:
                last_status = 429
                _sleep_backoff(attempt, _retry_after_seconds(resp))
                continue
            resp.raise_for_status()
            return resp.json()
    _enter_rate_limited_cooldown()
    raise ProviderRateLimitedError(
        "wikimedia", f"wikimedia search: {_SEARCH_RETRIES} tentativas, "
        "todas 429 — rate-limit sustentado")


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
    except ProviderRateLimitedError:
        raise
    except Exception as exc:
        log.warning("wikimedia: query(%s) falhou para '%s': %s",
                    generator, query_en, exc.__class__.__name__)
        return []
    pages = (data.get("query") or {}).get("pages") or {}
    # `pages` é dict pageid->page; ordem de "index" (ranking) se presente.
    ordered = sorted(pages.values(), key=lambda p: p.get("index", 0))
    return ordered[:count]


def _rank_by_hints(pool: list[CandidateMetadata],
                   hints: tuple[str, ...]) -> list[CandidateMetadata]:
    """Ordena `pool` por `rank_score_for_hints` (frase completa PRIMEIRO,
    token-overlap só como desempate — ver text_match.py, secção 16-17 do
    PORTO FINAL RETRIEVAL FIX: ranking por só-palavras-distintivas era um
    no-op para "Sé do Porto"/"Porto Cathedral", cujas palavras são todas
    genéricas). Categorias pesam por entrar na mesma string concatenada
    com o título — curadoria humana, mais fiável que texto livre."""
    def _text(cand: CandidateMetadata) -> str:
        return f"{cand.title} {' '.join(cand.categories)}"

    return rank_by_hints(pool, hints, _text)


def search(query_en: str, count: int, settings: Settings,
          *, canonical_hints: tuple[str, ...] = ()) -> list[CandidateMetadata]:
    """Fase 1 (só SEARCH): API oficial MediaWiki, zero bytes de media
    transferidos.

    Sem `canonical_hints`: comportamento legacy (`generator=search` +
    `Category:{query_en}` fallback, capado a `count`).

    Com `canonical_hints` (item PORTO — entity-aware): (1) probe de
    categoria EXACTA por hint (`Category:{hint}`, entidade pode ter
    categoria própria na Commons); (2) pool mais largo
    (`settings.wikimedia_search_pool`) via busca textual + fallback de
    categoria da query traduzida; (3) ranking local por match de
    `canonical_hints` no título/categorias; (4) devolve só os `count`
    melhores — `make_provider_resolver` continua a descarregar tudo o que
    `search()` devolver, contrato intacto."""
    _check_not_rate_limited()
    t0 = time.perf_counter()
    hints = tuple(h.strip() for h in canonical_hints if h and h.strip())
    pool_limit = max(count, int(getattr(settings, "wikimedia_search_pool", 40)
                                or 40)) if hints else count

    seen_ids: set[str] = set()
    pool: list[CandidateMetadata] = []

    def _add(pages: list[dict]) -> None:
        for page in pages:
            cand = _page_to_candidate(page)
            if cand is None or cand.provider_id in seen_ids:
                continue
            seen_ids.add(cand.provider_id)
            pool.append(cand)

    for hint in hints:
        if len(pool) >= pool_limit:
            break
        _add(_search_generator(
            hint, pool_limit - len(pool), "categorymembers",
            {"gcmtitle": f"Category:{hint}", "gcmnamespace": 6,
             "gcmlimit": pool_limit - len(pool)}))

    if len(pool) < pool_limit:
        _add(_search_generator(
            query_en, pool_limit - len(pool), "search",
            {"gsrsearch": query_en, "gsrnamespace": 6,
             "gsrlimit": pool_limit - len(pool)}))

    if len(pool) < pool_limit:
        _add(_search_generator(
            query_en, pool_limit - len(pool), "categorymembers",
            {"gcmtitle": f"Category:{query_en}", "gcmnamespace": 6,
             "gcmlimit": pool_limit - len(pool)}))

    ranked = _rank_by_hints(pool, hints) if hints else pool
    out = ranked[:count]

    search_elapsed = time.perf_counter() - t0
    log.info("wikimedia-search '%s' (hints=%s): pool=%d -> top=%d candidatos "
             "(search=%.1fs) — 0 bytes de media transferidos",
             query_en, hints, len(pool), len(out), search_elapsed)
    return out


def _sleep_backoff(attempt: int, retry_after: float | None = None) -> None:
    if retry_after is not None:
        time.sleep(max(0.0, retry_after))
        return
    time.sleep({0: 1, 1: 4, 2: 10}.get(attempt, 10))


def download(candidate: CandidateMetadata, settings: Settings, dest: Path) -> Path:
    """Fase 2 (só DOWNLOAD): 1 candidato já filtrado por dedup (pre-
    download). Extensão preservada do download_url (jpg/png/webm/ogg).

    item PORTO FINAL ASSET TEST (secções 7-10): 429 respeita `Retry-After`
    quando presente (capado, nunca espera indefinidamente); poucas
    tentativas (`_DOWNLOAD_RETRIES`, bounded); se o ÚLTIMO erro continuar a
    ser 429 especificamente, entra em cooldown de provider e levanta
    `ProviderRateLimitedError` — o caller avança a waterfall em vez de
    repetir o mesmo provider indefinidamente."""
    _check_not_rate_limited()
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
    last_status: int | None = None
    with httpx.Client(timeout=_DOWNLOAD_TIMEOUT_S, follow_redirects=True,
                      headers={"User-Agent": "studio-hubia/0"}) as c:
        for attempt in range(_DOWNLOAD_RETRIES):
            try:
                with c.stream("GET", candidate.download_url) as r:
                    if r.status_code in (429, 500, 502, 503, 504):
                        tmp.unlink(missing_ok=True)
                        last_status = r.status_code
                        last_exc = httpx.HTTPStatusError(
                            f"{r.status_code}", request=r.request, response=r)
                        _sleep_backoff(attempt, _retry_after_seconds(r)
                                      if r.status_code == 429 else None)
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
                last_status = None
                tmp.unlink(missing_ok=True)
                _sleep_backoff(attempt)
            except Exception:
                tmp.unlink(missing_ok=True)
                raise
    if last_status == 429:
        _enter_rate_limited_cooldown()
        raise ProviderRateLimitedError(
            "wikimedia",
            f"wikimedia: {_DOWNLOAD_RETRIES} tentativas, todas 429 — "
            "rate-limit sustentado")
    raise last_exc if last_exc else RuntimeError("wikimedia: retries esgotados")
