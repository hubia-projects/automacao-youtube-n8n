"""Buckets per-video + topic tracking (Task 3).

Diretório: data/library/buckets/<video_id>/
Ficheiro de estado: data/library/buckets/<video_id>/topic_topics.json
Ficheiros matchantes: data/library/buckets/<video_id>/shots/<shot_id>.mp4  (cópia)

Quando o CLI `studio ingest` recebe `--video-id X --topic-topics T1,T2,...`,
depois de `analyze_shot+register_shot`, contamos quantas entidades matcham
cada tópico. Se batedor, copiamos o shot_id para o bucket, incrementamos
o contador do tópico em topic_topics.json. Quando todos os tópicos têm count>=1,
`is_ready=True` — sinal claro para começar o vídeo (o resto enche-se depois).

Os shots ficam duplicados propositadamente: library geral (lancedb) + bucket
do vídeo. O bucket é pequeno e fácil de inspecionar; a library é grande e
pesquisável por embedding.
"""
from __future__ import annotations

import json
import logging
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("studio.library.buckets")

_REPO_ROOT_BUCKETS = Path(__file__).resolve().parents[4]
BUCKETS_ROOT = _REPO_ROOT_BUCKETS / "data" / "library" / "buckets"
_REPO_ROOT_BUCKETS = Path(__file__).resolve().parents[4]
WORKFLOWS_ROOT = _REPO_ROOT_BUCKETS / "data" / "library" / "workflows"

# Per-video_id lock para serializar writes em topic_topics.json.
# Race-safe quando múltiplos workers fazem bucket hits em paralelo.
_BUCKET_LOCKS: dict[str, threading.Lock] = {}
_BUCKET_LOCKS_GUARD = threading.Lock()


def workflow_path(video_id: str) -> Path:
    """Path ao workflow.json (NÃO usar em runtime concorrente — read-only)."""
    return WORKFLOWS_ROOT / f"{video_id}.json"


def read_workflow(video_id: str) -> Optional[dict]:
    """Lê /data/library/workflows/<video_id>.json. None se não existir/ilegível.

    Schema (Phase 1):
      video_id, theme, script_id, target_topics[(name, type, expected_shots)],
      meta_coverage{required, covered, is_ready}.
    """
    p = workflow_path(video_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("workflow '%s' unreadable (%s)", video_id, exc)
        return None


def list_workflows() -> list[dict]:
    """Lista todos os workflows conhecidos (Phase 1: para a tab Library)."""
    out: list[dict] = []
    if not WORKFLOWS_ROOT.exists():
        return out
    for p in sorted(WORKFLOWS_ROOT.glob("*.json")):
        wf = read_workflow(p.stem)
        if wf is None:
            continue
        # Pair com bucket se existir
        prog = get_progress(p.stem)
        out.append({
            "video_id": p.stem,
            "theme": wf.get("theme", ""),
            "script_id": wf.get("script_id", ""),
            "target_topics_count": len(wf.get("target_topics", [])),
            "meta_required": wf.get("meta_coverage", {}).get("required", 0),
            "meta_covered": wf.get("meta_coverage", {}).get("covered", 0),
            "meta_is_ready": wf.get("meta_coverage", {}).get("is_ready", False),
            "bucket_is_ready": (prog or {}).get("is_ready", False),
            "topics_with_hits": (prog or {}).get("topics", [])
                and sum(1 for t in prog["topics"] if t.get("count", 0) > 0),
            "missing_topics": (prog or {}).get("missing_topics", []),
        })
    return out


def write_workflow(video_id: str, *, theme: str, script_id: str,
                   target_topics: list[dict], required: int = 30) -> Path:
    """Cria data/library/workflows/<video_id>.json (idempotente se já existe
    com mesmo video_id). Usado pelo CLI para definir tema antes de buscar."""
    WORKFLOWS_ROOT.mkdir(parents=True, exist_ok=True)
    p = workflow_path(video_id)
    if p.exists():
        log.info("workflow '%s' já existe, vou só actualizar meta_coverage", video_id)
        existing = read_workflow(video_id) or {}
        existing["meta_coverage"]["required"] = required
        data = existing
    else:
        data = {
            "video_id": video_id,
            "theme": theme,
            "script_id": script_id,
            "target_topics": target_topics,
            "meta_coverage": {
                "required": required,
                "covered": 0,
                "is_ready": False,
            },
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.rename(p)
    log.info("workflow '%s' gravado em %s (target_topics=%d)",
             video_id, p, len(target_topics))
    return p


def _lock_for(video_id: str) -> threading.Lock:
    with _BUCKET_LOCKS_GUARD:
        if video_id not in _BUCKET_LOCKS:
            _BUCKET_LOCKS[video_id] = threading.Lock()
        return _BUCKET_LOCKS[video_id]  # type: ignore[return-value]  # guarded above


def bucket_dir(video_id: str) -> Path:
    return BUCKETS_ROOT / video_id


def topic_topics_path(video_id: str) -> Path:
    return bucket_dir(video_id) / "topic_topics.json"


def bucket_shots_dir(video_id: str) -> Path:
    return bucket_dir(video_id) / "shots"


def init_bucket(video_id: str, *, script_theme: str,
                topics: list[str]) -> Path:
    """Cria (idempotente) bucket dir + topic_topics.json vazio. Devolve path do dir."""
    d = bucket_dir(video_id)
    d.mkdir(parents=True, exist_ok=True)
    bucket_shots_dir(video_id).mkdir(parents=True, exist_ok=True)
    p = topic_topics_path(video_id)
    if not p.exists():
        _write_topic_topics(p, video_id, script_theme,
                            {t: {"count": 0, "shots": []} for t in topics})
        log.info("buckets: init '%s' com %d tópicos", video_id, len(topics))
    return d


def _write_topic_topics(p: Path, video_id: str, theme: str,
                        hits: dict[str, dict]) -> None:
    """Escreve topic_topics.json atomicamente."""
    topics_list = list(hits.keys())
    counts = {t: hits[t].get("count", 0) for t in topics_list}
    now = datetime.now(timezone.utc).isoformat()
    data = {
        "video_id": video_id,
        "script_theme": theme,
        "created_at": now,
        "updated_at": now,
        "target_count": len(topics_list),
        "topics": [
            {
                "topic": t,
                "count": hits[t].get("count", 0),
                "shots": list(hits[t].get("shots", [])),
            }
            for t in topics_list
        ],
        "missing_topics": [t for t in topics_list if hits[t].get("count", 0) == 0],
        "is_ready": all(hits[t].get("count", 0) > 0 for t in topics_list),
    }
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.rename(p)


def update_topic_hit(video_id: str, topic: str, shot_id: str,
                     source_path: Optional[Path] = None) -> int:
    """Bump topic count + (opcionalmente) copia shot para o bucket.
    Devolve a nova count (ou 0 se video_id não existe).

    Race-safe: serializa por video_id via _lock_for().
    """
    p = topic_topics_path(video_id)
    if not p.exists():
        log.warning("buckets: %s não init — ignoro hit", p)
        return 0
    with _lock_for(video_id):
        data = json.loads(p.read_text())
        matched = False
        new_count = 0
        for t in data["topics"]:
            if t["topic"].lower() == topic.lower() and shot_id not in t["shots"]:
                t["shots"].append(shot_id)
                t["count"] = len(t["shots"])
                new_count = t["count"]
                matched = True
                # Copy the shot to bucket if a source_path is provided
                if source_path and source_path.exists():
                    dst = bucket_shots_dir(video_id) / f"{shot_id}.mp4"
                    try:
                        shutil.copy2(source_path, dst)
                        log.info("buckets: %s/%s -> %s",
                                 video_id, topic, dst.name)
                    except OSError as exc:
                        log.warning("buckets: copy %s -> bucket falhou (%s)",
                                    source_path.name, exc)
                break
        if not matched:
            return 0
        data["missing_topics"] = [t["topic"] for t in data["topics"]
                                  if t["count"] == 0]
        data["is_ready"] = all(t["count"] > 0 for t in data["topics"])
        data["updated_at"] = datetime.now(timezone.utc).isoformat()
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        tmp.rename(p)
    return new_count


def get_progress(video_id: str) -> Optional[dict]:
    p = topic_topics_path(video_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def list_buckets() -> list[dict]:
    """Snapshot de todos os buckets conhecidos (summary rápido)."""
    out: list[dict] = []
    if not BUCKETS_ROOT.exists():
        return out
    for d in sorted(BUCKETS_ROOT.iterdir()):
        if not d.is_dir():
            continue
        prog = get_progress(d.name)
        if prog is not None:
            out.append({
                "video_id": d.name,
                "script_theme": prog.get("script_theme", ""),
                "is_ready": prog.get("is_ready", False),
                "target_count": prog.get("target_count", 0),
                "topics_with_hits": sum(1 for t in prog["topics"] if t["count"] > 0),
                "topics_total": prog.get("target_count", 0),
                "missing": prog.get("missing_topics", []),
                "updated_at": prog.get("updated_at"),
                "shots_in_bucket": sum(t["count"] for t in prog["topics"]),
            })
    return out


__all__ = [
    "BUCKETS_ROOT",
    "bucket_dir", "bucket_shots_dir",
    "init_bucket", "update_topic_hit", "get_progress",
    "list_buckets", "topic_topics_path",
]
