"""Fonte Wikimedia Commons — vídeos CC/PD com licença verificada por API.

Sem chave. Só aceita ficheiros cuja licença legível por máquina esteja na
allow-list (cc0, cc-by, pd). CC-BY-SA é recusado (restricted na policy).
"""

from __future__ import annotations

import logging
from pathlib import Path

import httpx

from studio.config import Settings

log = logging.getLogger("studio.sources.wikimedia")

API = "https://commons.wikimedia.org/w/api.php"
_OK_LICENSES = {"cc0": "cc0", "cc-by": "cc-by", "pd": "pd", "public domain": "pd"}


def _license_of(info: dict) -> tuple[str, str, bool] | None:
    """(license, author, attribution_required) ou None se não aceitável."""
    meta = info.get("extmetadata", {})
    short = (meta.get("LicenseShortName", {}).get("value") or "").lower()
    author = (meta.get("Artist", {}).get("value") or "")[:120]
    for key, lic in _OK_LICENSES.items():
        if key in short and "sa" not in short:
            return lic, author, lic == "cc-by"
    return None


def sweep(query_en: str, count: int, settings: Settings, dest: Path) -> list[tuple[Path, dict]]:
    dest.mkdir(parents=True, exist_ok=True)
    resp = httpx.get(API, params={
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": f"filetype:video {query_en}", "gsrnamespace": 6,
        "gsrlimit": count * 3, "prop": "imageinfo",
        "iiprop": "url|extmetadata|size", "iiurlwidth": 1280,
    }, timeout=30, headers={"User-Agent": "studio-v2/1.0 (ingest bot)"})
    resp.raise_for_status()
    pages = (resp.json().get("query") or {}).get("pages", {})

    out: list[tuple[Path, dict]] = []
    for page in pages.values():
        if len(out) >= count:
            break
        infos = page.get("imageinfo") or []
        if not infos:
            continue
        info = infos[0]
        lic_check = _license_of(info)
        if not lic_check:
            continue  # licença não aceitável → fail-closed
        lic, author, attrib = lic_check
        url = info.get("url", "")
        if not url.lower().endswith((".webm", ".ogv", ".mp4")):
            continue
        target = dest / f"wikimedia_{page['pageid']}{Path(url).suffix.lower()}"
        if not target.exists():
            with httpx.stream("GET", url, timeout=180, follow_redirects=True,
                              headers={"User-Agent": "studio-v2/1.0"}) as r:
                if r.status_code != 200:
                    continue
                with target.open("wb") as fh:
                    for chunk in r.iter_bytes(1 << 20):
                        fh.write(chunk)
        title = page.get("title", "")
        license_rec = {
            "source": "wikimedia",
            "source_url": f"https://commons.wikimedia.org/wiki/{title.replace(' ', '_')}",
            "license": lic, "author": author,
            "attribution_text": (f"{title} by {author} via Wikimedia Commons, "
                                 f"{lic.upper()}") if attrib else "",
            "verified_by": "api",
        }
        out.append((target, license_rec))
        log.info("wikimedia: %s (%s) — %s", target.name, lic, query_en)
    return out
