#!/usr/bin/env python3
"""Monitor HTTP server para o pipeline Studio Hubia.

Stdlib puro (http.server + json) — não toca pyproject.toml nem precisa de
deps novas. Lê `run.json` do run + tail do log em cada request; o cliente
faz polling a cada 4s (não usamos server-sent events para manter stdlib).

Endpoints:
    GET /                           → dashboard HTML estático
    GET /api/runs/<video_id>        → JSON com 14 estágios + custo + gates
    GET /api/log?lines=80           → tail do log file
    GET /api/ping                   → healthcheck
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

SCRIPTS_DIR = Path(__file__).resolve().parent
# SCRIPTS_DIR = <repo>/studio/scripts  →  parents[0] é <repo>/studio.
STUDIO_ROOT = SCRIPTS_DIR.parents[0]
REPO_ROOT = STUDIO_ROOT.parent
DATA_ROOT = Path(os.environ.get("STUDIO_DATA_ROOT") or REPO_ROOT / "data")
DEFAULT_LOG = Path(os.environ.get("STUDIO_MONITOR_LOG") or "/tmp/pfv-run.log")
DEFAULT_PORT = int(os.environ.get("STUDIO_MONITOR_PORT") or "8765")

# Ordem canónica dos 14 estágios do pipeline produce — bate certo com
# produce_stages() em stages/produce.py.
STAGES_ORDER = [
    "01_topic", "02_research", "03_script", "04_tts", "05_timestamps",
    "06_scenes", "07_briefs", "08_matching", "09_timeline", "10_render_proxy",
    "11_review", "12_render_final", "13_package", "14_upload",
]

STAGE_LABELS = {
    "01_topic":        "Tópico",
    "02_research":     "Pesquisa Gemini",
    "03_script":       "Roteiro (Gemini Pro)",
    "04_tts":          "Síntese de voz (TTS)",
    "05_timestamps":   "Whisper timestamps",
    "06_scenes":       "Segmentação cenas",
    "07_briefs":       "Visual briefs",
    "08_matching":     "Matching shots↔cenas",
    "09_timeline":     "Timeline builder",
    "10_render_proxy": "Render proxy 480p",
    "11_review":       "Review Vision (Gemini)",
    "12_render_final": "Render final 1080p",
    "13_package":      "Metadata + thumbnail",
    "14_upload":       "Publicar YouTube",
}


def _read_run(video_id: str) -> dict | None:
    rp = DATA_ROOT / "runs" / video_id / "run.json"
    if not rp.exists():
        return None
    try:
        return json.loads(rp.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _tail_lines(path: Path, n: int) -> list[str]:
    """Últimas N linhas do ficheiro (lê 64KB do fim — mais janela que 8KB
    anterior; o user pediu que o log não pareça 'estagnado')."""
    if not path.exists():
        return []
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            f.seek(max(0, size - 65536))
            data = f.read().decode("utf-8", errors="replace")
        return [l for l in data.splitlines() if l.strip()][-n:]
    except OSError:
        return []


def _file_stats(path: Path) -> dict:
    """mtime + size do ficheiro em epoch/ISO — usado pelo cliente para
    saber SE o log mudou desde a última fetch (flash visual + 'Xs ago')."""
    if not path.exists():
        return {"exists": False, "mtime_epoch": None, "mtime_iso": None,
                "size_bytes": 0}
    try:
        st = path.stat()
        return {
            "exists": True,
            "mtime_epoch": st.st_mtime,
            "mtime_iso": dt.datetime.fromtimestamp(st.st_mtime,
                                                   tz=dt.timezone.utc).isoformat(),
            "size_bytes": st.st_size,
        }
    except OSError:
        return {"exists": False, "mtime_epoch": None, "mtime_iso": None,
                "size_bytes": 0}


# ----------------- Library Tab helpers (Task 1) -----------------
# Query validation allow-list (file-review fix #1: anti-SQL-injection em search).
# Só chars seguros — qualquer '%', ';', '\' etc é rejeitado com 400 empty-hits.
_VALID_QUERY = re.compile(r"^[a-z0-9áéíóúãõâêôçà\- ]{1,32}$", re.IGNORECASE)

# lancedb singleton com lock (file-review fix #3: anti-FD-leak).
_LANCE = None
_LANCE_LOCK = threading.Lock()


def _get_lance():
    global _LANCE
    with _LANCE_LOCK:
        if _LANCE is None:
            import lancedb
            _LANCE = lancedb.connect(str(_library_lancedb_path()))
        return _LANCE

# Singleton para os buckets também (rebuild a cada N segundos é OK; cache partilhado).
_BUCKETS_CACHE = {"ts": 0.0, "data": {"buckets": []}}
_BUCKETS_LOCK = threading.Lock()
_BUCKETS_TTL_SEC = 3.0


def _get_buckets_summary() -> dict:
    """Lista resumida de buckets activos (Task 3). Cache curto (3s)."""
    import time as _t
    with _BUCKETS_LOCK:
        now = _t.time()
        if (now - _BUCKETS_CACHE["ts"]) < _BUCKETS_TTL_SEC and _BUCKETS_CACHE["data"]["buckets"]:
            return _BUCKETS_CACHE["data"]
        out = _scan_buckets_on_disk()
        _BUCKETS_CACHE["ts"] = now
        _BUCKETS_CACHE["data"] = out
        return out


def _scan_buckets_on_disk() -> dict:
    """Real scan da pasta data/library/buckets/."""
    out = {"buckets": []}
    bdir = _library_buckets_root()
    if not bdir.exists():
        return out
    for v in sorted(bdir.iterdir()):
        if not v.is_dir():
            continue
        topic_p = v / "topic_topics.json"
        shots_d = v / "shots"
        n_shots = sum(1 for _ in shots_d.iterdir()) if shots_d.exists() else 0
        entry: dict = {"video_id": v.name, "shots_in_bucket": n_shots,
                       "updated_at": None, "is_ready": False,
                       "topics_with_hits": 0, "topics_total": 0,
                       "missing": [], "script_theme": ""}
        if topic_p.exists():
            try:
                data = json.loads(topic_p.read_text())
                entry["updated_at"] = data.get("updated_at")
                entry["is_ready"] = data.get("is_ready", False)
                entry["topics_total"] = data.get("target_count", 0)
                entry["topics_with_hits"] = sum(
                    1 for t in data.get("topics", []) if t.get("count", 0) > 0)
                entry["missing"] = data.get("missing_topics", [])
                entry["script_theme"] = data.get("script_theme", "")
            except (OSError, json.JSONDecodeError):
                pass
        out["buckets"].append(entry)
    return out


# Anti-DDoS lock para /api/library/reconcile (file-review fix #4).
RECONCILE_PID_FILE = Path("/tmp/studio_reconcile_runner.pid")


def _reconcile_already_running() -> bool:
    """Devolve True se já há um reconcile vivo (PID file apontando para algo vivo)."""
    if not RECONCILE_PID_FILE.exists():
        return False
    try:
        pid = int(RECONCILE_PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return False
    try:
        os.kill(pid, 0)  # signal 0 = check alive sem matar
        return True
    except ProcessLookupError:
        try:
            RECONCILE_PID_FILE.unlink()
        except OSError:
            pass
        return False


def _library_root() -> Path:
    return DATA_ROOT / "library"


def _library_lancedb_path() -> Path:
    return _library_root() / "lancedb"


def _library_ingest_log() -> Path:
    return _library_root() / "ingest_log.jsonl"


def _library_reconcile_state() -> Path:
    return _library_root() / "reconcile_state.json"


def _library_dedup_index() -> Path:
    return _library_root() / "ingested_index.json"


def _library_buckets_root() -> Path:
    return _library_root() / "buckets"


_PHASE1_WORKFLOW_IMPORT_ERROR: Optional[str] = None


def _library_workflows_root() -> Path:
    return _library_root() / "workflows"


def _library_list_workflows() -> dict:
    """Lista workflows conhecidos (Phase 1) com merge opcional do bucket state."""
    if _PHASE1_WORKFLOW_IMPORT_ERROR:
        return {"workflows": [],
                "error": f"buckets import: {_PHASE1_WORKFLOW_IMPORT_ERROR}"}
    try:
        sys.path.insert(0, str(STUDIO_ROOT / "src"))
        from studio.library.buckets import list_workflows as _bw
        return {"workflows": _bw(), "root": str(_library_workflows_root())}
    except Exception as exc:
        return {"workflows": [], "error": f"{exc.__class__.__name__}: {exc}"}


def _library_read_workflow(video_id: str) -> Optional[dict]:
    try:
        sys.path.insert(0, str(STUDIO_ROOT / "src"))
        from studio.library.buckets import read_workflow as _rw
        return _rw(video_id)
    except Exception:
        return None


def _library_stats() -> dict:
    """Snapshot da library: counts, distribui por source/place/landmark/food."""
    out: dict = {
        "data_root": str(_library_root()),
        "total_shots": 0,
        "by_source": {},
        "by_place": {},
        "by_landmark": {},
        "by_food": {},
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    try:
        import lancedb
        db = lancedb.connect(str(_library_lancedb_path()))
        tables = db.list_tables() if hasattr(db, "list_tables") else db.table_names()
        if "shots" not in tables:
            out["note"] = "tabela shots n\u00e3o existe (library vazia)"
            return out
        tbl = db.open_table("shots")
        n = tbl.count_rows()
        out["total_shots"] = int(n)
        if n == 0:
            out["note"] = "lancedb vazio (0 rows)"
            return out
        rows = tbl.to_list()
        from collections import Counter
        bs = Counter(); bp = Counter(); bl = Counter(); bf = Counter()
        for r in rows:
            src = r.get("source") or r.get("source_url") or r.get("license_source") or "?"
            bs[str(src)] += 1
            for cs, ctr in (("places_csv", bp),
                             ("landmarks_csv", bl),
                             ("food_csv", bf)):
                v = (r.get(cs) or "")
                for t in [x.strip() for x in v.split(",") if x.strip()]:
                    ctr[t.lower()] += 1
        out["by_source"] = dict(bs.most_common(10))
        out["by_place"] = dict(bp.most_common(15))
        out["by_landmark"] = dict(bl.most_common(15))
        out["by_food"] = dict(bf.most_common(15))
    except Exception as exc:
        out["error"] = f"{exc.__class__.__name__}: {exc}"
    return out


def _library_logs(n: int = 50, *, only_failures: bool = False) -> dict:
    """Tail do ingest_log. only_failures=True filtra status != ingested."""
    p = _library_ingest_log()
    if not p.exists():
        return {"path": str(p), "exists": False, "events": [], "total": 0}
    try:
        with p.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 32768))
            data = f.read().decode("utf-8", errors="replace")
        events_raw = [l for l in data.splitlines() if l.strip()]
        events: list[dict] = []
        for line in events_raw:
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            status = str(ev.get("status", "")).lower()
            if only_failures and status not in ("fail", "failed", "error",
                                                  "skipped", "shot_skipped"):
                continue
            events.append({
                "at": ev.get("at", ""),
                "status": ev.get("status", "?"),
                "file": ev.get("file", ev.get("event", "?")),
                "sha": ev.get("sha", ""),
                "error": ev.get("error", ev.get("reason", "")),
            })
        events.sort(key=lambda e: e.get("at") or "", reverse=True)
        return {
            "path": str(p),
            "exists": True,
            "count": len(events),
            "events": events[:n],
            "only_failures": only_failures,
        }
    except OSError as exc:
        return {"path": str(p), "exists": True, "error": str(exc), "events": []}


def _library_health() -> dict:
    """Diagn\u00f3stico r\u00e1pido do estado da library."""
    out: dict = {"checks": {}}
    root = _library_root()
    out["checks"]["library_root_exists"] = root.exists()
    out["checks"]["ingest_log_exists"] = _library_ingest_log().exists()
    out["checks"]["reconcile_state_exists"] = _library_reconcile_state().exists()
    out["checks"]["dedup_index_exists"] = _library_dedup_index().exists()
    mdir = root / "media"
    shots_dir = root / "shots"
    downloads_dir = root / "downloads"
    out["checks"]["downloads_count"] = (sum(1 for _ in downloads_dir.iterdir())
                                          if downloads_dir.exists() else 0)
    out["checks"]["media_count"] = (sum(1 for _ in mdir.iterdir())
                                     if mdir.exists() else 0)
    out["checks"]["shots_dirs_count"] = (sum(1 for _ in shots_dir.iterdir())
                                            if shots_dir.exists() else 0)
    out["checks"]["lancedb_shots_rows"] = "?"
    try:
        db = _get_lance()
        if "shots" in (db.list_tables() if hasattr(db, "list_tables")
                        else db.table_names()):
            out["checks"]["lancedb_shots_rows"] = int(
                db.open_table("shots").count_rows())
    except Exception as exc:
        out["checks"]["lancedb_error"] = str(exc)
    out["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    return out


def _library_search(query: str) -> dict:
    """Pesquisa simples nas colunas CSV da tabela shots.

    file-review fix #1 (anti-SQL-injection): validação via allow-list regex.
    Se o input n\u00e3o bater [a-z0-9\u00e1\u00e9\u00ed\u00f3\u00fa\u00e3\u00f5\u00e2\u00ea\u00f4\u00e7\u00e0 \- ]{1,32}, devolvemos
    total=0 sem tocar na DB (e log warning). A f-string dentro do LIKE s\u00f3 \u00e9
    interpolada com `q` j\u00e1 validado, eliminando o vector de injection.
    """
    q = (query or "").strip().lower()
    if not q:
        return {"query": "", "hits": [], "total": 0}
    if not _VALID_QUERY.match(q):
        return {"query": q, "hits": [], "total": 0,
                "note": "input rejected (chars n\u00e3o permitidos)", "rejected": True}
    try:
        db = _get_lance()
        if "shots" not in (db.list_tables() if hasattr(db, "list_tables")
                            else db.table_names()):
            return {"query": q, "hits": [], "total": 0,
                    "note": "tabela vazia"}
        tbl = db.open_table("shots")
        hits = tbl.search().where(
            f"(LOWER(places_csv) LIKE '%{q}%') "
            f"OR (LOWER(landmarks_csv) LIKE '%{q}%') "
            f"OR (LOWER(food_csv) LIKE '%{q}%')"
        ).limit(50).to_list()
        out_hits = []
        for r in hits:
            out_hits.append({
                "shot_id": r.get("shot_id", ""),
                "media_sha": r.get("media_sha", ""),
                "places_csv": r.get("places_csv", ""),
                "landmarks_csv": r.get("landmarks_csv", ""),
                "food_csv": r.get("food_csv", ""),
            })
        return {"query": q, "hits": out_hits, "total": len(out_hits)}
    except Exception as exc:
        return {"query": q, "error": f"{exc.__class__.__name__}: {exc}",
                "hits": [], "total": 0}


def _library_buckets_summary() -> dict:
    """Lista resumida de buckets activos (Task 3) com cache 3s."""
    return _get_buckets_summary()


def _library_reconcile_status() -> dict:
    """L\u00ea estado de execu\u00e7\u00e3o do reconcile (Task 2)."""
    p = _library_reconcile_state()
    if not p.exists():
        return {"exists": False, "path": str(p)}
    try:
        return {"exists": True, "path": str(p),
                "size_bytes": p.stat().st_size,
                **json.loads(p.read_text())}
    except (OSError, json.JSONDecodeError) as exc:
        return {"exists": True, "path": str(p), "error": str(exc)}


def _library_dedup_stats() -> dict:
    p = _library_dedup_index()
    if not p.exists():
        return {"exists": False, "path": str(p), "total": 0}
    try:
        data = json.loads(p.read_text())
        items = data.get("items", data.get("source_ids", []))
        return {"exists": True, "path": str(p),
                "total": data.get("count", len(items)),
                "version": data.get("version", 1),
                "dirty": data.get("dirty", False)}
    except (OSError, json.JSONDecodeError) as exc:
        return {"exists": True, "path": str(p), "error": str(exc)}


# ----------------- Phase 7 — Library dashboard endpoints -----------------
# Adicionado como extension dos Library Tab helpers. Cada handler é
# fail-soft: se uma secção interna falha (lancedb missing, JSON corrupto),
# devolve um dict com `error` em vez de crashar o thread do monitor.


def _library_process(self) -> dict:
    """Phase 7 — assets em curso + recently done (50 mais recentes).
    Lê sidecar JSON em data/library/states/<sha>.json via AssetStateStore
    formato. Limita top-50 por mtime (não iterar 10k files)."""
    out: dict = {"states_dir": str(_library_root() / "states"),
                  "in_flight_count": 0, "by_state": {}, "recent": []}
    root = _library_root() / "states"
    if not root.exists():
        out["note"] = "states dir não existe (1º run ainda não começou)"
        return out
    in_flight = {"INGESTING", "SCENE_DETECTED", "EMBEDDED",
                  "METADATA_ANALYZED", "REGISTERED", "VERIFIED"}
    try:
        files = sorted(root.glob("*.json"),
                        key=lambda p: -p.stat().st_mtime)[:50]
        for p in files:
            try:
                rec = json.loads(p.read_text())
            except Exception:
                continue
            st = rec.get("state", "?")
            out["by_state"][st] = out["by_state"].get(st, 0) + 1
            if st in in_flight:
                out["in_flight_count"] += 1
            out["recent"].append({
                "media_sha_short": p.stem[:12],
                "state": st,
                "attempts": rec.get("attempts", 0),
                "updated_at": rec.get("updated_at"),
                "source_path": (rec.get("source_path", "") or "")[:80],
                "last_error": (rec.get("last_error", "") or "")[:120],
            })
    except Exception as exc:
        out["error"] = f"{exc.__class__.__name__}: {exc}"
    return out


def _library_coverage(self, video_id: str) -> dict:
    """Phase 7 — coverage report para um workset (Phase 2 deferred;
    fallback em buckets/<v>/topic_topics.json enquanto worksets/ não
    existe)."""
    try:
        sys.path.insert(0, str(STUDIO_ROOT / "src"))
        from studio.library.buckets import read_workflow, get_progress
    except Exception as exc:
        return {"error": f"buckets import: {exc}", "video_id": video_id}
    wf = read_workflow(video_id)
    prog = get_progress(video_id)
    if not wf and not prog:
        return {"error": "workflow/bucket not found", "video_id": video_id,
                "hint": "Phase 2 worksets ainda não aplicada; só buckets/ existe"}
    out: dict = {"video_id": video_id,
                  "workflow_found": bool(wf),
                  "bucket_progress": prog,
                  "is_ready": bool(prog and prog.get("is_ready"))}
    if wf:
        out["theme"] = wf.get("theme", "")
        out["target_count"] = len(wf.get("target_topics", []))
    if prog:
        out["topics_total"] = prog.get("target_count", 0)
        out["topics_with_hits"] = sum(
            1 for t in prog.get("topics", []) if t.get("count", 0) > 0)
        out["shots_in_bucket"] = sum(
            t.get("count", 0) for t in prog.get("topics", []))
        out["topics_detail"] = [
            {"topic": t.get("topic"), "count": t.get("count", 0)}
            for t in prog.get("topics", [])
        ]
    return out


def _library_dedup_stats_full(self) -> dict:
    """Phase 7 — combined dedup_index (JSON) + provider_cache (LanceDB).
    Útil para detectar drift entre provider_cache e dedup_index."""
    out: dict = {"dedup_index": {}, "provider_cache": {}}
    p = _library_dedup_index()
    if p.exists():
        try:
            d = json.loads(p.read_text())
            items = d.get("items", d.get("source_ids", []))
            by_status: dict[str, int] = {}
            for it in (items if isinstance(items, list) else []):
                st = (it.get("status") if isinstance(it, dict) else "legacy")
                by_status[str(st)] = by_status.get(str(st), 0) + 1
            out["dedup_index"] = {
                "path": str(p),
                "total": d.get("count", len(items)),
                "version": d.get("version", 1),
                "dirty": d.get("dirty", False),
                "by_status": by_status,
            }
        except Exception as exc:
            out["dedup_index"] = {"path": str(p), "error": str(exc)}
    try:
        db = _get_lance()
        if "provider_cache" in (db.list_tables() if hasattr(
                db, "list_tables") else db.table_names()):
            tbl = db.open_table("provider_cache")
            rows = tbl.to_list() or []
            by_status: dict[str, int] = {}
            by_provider: dict[str, int] = {}
            sample_reasons: list[str] = []
            for r in rows:
                st = r.get("status", "?")
                pr = r.get("provider", "?")
                by_status[st] = by_status.get(st, 0) + 1
                by_provider[pr] = by_provider.get(pr, 0) + 1
                if r.get("status") == "rejected" and len(sample_reasons) < 10:
                    sample_reasons.append((r.get("reason", "") or "")[:120])
            out["provider_cache"] = {
                "total": len(rows),
                "by_status": by_status,
                "by_provider": by_provider,
                "sample_reject_reasons": sample_reasons,
            }
    except Exception as exc:
        out["provider_cache"] = {
            "error": f"{exc.__class__.__name__}: {exc}"}
    return out


def _library_perf(self) -> dict:
    """Phase 7 — perf counters: ingest_log aggregado + GeminiLimiter stats.
    Fail-soft: cada secção isolada (lancedb, files) não derruba as outras."""
    out: dict = {"ingest_events": {}, "totals": {},
                  "gemini_limiter": {},
                  "updated_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    p = _library_ingest_log()
    if p.exists():
        try:
            with p.open("rb") as f:
                f.seek(0, 2)
                size = f.tell()
                f.seek(max(0, size - 65536))
                data = f.read().decode("utf-8", errors="replace")
            events: list[dict] = []
            for line in data.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            by_status: dict[str, int] = {}
            cost_total = 0.0
            shots_total = 0
            for ev in events:
                st = str(ev.get("status", "")).lower() or "?"
                by_status[st] = by_status.get(st, 0) + 1
                if ev.get("cost_usd"):
                    cost_total += float(ev["cost_usd"])
                if ev.get("shots"):
                    shots_total += int(ev["shots"])
            out["ingest_events"] = {
                "total_in_window": len(events), "by_status": by_status,
            }
            out["totals"] = {
                "cost_usd": round(cost_total, 4),
                "shots_added": shots_total,
            }
        except OSError as exc:
            out["ingest_events"] = {"error": str(exc)}
    else:
        out["ingest_events"] = {"note": "ingest_log não existe"}
    try:
        sys.path.insert(0, str(STUDIO_ROOT / "src"))
        from studio.library.rate_limit import get_gemini_limiter
        from studio.config import get_settings
        out["gemini_limiter"] = get_gemini_limiter(get_settings()).stats()
    except Exception as exc:
        out["gemini_limiter"] = {"note": f"{exc.__class__.__name__}: {exc}"}
    return out


def _library_orphans(self) -> dict:
    """Phase 7 — detecção BIDIRECIONAL de orphans.
    1) mp4 files em data/library/media/ que NÃO existem como media_sha
       no LanceDB shots table (filenames opacos dos 908 órfãos).
    2) rows em LanceDB cujo media_sha não tem MP4 correspondente no disco.

    Ambos os sentidos detectáveis; `is_clean=true` quando nenhum existe.
    """
    out: dict = {"is_clean": False, "media_files_count": 0,
                  "missing_in_db_count": 0, "missing_media_count": 0,
                  "missing_in_db_sample": [], "missing_media_sample": []}
    media_dir = _library_root() / "media"
    if not media_dir.exists():
        out["is_clean"] = True
        out["note"] = "media dir não existe"
        return out
    media_files = [p for p in media_dir.iterdir()
                    if p.suffix.lower() in (".mp4", ".mov", ".m4v")]
    out["media_files_count"] = len(media_files)
    if not media_files:
        out["is_clean"] = True
        return out
    try:
        db = _get_lance()
        if "shots" not in (db.list_tables() if hasattr(
                db, "list_tables") else db.table_names()):
            out["missing_in_db_count"] = len(media_files)
            out["missing_in_db_sample"] = [p.name for p in media_files[:50]]
            out["note"] = "tabela shots não existe — todos os mp4 são órfãos"
            return out
        tbl = db.open_table("shots")
        # Code-reviewer [D] — BLOCKER em scale >10k polling 2.5s. Limit
        # 5000 rows tem boa cobertura para bibliotecas pequenas + sinal
        # explícito (scan_limit_reached) quando atingido.
        ORPHAN_SCAN_LIMIT = 5000
        rows = tbl.search().limit(ORPHAN_SCAN_LIMIT).to_list() or []
        db_shas = {r.get("media_sha", "") for r in rows if r.get("media_sha")}
        out["scan_limit"] = ORPHAN_SCAN_LIMIT
        out["scan_limit_reached"] = len(rows) >= ORPHAN_SCAN_LIMIT
        # 1) mp4 files whose stem is NOT a media_sha in DB.
        missing_in_db = [p for p in media_files
                          if p.stem not in db_shas
                          and p.name not in db_shas]
        out["missing_in_db_count"] = len(missing_in_db)
        out["missing_in_db_sample"] = [p.name for p in missing_in_db[:50]]
        # 2) DB rows whose media_sha has no corresponding MP4 on disk.
        missing_media_sample: list[str] = []
        missing_media_count = 0
        for sha in db_shas:
            if not (media_dir / f"{sha}.mp4").exists() and not (
                    media_dir / f"{sha}.mov").exists():
                missing_media_count += 1
                if len(missing_media_sample) < 50:
                    missing_media_sample.append(sha[:12])
        out["missing_media_count"] = missing_media_count
        out["missing_media_sample"] = missing_media_sample
        out["is_clean"] = (
            out["missing_in_db_count"] == 0 and missing_media_count == 0
        )
    except Exception as exc:
        out["error"] = f"{exc.__class__.__name__}: {exc}"
    return out


# ----------------- end Library Tab helpers -----------------


# Mapa reverso de label → estado humano (pt-PT)
PT_STATUS = {
    "done": "CONCLUÍDO",
    "running": "A CORRER",
    "failed": "FALHOU",
    "waiting_approval": "À ESPERA",
    "pending": "PENDENTE",
}


class Handler(BaseHTTPRequestHandler):
    # Silencia o log de acesso (chatty em produção)
    def log_message(self, fmt: str, *args) -> None:  # noqa: D401
        pass

    def _send_json(self, obj: dict, code: int = 200) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: Path) -> None:
        if not path.exists():
            self.send_error(404, f"{path.name} not found")
            return
        body = path.read_bytes()
        self.send_response(200)
        ctype = ("text/html; charset=utf-8" if path.suffix == ".html"
                 else "application/octet-stream")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _stage_view(self, run: dict) -> list[dict]:
        stages_meta = run.get("stages", {})
        out = []
        for name in STAGES_ORDER:
            rec = stages_meta.get(name, {}) or {}
            out.append({
                "name": name,
                "label": STAGE_LABELS[name],
                "status": rec.get("status", "pending"),
                "status_pt": PT_STATUS.get(rec.get("status", "pending"),
                                            rec.get("status", "pending").upper()),
                "attempts": rec.get("attempts", 0),
                "cost_usd": float(rec.get("cost_usd") or 0.0),
                "started_at": rec.get("started_at"),
                "finished_at": rec.get("finished_at"),
                "error": rec.get("error"),
            })
        return out

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        path = self.path.split("?", 1)[0]

        if path == "/" or path == "/index" or path == "/index.html":
            return self._send_file(STUDIO_ROOT / "scripts" / "static" / "index.html")

        if path.startswith("/api/runs/"):
            vid = path[len("/api/runs/"):].strip("/")
            if not vid or "/" in vid:
                return self._send_json({"error": "bad video_id format"}, 400)
            run = _read_run(vid)
            if not run:
                return self._send_json(
                    {"error": "run not found", "video_id": vid,
                     "data_root": str(DATA_ROOT)}, 404)
            stages = self._stage_view(run)
            budget = run.get("cost_ledger", {}).get("budget_usd", 15.0)
            return self._send_json({
                "video_id": run["video_id"],
                "topic": run.get("topic", ""),
                "created_at": run.get("created_at"),
                "params": run.get("params", {}),
                "gates": run.get("gates", {}),
                "cost_total": float(run.get("cost_ledger", {}).get("total_usd") or 0.0),
                "budget": float(budget),
                "stages": stages,
            })

        if path.startswith("/api/log"):
            qpath = self.path.split("?", 1)
            qparams: dict = {}
            if len(qpath) > 1:
                for kv in qpath[1].split("&"):
                    if "=" in kv:
                        k, v = kv.split("=", 1)
                        qparams[k] = v
            try:
                n = max(1, min(int(qparams.get("lines", "120")), 500))
            except ValueError:
                n = 120
            stats = _file_stats(DEFAULT_LOG)
            return self._send_json({
                "path": str(DEFAULT_LOG),
                "exists": DEFAULT_LOG.exists(),
                "server_now_epoch": dt.datetime.now(dt.timezone.utc).timestamp(),
                "server_now_iso": dt.datetime.now(dt.timezone.utc).isoformat(),
                "file_mtime_epoch": stats["mtime_epoch"],
                "file_mtime_iso": stats["mtime_iso"],
                "size_bytes": stats["size_bytes"],
                "lines": _tail_lines(DEFAULT_LOG, n),
            })

        if path == "/api/ping":
            now = dt.datetime.now(dt.timezone.utc).isoformat()
            return self._send_json({"ok": True, "now": now,
                                    "data_root": str(DATA_ROOT)})

        if path == "/api/runs":
            rs = DATA_ROOT / "runs"
            if not rs.exists():
                return self._send_json({"runs": []})
            entries = []
            for p in rs.iterdir():
                if not p.is_dir():
                    continue
                rp = p / "run.json"
                if not rp.exists():
                    continue
                try:
                    meta = json.loads(rp.read_text("utf-8"))
                except Exception:
                    continue
                entries.append({
                    "video_id": p.name,
                    "topic": meta.get("topic", ""),
                    "created_at": meta.get("created_at"),
                    "started_at_01": (meta.get("stages") or {}).get(
                        "01_topic", {}).get("started_at"),
                    "cost_total": float(meta.get("cost_ledger", {}).get("total_usd") or 0.0),
                    "current_stage": next(
                        ({"stage": k, "status": v.get("status"),
                          "started_at": v.get("started_at")}
                         for k, v in (meta.get("stages") or {}).items()
                         if v.get("status") in ("running", "waiting_approval")),
                        None),
                })
            # Sort: MAIS RECENTE PRIMEIRO (o utilizador quer ver o run ativo,
            # não um smoke-test antigo). created_at é ISO UTC — string sort
            # funciona perfeitamente.
            entries.sort(key=lambda e: (e.get("created_at") or ""), reverse=True)
            return self._send_json({"runs": entries[:20]})

        # ----- Library Tab routes (Task 1) -----
        if path == "/api/library/stats":
            return self._send_json(_library_stats())
        if path == "/api/library/logs":
            qn = self._qparam("lines", "50")
            qf = self._qparam("failures", "0") == "1"
            try:
                n = max(1, min(int(qn), 200))
            except ValueError:
                n = 50
            return self._send_json(_library_logs(n, only_failures=qf))
        if path == "/api/library/health":
            return self._send_json(_library_health())
        if path == "/api/library/buckets":
            return self._send_json(_library_buckets_summary())
        if path == "/api/library/reconcile-state":
            return self._send_json(_library_reconcile_status())
        if path == "/api/library/dedup":
            return self._send_json(_library_dedup_stats())
        if path == "/api/library/workflows":
            return self._send_json(_library_list_workflows())
        if path.startswith("/api/library/workflows/"):
            vid = path[len("/api/library/workflows/"):].strip("/")
            if not vid:
                return self._send_json({"error": "video_id required"}, 400)
            wf = _library_read_workflow(vid)
            if not wf:
                return self._send_json({"error": "workflow not found",
                                         "video_id": vid}, 404)
            return self._send_json(wf)
        if path.startswith("/api/library/search"):
            q = self._qparam("q", "")
            return self._send_json(_library_search(q))
        if path.startswith("/api/library/buckets/"):
            vid = path[len("/api/library/buckets/"):].strip("/")
            return self._send_json(_library_buckets_summary()
                                    if not vid else
                                    {"video_id": vid, "path": str(
                                        _library_buckets_root() / vid)})
        # ===== Phase 7 — Library dashboard extensions =====
        if path == "/api/library/process":
            return self._send_json(self._library_process())
        if path.startswith("/api/library/coverage/"):
            vid = path[len("/api/library/coverage/"):].strip("/")
            if not vid:
                return self._send_json({"error": "video_id required"}, 400)
            return self._send_json(self._library_coverage(vid))
        if path == "/api/library/dedup_stats":
            return self._send_json(self._library_dedup_stats_full())
        if path == "/api/library/perf":
            return self._send_json(self._library_perf())
        if path == "/api/library/orphans":
            return self._send_json(self._library_orphans())

        self.send_error(404, "Not found")

    def do_POST(self) -> None:  # noqa: N802
        """POST endpoints para Library Tab (Task 1)."""
        path = self.path.split("?", 1)[0]
        if path == "/api/library/reconcile":
            return self._library_reconcile_trigger()
        self.send_error(404, "POST endpoint not found")

    def _qparam(self, key: str, default: str = "") -> str:
        qstr = self.path.split("?", 1)[1] if "?" in self.path else ""
        for kv in qstr.split("&"):
            if kv.startswith(f"{key}="):
                return kv[len(key) + 1:]
        return default

    def _library_reconcile_trigger(self) -> None:
        """Lan\u00e7a o reconcile em subprocesso ass\u00edncrono (Task 2)."""
        import subprocess as _sp
        log_path = _library_root() / "reconcile_runner.log"
        script = SCRIPTS_DIR.parent / "src" / "studio" / "library" / "reconcile.py"
        if not script.exists():
            return self._send_json({"error": "reconcile.py n\u00e3o encontrado",
                                     "expected": str(script)}, 500)
        try:
            log_f = open(log_path, "a")
            p = _sp.Popen(
                ["uv", "run", "--quiet", "--directory",
                 str(SCRIPTS_DIR.parent), "python", "-m",
                 "studio.library.reconcile"],
                stdout=log_f, stderr=_sp.STDOUT,
                start_new_session=True,
            )
            RECONCILE_PID_FILE.parent.mkdir(parents=True, exist_ok=True)
            RECONCILE_PID_FILE.write_text(str(p.pid))
            return self._send_json({
                "started": True, "pid": p.pid,
                "log_path": str(log_path),
                "anti_ddos_lock": str(RECONCILE_PID_FILE),
            })
        except Exception as exc:
            return self._send_json({"error": str(exc)}, 500)


def main() -> None:
    global DATA_ROOT  # noqa: PLW0603 — declarar antes de qualquer referência
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--bind", default="127.0.0.1",
                    help="default 127.0.0.1; use 0.0.0.0 para aceder de outra máquina")
    ap.add_argument("--data-root", type=Path, default=DATA_ROOT)
    args = ap.parse_args()

    # Aplicar override pós-argparse (CLI ganha sobre env var)
    if args.data_root is not None:
        DATA_ROOT = args.data_root
    if not (STUDIO_ROOT / "scripts" / "static" / "index.html").exists():
        raise SystemExit(
            f"index.html não encontrado em scripts/static/. Cria-o primeiro."
        )

    srv = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"studio-monitor: http://{args.bind}:{args.port}/  data={DATA_ROOT}  "
          f"log={DEFAULT_LOG}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstudio-monitor: a sair.")


if __name__ == "__main__":
    main()
