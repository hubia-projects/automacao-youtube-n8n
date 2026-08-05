"""Fonte Pixabay — pesquisa e download de vídeos com licença autopreenchida."""

from __future__ import annotations

import logging
from pathlib import Path

import httpx

from studio.config import Settings

log = logging.getLogger("studio.sources.pixabay")

SEARCH_URL = "https://pixabay.com/api/videos/"


def sweep(query_en: str, count: int, settings: Settings, dest: Path) -> list[tuple[Path, dict]]:
    if not settings.pixabay_api_key:
        raise RuntimeError("PIXABAY_API_KEY em falta")
    dest.mkdir(parents=True, exist_ok=True)

    resp = httpx.get(
        SEARCH_URL,
        params={"key": settings.pixabay_api_key, "q": query_en,
                "per_page": min(max(count, 3), 200), "safesearch": "true"},
        timeout=30,
    )
    resp.raise_for_status()
    hits = resp.json().get("hits", [])

    out: list[tuple[Path, dict]] = []
    for hit in hits[:count]:
        videos = hit.get("videos", {})
        variant = videos.get("large") or videos.get("medium") or videos.get("small")
        if not variant or not variant.get("url"):
            continue
        target = dest / f"pixabay_{hit['id']}.mp4"
        if not target.exists():
            with httpx.stream("GET", variant["url"], timeout=120, follow_redirects=True) as r:
                r.raise_for_status()
                with target.open("wb") as fh:
                    for chunk in r.iter_bytes(1 << 20):
                        fh.write(chunk)
        license_rec = {
            "source": "pixabay",
            "source_url": hit.get("pageURL", ""),
            "license": "pixabay",
            "author": hit.get("user", ""),
            "verified_by": "api",
        }
        out.append((target, license_rec))
        log.info("pixabay: %s — %s", target.name, query_en)
    return out
