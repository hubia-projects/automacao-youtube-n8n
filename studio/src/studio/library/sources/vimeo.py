"""Fonte Vimeo — vídeos Creative Commons via API oficial.

Token de app (client credentials) chega para PESQUISA pública com filtro de
licença. Download de ficheiros de terceiros só quando o autor expõe
`download` público (contas free não têm acesso garantido — best-effort;
sem link de download o vídeo é saltado, nunca scraped).
"""

from __future__ import annotations

import base64
import logging
from pathlib import Path

import httpx

from studio.config import Settings

log = logging.getLogger("studio.sources.vimeo")

_OK = {"CC0": "cc0", "CC-BY": "cc-by"}  # SA rejeitado (policy)
_token_cache: dict[str, str] = {}


def _token(settings: Settings) -> str:
    if "t" not in _token_cache:
        basic = base64.b64encode(
            f"{settings.vimeo_client_id}:{settings.vimeo_client_secret}".encode()
        ).decode()
        resp = httpx.post("https://api.vimeo.com/oauth/authorize/client",
                          headers={"Authorization": f"Basic {basic}"},
                          json={"grant_type": "client_credentials",
                                "scope": "public"}, timeout=30)
        resp.raise_for_status()
        _token_cache["t"] = resp.json()["access_token"]
    return _token_cache["t"]


def sweep(query_en: str, count: int, settings: Settings, dest: Path) -> list[tuple[Path, dict]]:
    if not settings.vimeo_client_id:
        raise RuntimeError("VIMEO_CLIENT_ID em falta")
    dest.mkdir(parents=True, exist_ok=True)
    headers = {"Authorization": f"Bearer {_token(settings)}"}
    out: list[tuple[Path, dict]] = []
    for lic_api, lic in _OK.items():
        if len(out) >= count:
            break
        resp = httpx.get("https://api.vimeo.com/videos",
                         headers=headers,
                         params={"query": query_en, "filter": lic_api,
                                 "per_page": count * 2, "sort": "relevant",
                                 "fields": "uri,name,link,license,download,user.name"},
                         timeout=30)
        if resp.status_code != 200:
            log.warning("vimeo pesquisa falhou (%s): %s", lic_api, resp.text[:150])
            continue
        for v in resp.json().get("data", []):
            if len(out) >= count:
                break
            downloads = v.get("download") or []
            files = [d for d in downloads
                     if d.get("height") and d["height"] <= 1080 and d.get("link")]
            if not files:
                continue  # autor não expõe download público → salta (legal)
            best = max(files, key=lambda d: d["height"])
            vid = v["uri"].rsplit("/", 1)[-1]
            target = dest / f"vimeo_{vid}.mp4"
            if not target.exists():
                with httpx.stream("GET", best["link"], timeout=300,
                                  follow_redirects=True) as r:
                    if r.status_code != 200:
                        continue
                    with target.open("wb") as fh:
                        for chunk in r.iter_bytes(1 << 20):
                            fh.write(chunk)
            author = (v.get("user") or {}).get("name", "")
            out.append((target, {
                "source": "wikimedia",  # taxonomia CC genérica da policy
                "source_url": v.get("link", ""),
                "license": lic, "author": author,
                "attribution_text": (f"\"{v.get('name','')}\" by {author} via "
                                     f"Vimeo, {lic.upper()}") if lic == "cc-by" else "",
                "verified_by": "api",
            }))
            log.info("vimeo: %s (%s) — %s", target.name, lic, query_en)
    return out
