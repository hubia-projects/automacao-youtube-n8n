"""Fonte Pexels — pesquisa e download de vídeos com licença autopreenchida."""

from __future__ import annotations

import logging
from pathlib import Path

import httpx

from studio.config import Settings

log = logging.getLogger("studio.sources.pexels")

SEARCH_URL = "https://api.pexels.com/videos/search"
MAX_HEIGHT = 1080  # não descarregar 4K na ingestão — proxy chega para indexar


def sweep(query_en: str, count: int, settings: Settings, dest: Path) -> list[tuple[Path, dict]]:
    """Pesquisa + download. Devolve [(ficheiro, licença)]."""
    if not settings.pexels_api_key:
        raise RuntimeError("PEXELS_API_KEY em falta")
    dest.mkdir(parents=True, exist_ok=True)

    resp = httpx.get(
        SEARCH_URL,
        headers={"Authorization": settings.pexels_api_key},
        params={"query": query_en, "per_page": min(count, 80), "orientation": "landscape"},
        timeout=30,
    )
    resp.raise_for_status()
    videos = resp.json().get("videos", [])

    out: list[tuple[Path, dict]] = []
    for video in videos[:count]:
        files = [f for f in video.get("video_files", [])
                 if f.get("height") and f["height"] <= MAX_HEIGHT]
        if not files:
            continue
        best = max(files, key=lambda f: f["height"])
        target = dest / f"pexels_{video['id']}.mp4"
        if not target.exists():
            with httpx.stream("GET", best["link"], timeout=120, follow_redirects=True) as r:
                r.raise_for_status()
                with target.open("wb") as fh:
                    for chunk in r.iter_bytes(1 << 20):
                        fh.write(chunk)
        license_rec = {
            "source": "pexels",
            "source_url": video.get("url", ""),
            "license": "pexels",
            "author": (video.get("user") or {}).get("name", ""),
            "verified_by": "api",
        }
        out.append((target, license_rec))
        log.info("pexels: %s (%dp) — %s", target.name, best["height"], query_en)
    return out
