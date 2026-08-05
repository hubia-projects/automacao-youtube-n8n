"""Ingestão — o único caminho para dentro da biblioteca (ARCHITECTURE.md §6).

Fail-closed: sem licença válida → rejeitado. Duplicado (SHA-256) → no-op.
Tudo registado em ingest_log.jsonl.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.library.embed import Embedder, mean_pool
from studio.library.licenses import LicenseError, LicenseRecord, validate_license
from studio.library.metadata import analyze_shot
from studio.library.shots import detect_shots, extract_keyframes

log = logging.getLogger("studio.ingest")


@dataclass
class IngestResult:
    status: str  # "ingested" | "skipped_duplicate" | "rejected"
    media_sha: str = ""
    shots_added: int = 0
    cost_usd: float = 0.0
    reason: str = ""


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _log_entry(settings: Settings, entry: dict) -> None:
    settings.library_root.mkdir(parents=True, exist_ok=True)
    entry["at"] = datetime.now(timezone.utc).isoformat()
    with (settings.library_root / "ingest_log.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def ingest_file(
    path: Path,
    license_raw: dict | LicenseRecord,
    db: LibraryDB,
    settings: Settings,
    embedder: Embedder,
) -> IngestResult:
    # 1. Licença (fail-closed — LIBRARY_POLICY.md)
    try:
        lic = validate_license(license_raw)
    except LicenseError as exc:
        _log_entry(settings, {"file": str(path), "status": "rejected", "reason": str(exc)})
        log.warning("rejeitado (licença): %s — %s", path.name, exc)
        return IngestResult(status="rejected", reason=str(exc))

    # 2. Dedup por conteúdo
    sha = _sha256(path)
    if db.media_exists(sha):
        _log_entry(settings, {"file": str(path), "status": "skipped_duplicate", "sha": sha})
        return IngestResult(status="skipped_duplicate", media_sha=sha)

    # 3. Media content-addressed
    media_dir = settings.library_root / "media"
    media_dir.mkdir(parents=True, exist_ok=True)
    media_path = media_dir / f"{sha}{path.suffix.lower()}"
    if not media_path.exists():
        shutil.copy2(path, media_path)

    # 4. Shots → keyframes → embedding + metadados
    shots = detect_shots(media_path)
    rows, total_cost = [], 0.0
    now = datetime.now(timezone.utc).isoformat()
    for idx, (t_in, t_out) in enumerate(shots):
        shot_id = f"{sha[:12]}_{idx:03d}"
        kf_dir = settings.library_root / "shots" / sha / shot_id
        keyframes = extract_keyframes(media_path, t_in, t_out, kf_dir)
        vec = mean_pool(embedder.embed_images(keyframes))
        try:
            meta, cost = analyze_shot(keyframes, settings, source_hint=path.name)
        except Exception as exc:
            # shot mau não pode matar o ficheiro inteiro — salta e regista
            log.warning("shot %s saltado (análise falhou): %s", shot_id, exc)
            _log_entry(settings, {"file": str(path), "status": "shot_skipped",
                                  "shot_id": shot_id, "reason": str(exc)[:200]})
            continue
        total_cost += cost
        rows.append({
            "shot_id": shot_id, "media_sha": sha,
            "t_in": t_in, "t_out": t_out, "vec": vec.tolist(),
            "summary": meta.summary,
            "places_csv": ",".join(meta.places),
            "landmarks_csv": ",".join(meta.landmarks),
            "food_csv": ",".join(meta.food_items),
            "objects_csv": ",".join(meta.objects),
            "shot_type": meta.shot_type, "camera_motion": meta.camera_motion,
            "time_of_day": meta.time_of_day, "indoor_outdoor": meta.indoor_outdoor,
            "people_present": meta.people_present, "quality": meta.quality,
            "has_food": meta.has_food, "has_landmark": meta.has_landmark,
            "restricted": lic.share_alike, "revoked": False,
            "license_source": lic.source, "license": lic.license,
            "attribution_required": lic.attribution_required,
            "attribution_text": lic.attribution_text,
            "source_url": lic.source_url, "author": lic.author,
            "usage_count": 0, "last_used_run": "",
            "ingested_at": now,
            "keyframes_csv": ",".join(str(k) for k in keyframes),
            "media_path": str(media_path),
            "meta_json": meta.model_dump_json(),
        })

    db.add_shots(rows)
    _log_entry(settings, {"file": str(path), "status": "ingested", "sha": sha,
                          "shots": len(rows), "cost_usd": round(total_cost, 4),
                          "license": lic.license, "source": lic.source})
    log.info("ingerido %s: %d shots (%s)", path.name, len(rows), lic.source)
    return IngestResult(status="ingested", media_sha=sha,
                        shots_added=len(rows), cost_usd=total_cost)
