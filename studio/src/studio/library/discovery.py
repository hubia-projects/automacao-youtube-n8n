"""DISCOVERY_LITE — prefilter barato da biblioteca SEM SceneDetect/Gemini.

SUBSTITUI O MODELO "full ingest 900 mp4" por:
  1. Para cada mp4 ainda NÃO em discovery_index:
       - dedup checks (provider_cache + asset_state)
       - ffprobe (duration, w, h, codec)
       - 1 mid-frame extract (ffmpeg seek)
       - SigLIP image embed (batch 16-32) com auto-tune
       - upsert em discovery_index (LanceDB table)
  2. match contra requirement_embeddings do WorksetContext
       - cosine(preview_vec, req_embed) → top-K
       - ranking por expected_coverage_gain
  3. promotion list → micro-batch (4-8 promoted assets)
       - full ingest via ingest_asset
       - Gate STOP se coverage_ready

Performance:
    - ~5-15s por asset (probe + 1 frame + 1 SigLIP call)
    - 908 assets sequencial: ~75-150min; com batch SigLIP 32: ~30-60min
    - vs Full Ingest (8-24min/asset): enorme poupança

Schema discovery_index (LanceDB):
    media_path:      str  (abs path)
    source_id:       str  (e.g. "pexels_12345")
    media_sha:       str
    duration:        float
    width:           int
    height:          int
    codec:           str
    file_size:       int
    siglip_model_id: str
    discovery_version: int (bump se algoritmo muda)
    preview_json:    str  (lista serializada de floats — vector 768-dim)
    preview_dim:     int
    status:          str   (DISCOVERED_GLOBAL | INVALID | PENDING_LIBRARY_ENRICHMENT | FULLY_INGESTED)
    scanned_at:      str

NOTA:
    LanceDB espera colunas com tipos fixos. Para o vector 768-dim
    serializamos como JSON string em preview_json + preview_dim. Em query
    materializamos via numpy.asarray(json.loads(...)) no Python.
"""
from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("studio.discovery")

# Status
S_DISCOVERED_GLOBAL = "DISCOVERED_GLOBAL"
S_INVALID = "INVALID"
S_PENDING_ENRICHMENT = "PENDING_LIBRARY_ENRICHMENT"
S_FULLY_INGESTED = "FULLY_INGESTED"
ALL_STATUSES = {S_DISCOVERED_GLOBAL, S_INVALID, S_PENDING_ENRICHMENT, S_FULLY_INGESTED}

DISCOVERY_VERSION = 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class DiscoveryRecord:
    media_path: str
    source_id: str
    media_sha: str
    duration: float
    width: int
    height: int
    codec: str
    file_size: int
    siglip_model_id: str
    discovery_version: int
    preview_vec: list[float]        # 768-dim
    status: str
    scanned_at: str = ""

    def to_row(self) -> dict:
        return {
            "media_path": self.media_path,
            "source_id": self.source_id,
            "media_sha": self.media_sha,
            "duration": float(self.duration),
            "width": int(self.width),
            "height": int(self.height),
            "codec": self.codec,
            "file_size": int(self.file_size),
            "siglip_model_id": self.siglip_model_id,
            "discovery_version": int(self.discovery_version),
            "preview_json": json.dumps(self.preview_vec),
            "preview_dim": len(self.preview_vec),
            "status": self.status,
            "scanned_at": self.scanned_at or _now_iso(),
        }


# === Helpers de I/O (idem reconcile + library keyframes) =====================

_FRAMES_TMP_DIR = Path("/tmp/studio_discovery_frames")


def _ffprobe(path: Path) -> dict:
    """Extrai {duration, width, height, codec} de 1 mp4. Empty dict em erro."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration:stream=width,height,codec_name",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            return {}
        d = json.loads(r.stdout)
        out: dict = {}
        if d.get("format", {}).get("duration"):
            out["duration"] = float(d["format"]["duration"])
        for s in d.get("streams", []):
            if s.get("codec_type") == "video":
                out["width"] = int(s.get("width", 0))
                out["height"] = int(s.get("height", 0))
                out["codec"] = s.get("codec_name", "")
                break
        return out
    except (subprocess.SubprocessError, OSError,
            json.JSONDecodeError) as exc:
        log.debug("discovery: ffprobe falhou %s: %s", path.name, exc)
        return {}


def _extract_mid_frame(path: Path, duration: float) -> Optional[Path]:
    """1 frame JPG do meio do vídeo. Cache por mtime do mp4."""
    _FRAMES_TMP_DIR.mkdir(parents=True, exist_ok=True)
    out = _FRAMES_TMP_DIR / f"{path.stem}.jpg"
    try:
        if (out.exists()
                and out.stat().st_mtime > path.stat().st_mtime):
            return out
    except OSError:
        pass
    seek = max(0.0, duration / 2.0)
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", f"{seek:.2f}", "-i",
             str(path), "-vframes", "1", "-q:v", "2", str(out)],
            capture_output=True, timeout=15,
        )
        if r.returncode == 0 and out.exists():
            return out
        log.warning("discovery: frame extract falhou %s: %r",
                    path.name, r.stderr[:120] if r.stderr else b"")
        return None
    except (subprocess.SubprocessError, OSError) as exc:
        log.debug("discovery: frame extract erro %s: %s", path.name, exc)
        return None


def _file_sha_head(path: Path) -> str:
    """SHA-256 truncado do ficheiro (cabeçalho + tail) — barato p/ dedup."""
    import hashlib

    h = hashlib.sha256()
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            h.update(f.read(65536))
            if size > 131072:
                f.seek(max(0, size - 65536))
                h.update(f.read(65536))
        h.update(str(size).encode("utf-8"))
    except OSError:
        return ""
    return h.hexdigest()


# === Classifier ==============================================================

def coverage_gain(
    sim: float,
    target_seconds: float,
    available_seconds: float,
    deficit: float,
    quality: int = 6,
) -> float:
    """Expected coverage gain para ranking.

    Heurística:
        deficit_priority     ∈ [0,1] (1 se deficit zero, 0 se cobertura cheia)
        relevance_score      = max(0, sim)
        estimated_useful_s   = min(8.0 (typical shot dur), target/3)
        quality_bonus       ∈ [0,1]   (quality 10 ≈ 1.0)
    Total = produto ponderado.
    """
    deficit_priority = float(
        min(1.0, max(0.0, deficit / max(1.0, target_seconds))))
    relevance_score = float(max(0.0, sim))
    useful_s = min(8.0, max(0.0, target_seconds / 3.0))
    q_bonus = min(1.0, max(0.0, quality / 10.0))
    gain = (deficit_priority
            * relevance_score
            * useful_s
            * q_bonus)
    return float(gain)


# === DiscoveryIndex (LanceDB wrapper) ========================================

class DiscoveryIndex:
    TABLE = "discovery_index"

    def __init__(self, db):
        self._db = db
        # Fix code-reviewer P5: usar property pública `library_root` em vez
        # de `_library_root` privado.
        root_path = getattr(db, "library_root", None) \
                    or getattr(db, "root", None)
        if root_path is None:
            log.warning(
                "DiscoveryIndex: db não tem 'library_root' nem 'root' — "
                "fallback JSONL desactivado. Use LibraryDB padrão.")
        self._fallback_path = (
            Path(root_path) / "discovery_index.jsonl"
            if root_path is not None else None
        )

    def _table(self):
        try:
            lance = getattr(self._db, "lance", None) or self._db._db
            return lance.open_table(self.TABLE)
        except Exception:
            return None

    def has_scanned(self, media_path: str) -> bool:
        tab = self._table()
        if tab is not None:
            try:
                rows = (tab.search()
                        .where(f"media_path = '{media_path}'")
                        .limit(1).to_list())
                return bool(rows)
            except Exception:
                pass
        if self._fallback_path is None or not self._fallback_path.exists():
            return False
        try:
            with self._fallback_path.open("r", encoding="utf-8") as f:
                for line in f:
                    row = json.loads(line.strip())
                    if row.get("media_path") == media_path:
                        return True
        except (OSError, json.JSONDecodeError):
            pass
        return False

    def upsert(self, rec: DiscoveryRecord) -> bool:
        row = rec.to_row()
        tab = self._table()
        if tab is not None:
            try:
                tab.delete(f"media_path = '{row['media_path']}'")
                tab.add([row])
                return True
            except Exception as exc:
                log.debug("DiscoveryIndex.upsert: LanceDB add falhou (%s) — "
                          "JSONL fallback", exc)
        if self._fallback_path is not None:
            try:
                self._fallback_path.parent.mkdir(parents=True, exist_ok=True)
                with self._fallback_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
                return True
            except OSError as exc:
                log.debug("DiscoveryIndex.upsert: JSONL write falhou (%s)", exc)
        return False

    def list_for_workset_match(self, workset_ctx) -> list[dict]:
        """Devolve preview records (compatíveis com requirement matching)."""
        tab = self._table()
        out: list[dict] = []
        if tab is not None:
            try:
                rows = tab.search().limit(50_000).to_list()
                return rows
            except Exception:
                pass
        if self._fallback_path is None or not self._fallback_path.exists():
            return out
        try:
            with self._fallback_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    out.append(json.loads(line))
        except (OSError, json.JSONDecodeError):
            return out
        return out


# === Discovery runner ========================================================

def scan_one(
    path: Path,
    embedder,
    *,
    siglip_model_id: str,
    allow_rescan: bool = False,
) -> Optional[DiscoveryRecord]:
    """Scan de 1 mp4 → DiscoveryRecord (None se inválido).

    NÃO chama Gemini. NÃO faz SceneDetect. 1 frame + 1 SigLIP embed.
    """
    try:
        size = path.stat().st_size
    except OSError:
        return None
    probe = _ffprobe(path)
    if not probe or probe.get("duration", 0.0) <= 0:
        log.debug("discovery: skip %s (ffprobe vazio ou duration<=0)",
                  path.name)
        return None
    duration = float(probe["duration"])
    width = int(probe.get("width") or 0)
    height = int(probe.get("height") or 0)
    codec = str(probe.get("codec") or "")

    frame = _extract_mid_frame(path, duration)
    if not frame:
        return None
    try:
        # SigLIP image embed: métodos embed_images batch (1 item, fast path).
        import numpy as np
        vecs = embedder.embed_images([frame])
        if vecs.shape[0] == 0:
            return None
        vec = vecs[0].astype(float).tolist()
    except Exception as exc:
        log.warning("discovery: SigLIP embed falhou para %s: %s",
                    path.name, exc)
        return None

    return DiscoveryRecord(
        media_path=str(path),
        source_id=path.stem,
        media_sha=_file_sha_head(path),
        duration=duration,
        width=width,
        height=height,
        codec=codec,
        file_size=size,
        siglip_model_id=siglip_model_id,
        discovery_version=DISCOVERY_VERSION,
        preview_vec=vec,
        status=S_DISCOVERED_GLOBAL,
    )


def scan_batch(
    paths: list[Path],
    embedder,
    *,
    siglip_model_id: str,
    discovery_index: Optional[DiscoveryIndex] = None,
    on_record=None,
) -> tuple[list[DiscoveryRecord], dict]:
    """Scan em batch com SigLIP image batch (aproveita auto-tune).

    P2 (Porto Final Readiness 2026-08-11) — cache skip: se discovery_index
    já contém row para media_path COM mesmo siglip_model_id E mesmo
    discovery_version, retorna o record cacheado SEM ffprobe, SEM
    frame_extract, SEM SigLIP. counters stats incrementado:
        - cached_hits: int    (paths reutilizados sem re-trabalho)
        - reembed_count: int  (paths que precisariam de SigLIP; 0 se cache
                                completo, N quando cache miss)

    Returns:
        (records, stats) onde stats = {
            "scanned": int, "invalid": int, "skipped_cached": int,
            "cached_hits": int, "reembed_count": int,
            "ffprobe_s": float, "frame_extract_s": float,
            "siglip_s": float, "wall": float
        }
    """
    import time

    t_wall = time.perf_counter()
    records: list[DiscoveryRecord] = []
    stats = {
        "scanned": 0, "invalid": 0, "skipped_cached": 0,
        "cached_hits": 0, "reembed_count": 0,
        "ffprobe_s": 0.0, "frame_extract_s": 0.0,
        "siglip_s": 0.0, "wall": 0.0,
    }
    if not paths:
        stats["wall"] = time.perf_counter() - t_wall
        return records, stats

    # === Phase 0 (P2 CACHE FIX): separar paths já cached vs a scanear ===
    cached_records: list[DiscoveryRecord] = []
    to_scan: list[Path] = list(paths)
    if discovery_index is not None:
        try:
            all_rows = discovery_index.list_for_workset_match(None)
            cached_by_path = {
                row["media_path"]: row for row in all_rows
                if row.get("media_path")
                and row.get("siglip_model_id") == siglip_model_id
                and int(row.get("discovery_version", -1)) == DISCOVERY_VERSION
            }
        except Exception as exc:
            log.debug("scan_batch Phase 0 cache lookup falhou: %s — full rescan",
                      exc.__class__.__name__)
            cached_by_path = {}
        still_to_scan: list[Path] = []
        for p in to_scan:
            sp = str(p)
            row = cached_by_path.get(sp)
            if row is None:
                still_to_scan.append(p)
                continue
            try:
                rec = DiscoveryRecord(
                    media_path=row["media_path"],
                    source_id=row.get("source_id", Path(sp).stem),
                    media_sha=row.get("media_sha", ""),
                    duration=float(row.get("duration", 0.0) or 0.0),
                    width=int(row.get("width", 0) or 0),
                    height=int(row.get("height", 0) or 0),
                    codec=str(row.get("codec", "") or ""),
                    file_size=int(row.get("file_size", 0) or 0),
                    siglip_model_id=row.get("siglip_model_id", siglip_model_id),
                    discovery_version=int(row.get("discovery_version",
                                                    DISCOVERY_VERSION)),
                    preview_vec=list(json.loads(row.get("preview_json", "[]"))),
                    status=row.get("status", S_DISCOVERED_GLOBAL),
                    scanned_at=row.get("scanned_at", ""),
                )
                cached_records.append(rec)
                if on_record is not None:
                    try:
                        on_record(rec)
                    except Exception as exc:
                        log.debug("on_record(cached) falhou: %s", 
                                  exc.__class__.__name__)
                stats["cached_hits"] += 1
            except Exception as exc:
                # cache row malformed → fall back to full scan
                log.debug("scan_batch cache row malformed %s: %s — defer to scan",
                          sp, exc.__class__.__name__)
                still_to_scan.append(p)
        to_scan = still_to_scan
    stats["reembed_count"] = 0  # populated below if to_scan triggers SigLIP

    # Phase 1: ffprobe em paralelo dos paths (apenas to_scan)
    probe_meta: dict[Path, dict] = {}
    t0 = time.perf_counter()
    for p in to_scan:
        meta = _ffprobe(p)
        if not meta:
            stats["invalid"] += 1
            continue
        probe_meta[p] = meta
    stats["ffprobe_s"] += time.perf_counter() - t0

    # Phase 2: extract 1 frame por path
    t0 = time.perf_counter()
    frames: list[tuple[Path, Path]] = []
    for p, meta in probe_meta.items():
        f = _extract_mid_frame(p, meta.get("duration", 0.0))
        if not f:
            stats["invalid"] += 1
            continue
        frames.append((p, f))
    stats["frame_extract_s"] += time.perf_counter() - t0

    if not frames:
        stats["wall"] = time.perf_counter() - t_wall
        return records, stats

    # Phase 3: SigLIP batch (APENAS UMA chamada com N imagens — auto-tune)
    t0 = time.perf_counter()
    try:
        frame_paths = [f for _, f in frames]
        vecs = embedder.embed_images(frame_paths)
    except Exception as exc:
        log.error("scan_batch: SigLIP batch failed: %s — abort", exc)
        stats["siglip_s"] += time.perf_counter() - t0
        stats["wall"] = time.perf_counter() - t_wall
        return records, stats
    stats["siglip_s"] += time.perf_counter() - t0

    if vecs.shape[0] != len(frames):
        log.warning("scan_batch: shape mismatch SigLIP %s vs frames %d — "
                    "skip remaining",
                    vecs.shape, len(frames))
        stats["wall"] = time.perf_counter() - t_wall
        return cached_records + records, stats

    # Phase 4: compose records
    for (orig_path, _frame), vec in zip(frames, vecs):
        meta = probe_meta.get(orig_path, {})
        rec = DiscoveryRecord(
            media_path=str(orig_path),
            source_id=orig_path.stem,
            media_sha=_file_sha_head(orig_path),
            duration=float(meta.get("duration", 0.0)),
            width=int(meta.get("width", 0)),
            height=int(meta.get("height", 0)),
            codec=str(meta.get("codec", "")),
            file_size=(orig_path.stat().st_size
                       if orig_path.exists() else 0),
            siglip_model_id=siglip_model_id,
            discovery_version=DISCOVERY_VERSION,
            preview_vec=vec.astype(float).tolist(),
            status=S_DISCOVERED_GLOBAL,
        )
        if discovery_index is not None and on_record is not None:
            if on_record(rec):
                records.append(rec)
        else:
            records.append(rec)
        stats["scanned"] += 1
    # P2 (Porto Final Readiness 2026-08-11): reembed_count só conta os
    # shots que EFFECTIVAMENTE passaram por SigLIP (não os cacheados). Se
    # todos os paths estão em cache, este stat fica 0 e gate DISCOVERY_CACHE
    # REAL_PASS pode ser YES. CORREÇÃO code-reviewer: era len(records)+
    # len(cached_records), o que inflava o número sem trabalho real.
    stats["reembed_count"] += len(records)
    stats["wall"] = time.perf_counter() - t_wall
    return cached_records + records, stats


# === Scheduler ================================================================

def rank_candidates(
    records: list[dict],
    workset_ctx,
    *,
    max_promote: int = 20,
    min_similarity: float = 0.0,    # top-K scheduler (P6.1) — sem threshold estrict
) -> list[tuple[dict, str, float, float]]:
    """Top-K matches: para cada candidate melhor sim é emparelhado com 1 requirement.

    Returns:
        list of (record, canonical_entity, similarity, gain) ordenada por gain desc.
    """
    import numpy as np
    out: list[tuple[dict, str, float, float]] = []
    if not workset_ctx.requirement_embeddings:
        return out
    req_keys = list(workset_ctx.requirement_embeddings.keys())
    req_vecs = np.stack([workset_ctx.requirement_embeddings[k]
                         for k in req_keys])
    # normalizar
    req_norms = np.linalg.norm(req_vecs, axis=1, keepdims=True)
    req_norms = np.clip(req_norms, 1e-8, None)
    req_vecs = req_vecs / req_norms

    for row in records:
        try:
            preview = np.asarray(json.loads(row.get("preview_json", "[]")),
                                  dtype=np.float32)
        except (TypeError, json.JSONDecodeError, ValueError):
            continue
        if preview.size == 0:
            continue
        v = preview / np.clip(np.linalg.norm(preview), 1e-8, None)
        sims = req_vecs @ v
        if sims.size == 0:
            continue
        idx_best = int(sims.argmax())
        if sims[idx_best] < min_similarity:
            continue
        canon = req_keys[idx_best]
        # find target_seconds e deficit desse spec
        spec = workset_ctx.req_by_canonical(canon)
        if spec is None:
            continue
        target_s = float(spec.target_seconds or spec.required_seconds or 0.0)
        # deficit não é conhecido aqui (requer measurement); usamos 100% do
        # target como proxy pessimista na primeira run.
        gain = coverage_gain(
            sim=float(sims[idx_best]),
            target_seconds=target_s,
            available_seconds=0.0,
            deficit=target_s,
        )
        out.append((row, canon, float(sims[idx_best]), gain))
    out.sort(key=lambda x: x[3], reverse=True)
    return out[:max_promote]


__all__ = [
    "DiscoveryIndex",
    "DiscoveryRecord",
    "S_DISCOVERED_GLOBAL", "S_INVALID", "S_PENDING_ENRICHMENT",
    "S_FULLY_INGESTED", "ALL_STATUSES",
    "DISCOVERY_VERSION",
    "scan_one",
    "scan_batch",
    "rank_candidates",
    "coverage_gain",
]
