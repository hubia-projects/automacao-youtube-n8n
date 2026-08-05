"""Upload YouTube — port do fluxo OAuth comprovado do legacy (mesmas
credenciais YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN do .env). httpx direto,
sem SDK googleapis."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx

from studio.config import Settings

log = logging.getLogger("studio.youtube")

TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
CAPTIONS_URL = "https://www.googleapis.com/upload/youtube/v3/captions"
THUMB_URL = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set"


def _access_token(settings: Settings) -> str:
    resp = httpx.post(TOKEN_URL, data={
        "client_id": settings.youtube_client_id,
        "client_secret": settings.youtube_client_secret,
        "refresh_token": settings.youtube_refresh_token,
        "grant_type": "refresh_token",
    }, timeout=30)
    resp.raise_for_status()
    return resp.json()["access_token"]


def upload_video(video_path: Path, metadata: dict, settings: Settings, *,
                 srt_path: Path | None = None,
                 thumbnail_path: Path | None = None) -> dict:
    """Upload privado + legendas + thumbnail. Devolve o recibo."""
    if settings.mock_mode:
        return {"mocked": True, "video_id": "mock-video-id"}

    token = _access_token(settings)
    headers = {"Authorization": f"Bearer {token}"}

    body = {
        "snippet": {
            "title": metadata["title"][:100],
            "description": metadata["description"][:4900],
            "tags": metadata.get("tags", [])[:30],
            "categoryId": "19",  # Travel & Events
            "defaultAudioLanguage": "pt-BR",
        },
        "status": {"privacyStatus": settings.youtube_default_privacy,
                   "selfDeclaredMadeForKids": False},
    }
    files = {
        "metadata": (None, json.dumps(body), "application/json; charset=UTF-8"),
        "file": (video_path.name, video_path.read_bytes(), "video/mp4"),
    }
    resp = httpx.post(UPLOAD_URL, params={"part": "snippet,status",
                                          "uploadType": "multipart"},
                      headers=headers, files=files, timeout=600)
    resp.raise_for_status()
    video_id = resp.json()["id"]
    log.info("upload OK: https://youtu.be/%s (%s)", video_id,
             settings.youtube_default_privacy)

    receipt = {"video_id": video_id, "privacy": settings.youtube_default_privacy}
    if srt_path and srt_path.exists():
        cap_meta = {"snippet": {"videoId": video_id, "language": "pt-BR",
                                "name": "Português (Brasil)"}}
        cap = httpx.post(CAPTIONS_URL, params={"part": "snippet",
                                               "uploadType": "multipart"},
                         headers=headers,
                         files={"metadata": (None, json.dumps(cap_meta),
                                             "application/json; charset=UTF-8"),
                                "file": (srt_path.name, srt_path.read_bytes(),
                                         "application/octet-stream")},
                         timeout=120)
        receipt["captions"] = cap.status_code == 200
        if cap.status_code != 200:
            log.warning("captions falharam: %s", cap.text[:200])
    if thumbnail_path and thumbnail_path.exists():
        th = httpx.post(THUMB_URL, params={"videoId": video_id},
                        headers={**headers, "Content-Type": "image/png"},
                        content=thumbnail_path.read_bytes(), timeout=120)
        receipt["thumbnail"] = th.status_code == 200
        if th.status_code != 200:
            log.warning("thumbnail falhou: %s", th.text[:200])
    return receipt
