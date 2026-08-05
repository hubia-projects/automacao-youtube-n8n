"""Fonte YouTube CC — SÓ vídeos Creative Commons de canais na allowlist.

Política (LIBRARY_POLICY §2/§3): dupla verificação obrigatória —
(1) licença CC-BY confirmada nos metadados do vídeo, E
(2) canal vetado manualmente em data/library/ytdlp_allowlist.yaml.
Sem exceções no código. Download de YouTube não-CC viola ToS/direitos.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

log = logging.getLogger("studio.sources.ytdlp_cc")


class NotAllowed(RuntimeError):
    pass


def _load_allowlist(library_root: Path) -> set[str]:
    """Formato: uma channel_id por linha (linhas # são comentários)."""
    path = library_root / "ytdlp_allowlist.yaml"
    if not path.exists():
        return set()
    entries = set()
    for line in path.read_text("utf-8").splitlines():
        line = line.strip().lstrip("-").strip()
        if line and not line.startswith("#"):
            entries.add(line)
    return entries


def download_cc(url: str, library_root: Path, dest: Path) -> tuple[Path, dict]:
    """Descarrega UM vídeo se e só se CC-BY + canal na allowlist."""
    probe = subprocess.run(
        ["yt-dlp", "--dump-json", "--no-download", url],
        capture_output=True, text=True,
    )
    if probe.returncode != 0:
        raise RuntimeError(f"yt-dlp falhou: {probe.stderr.strip()[:300]}")
    info = json.loads(probe.stdout)

    license_str = (info.get("license") or "").lower()
    if "creative commons" not in license_str:
        raise NotAllowed(f"licença não-CC ({info.get('license')!r}) — download proibido")

    channel_id = info.get("channel_id", "")
    if channel_id not in _load_allowlist(library_root):
        raise NotAllowed(
            f"canal {channel_id!r} fora da allowlist — vetar manualmente em "
            f"{library_root / 'ytdlp_allowlist.yaml'} antes de ingerir"
        )

    dest.mkdir(parents=True, exist_ok=True)
    target = dest / f"ytcc_{info['id']}.mp4"
    dl = subprocess.run(
        ["yt-dlp", "-f", "bv*[height<=1080]+ba/b[height<=1080]",
         "--merge-output-format", "mp4", "-o", str(target), url],
        capture_output=True, text=True,
    )
    if dl.returncode != 0:
        raise RuntimeError(f"yt-dlp download falhou: {dl.stderr.strip()[:300]}")

    license_rec = {
        "source": "youtube_cc",
        "source_url": info.get("webpage_url", url),
        "license": "cc-by",
        "author": info.get("channel", ""),
        "attribution_text": f"Video by {info.get('channel','')} via YouTube, CC-BY — {info.get('webpage_url', url)}",
        "verified_by": "manual",
    }
    return target, license_rec
