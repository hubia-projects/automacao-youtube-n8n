"""Watch folder — footage próprio/comprado largado em data/library/inbox/.

Cada media exige sidecar `<nome>.license.json` (LIBRARY_POLICY §2).
Sem sidecar → rejeitado (fail-closed), fica no inbox para correção.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

log = logging.getLogger("studio.sources.watchfolder")

MEDIA_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}


def scan(inbox: Path) -> list[tuple[Path, dict | None]]:
    """Devolve [(media, licença|None)] — None = sidecar em falta/ilegível."""
    if not inbox.exists():
        return []
    out: list[tuple[Path, dict | None]] = []
    for media in sorted(inbox.iterdir()):
        if media.suffix.lower() not in MEDIA_EXTS:
            continue
        sidecar = media.with_suffix(media.suffix + ".license.json")
        if not sidecar.exists():
            log.warning("sem sidecar de licença: %s (esperado %s)", media.name, sidecar.name)
            out.append((media, None))
            continue
        try:
            out.append((media, json.loads(sidecar.read_text("utf-8"))))
        except json.JSONDecodeError as exc:
            log.warning("sidecar ilegível %s: %s", sidecar.name, exc)
            out.append((media, None))
    return out
