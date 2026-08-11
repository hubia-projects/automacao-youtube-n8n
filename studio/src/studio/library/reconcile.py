"""Bulk re-process de 908 órfãos (Task 2) — usando Tasks 3+4.

Lê mp4s em `data/library/media/*` que NUNCA foram registados no lancedb
porque o Gemini Flash bateu HTTP 429 durante analyze_shot.

Pipeline por ficheiro:
1. Checar `DedupIndex.has(source_id)` — se já ingested, skip + log
2. analyze_shot via Gemini Flash com retry+backoff (exp 2-32s + jitter)
3. SigLIP embed do keyframe
4. register_shot no lancedb
5. Se --video-id foi passado → tentar matching imperfeito de entities com
   os tópicos do bucket e atualizar `topic_topics.json`
6. dedup.add() para que runs futuras não repitam
7. Marcar mp4 em `reconcile_state.json` (atomic-write)

Estado persistido em `data/library/reconcile_state.json`:
  {
    "version": 3,
    "started_at": "...",
    "video_id": "...|null",
    "topics": [...],
    "done": [{"file": "...", "shot_id": "..."}],
    "failed": [{"file": "...", "error": "...", "retries": N}],
    "totals": {"ok": N, "skip": N, "fail": N}
  }
Em rerun, todos os "done" são ignorados → retoma de onde parou.

Uso:
    python -m studio.library.reconcile --limit 30 --dry-run
    python -m studio.library.reconcile --video-id porto-2026-08-10 \
        --topics "lello,francesinha,pontes"
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import random
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

# Imports lazy-dentro-de-função: arrancar este módulo via `python -m` sem o
# venv activo NÃO deve falhar (numpy/httpx demoram a importar); só no
# momento de processar 1 mp4 é que carregamos o que precisamos.
from studio.library.buckets import init_bucket, update_topic_hit  # noqa: E402
from studio.library.models import AssetState, AssetStateRecord  # noqa: E402

log = logging.getLogger("studio.library.reconcile")

# Repos-aware paths. O script pode ser invocado com `cd <repo> && python -m
# studio.library.reconcile` OU via `uv run --directory studio`, daí derivar do
# __file__ em vez de path relativo.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_DATA_ROOT = _REPO_ROOT / "data"
RECONCILE_STATE = _DATA_ROOT / "library" / "reconcile_state.json"
MEDIA_DIR = _DATA_ROOT / "library" / "media"
INGEST_LOG = _DATA_ROOT / "library" / "ingest_log.jsonl"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_state() -> dict:
    if not RECONCILE_STATE.exists():
        return {
            "version": 3,
            "started_at": _now_iso(),
            "video_id": None,
            "topics": [],
            "done": [], "failed": [], "skipped_duplicate": [],
            "totals": {"ok": 0, "skip": 0, "fail": 0, "cost_usd": 0.0},
        }
    try:
        s = json.loads(RECONCILE_STATE.read_text())
        if s.get("version") != 3:
            log.warning("reconcile: state version mismatch — reset")
            return {
                "version": 3, "started_at": _now_iso(),
                "video_id": None, "topics": [],
                "done": [], "failed": [], "skipped_duplicate": [],
                "totals": {"ok": 0, "skip": 0, "fail": 0, "cost_usd": 0.0},
            }
        s.setdefault("totals", {}).setdefault("cost_usd", 0.0)
        return s
    except (OSError, json.JSONDecodeError):
        return {"version": 3, "started_at": _now_iso(),
                "video_id": None, "topics": [],
                "done": [], "failed": [], "skipped_duplicate": [],
                "totals": {"ok": 0, "skip": 0, "fail": 0, "cost_usd": 0.0}}


def _save_state(state: dict) -> None:
    RECONCILE_STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = RECONCILE_STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    tmp.rename(RECONCILE_STATE)


def _source_id_for(path: Path) -> str:
    """pexels_6288293.mp4 -> pexels_6288293"""
    return path.stem


_VEC_DIM = 768   # SigLIP embedding dimension (determinístico)
_FRAMES_TMP_DIR = Path("/tmp/studio_reconcile_frames")


def _media_sha(mp4: Path) -> str:
    """SHA256 dos primeiros 64KB do ficheiro (rápido, suficiente para dedup).
    NÃO passa o ficheiro inteiro — para 908 × 100MB seria 15-30min só de hashing.
    """
    h = hashlib.sha256()
    try:
        with open(mp4, "rb") as f:
            h.update(f.read(65536))
    except OSError:
        return ""
    return h.hexdigest()


def _extract_mid_keyframe(mp4: Path, duration: float) -> Optional[Path]:
    """Extrai 1 frame JPG do meio do vídeo via ffmpeg. Cache por mtime.
    Devolve None se ffmpeg falhar."""
    _FRAMES_TMP_DIR.mkdir(parents=True, exist_ok=True)
    out = _FRAMES_TMP_DIR / f"{mp4.stem}.jpg"
    if out.exists() and out.stat().st_mtime > mp4.stat().st_mtime:
        return out
    seek = max(0.0, duration / 2.0)
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", f"{seek:.2f}",
             "-i", str(mp4), "-vframes", "1", "-q:v", "2", str(out)],
            capture_output=True, timeout=15,
        )
        if r.returncode == 0 and out.exists():
            return out
        log.warning("keyframe extract falhou %s: %s", mp4.name,
                     r.stderr.decode("utf-8", errors="replace")[:200])
        return None
    except subprocess.TimeoutExpired:
        log.warning("keyframe extract TIMEOUT para %s", mp4.name)
        return None
    except Exception as exc:
        log.warning("keyframe extract erro %s: %s", mp4.name, exc)
        return None


def _ffmpeg_probe_meta(path: Path) -> dict:
    """Extrai metadados básicos via ffprobe (dur + resolução).
    Stdout JSON parsing; empty dict se ffprobe falhar."""
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
        out = {}
        fmt = d.get("format", {})
        if fmt.get("duration"):
            out["duration"] = float(fmt["duration"])
        for s in d.get("streams", []):
            if s.get("codec_type") == "video":
                out["width"] = int(s.get("width", 0))
                out["height"] = int(s.get("height", 0))
                out["codec"] = s.get("codec_name", "")
                break
        return out
    except Exception:
        return {}


def _gemini_retry(fn: Callable, *args, **kwargs):
    """Exponential backoff com jitter (até 5 retries).
    Retry em: 429 (rate-limit), 5xx (transitório servidor), network errors.
    NÃO retry em 4xx cliente (400/401/403/404) — sinal de bug.
    Classificação refinada (code-review): 'rate' sozinho é substring demasiado
    larga (apanha 'rate of return', etc.). Usamos 'rate limit' / 'rate_limit'
    / 'ratelimitexceeded' / 'resource_exhausted'.
    """
    TRANSIENT_5XX = ("500", "502", "503", "504", "internal", "backend",
                      "unavailable", "deadline", "timeout")
    RATE_TOKENS = ("429", "resource_exhausted", "rate limit", "rate_limit",
                    "ratelimitexceeded", "too many requests", "quota")
    last = None
    for attempt in range(5):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            msg = str(exc).lower()
            is_rate = any(tok in msg for tok in RATE_TOKENS)
            is_5xx = any(tok in msg for tok in TRANSIENT_5XX)
            # Confinar 'network' a erros de socket/transport (não "timeout"
            # genérico que pode ser Gemini).
            is_network = any(tok in msg for tok in
                              ("connectionerror", "connection refused",
                               "connection reset", "network is unreachable",
                               "no route to host"))
            if is_rate or is_5xx or is_network:
                back = (2 ** attempt) + random.uniform(0, 1.0)
                log.warning("reconcile: transient (%s) attempt %d/5, sleep %.1fs",
                            "rate" if is_rate else "5xx" if is_5xx else "network",
                            attempt + 1, back)
                time.sleep(back)
                last = exc
                continue
            raise
    raise RuntimeError(f"Gemini persistent error após 5 retries: {last}")


def _process_one(mp4: Path, source_id: str, video_id: Optional[str],
                 topics: list[str], state: dict,
                 db: "LibraryDB", embedder: "SiglipEmbedder",
                 settings: "Settings",
                 *, requirement_prompts: Optional[dict] = None) -> dict:
    """Phase 6 v2 — wrapper fino sobre ingest_asset canónico (P5+P6).

    Esta função NÃO mantém pipeline paralelo próprio. Delega em
    ingest_asset(path, license, db, settings, embedder), o ÚNICO caminho
    que coloca media+metadata em LanceDB; tudo o resto (state machine,
    db.get_shot verify, fail-closed on reject, empty-media defence) vive
    em ingest_asset.

    Vantagens vs pipeline antigo:
      - 1× SceneDetect + SigLIP BATCH per file (P13+P14 já feito).
      - AssetState machine persiste progresso por media_sha (resume-friendly).
      - DB write verification via get_shot() readback (P6 fail-closed).
      - Empty-media (0 shots) → FAILED_PERMANENT (não loop retry infinito).

    `topic_hit` detectado POST-ingest via DB lookup para aproveitarmos
    a metadata completa do pipeline canónico (places+landmarks+food
    consolidados por shot).
    """
    from studio.library.ingest_asset import ingest_asset, make_orphan_license

    orphan_lic = make_orphan_license(
        source_id=f"orphan:{source_id}",
        attribution_text=f"reconciled-from-orphan ({mp4.name})",
    )
    try:
        result, asset_state = ingest_asset(
            mp4, orphan_lic, db, settings, embedder,
            source_id=source_id, video_id=video_id,
            requirement_prompts=requirement_prompts,
        )
    except Exception as exc:
        # Last-ditch: ingest_asset não devolveu (não deveria acontecer
        # dado que tem try/except interno). Fabricamos record FAILED_RETRYABLE
        # E persistimos no AssetStateStore sidecar (código-review ALTA:
        # observability preservada — sidecar JSON não fica vazio).
        log.error("_process_one: ingest_asset exception %s: %s",
                  mp4.name, exc)
        from studio.library.ingest_asset import _path_based_id
        from studio.library.models import AssetStateStore
        asset_state = AssetStateRecord(
            media_sha=_path_based_id(mp4),
            source_path=str(mp4),
            state=AssetState.FAILED_RETRYABLE,
            last_error=f"_process_one raised: {exc.__class__.__name__}: {exc}",
            source_id=source_id, video_id=video_id,
        )
        try:
            AssetStateStore().save(asset_state, force_transition=True)
        except Exception as save_exc:
            log.debug("AssetStateStore.save fallback falhou: %s",
                      save_exc.__class__.__name__)
        result = None

    topic_hit = None
    if (video_id and topics
            and asset_state.state == AssetState.DONE
            and result is not None
            and result.media_sha):
        topic_hit = _match_topic_in_db(db, result.media_sha, topics)

    return {
        "asset_state": asset_state,
        "result": result,
        "topic_hit": topic_hit,
    }


def _match_topic_in_db(db: "LibraryDB", media_sha: str,
                       topics: list[str]) -> Optional[str]:
    """Phase 6 — topic_match via DB lookup pós-ingest (mais rico que o
    match no nome do ficheiro do run antigo).

    Consolida metadata de TODOS os shots registados com este media_sha
    (places + landmarks + food) e procura substrings dos topics. Beneficiamos
    da análise Gemini Flash completa, não apenas do nome do mp4.
    """
    try:
        rows = (db._table.search()
                .where(f"media_sha = '{media_sha}'")
                .limit(50)
                .to_list())
    except Exception as exc:
        log.debug("_match_topic_in_db falhou: %s", exc)
        return None
    if not rows:
        return None
    low_blob = " ".join(
        (r.get("summary", "") + " " + r.get("places_csv", "") + " "
         + r.get("landmarks_csv", "") + " " + r.get("food_csv", ""))
        for r in rows
    ).lower().replace("-", "").replace("_", "").replace(" ", "")
    for t in topics:
        norm_t = t.lower().replace("-", "").replace("_", "").replace(" ", "")
        if norm_t and norm_t in low_blob:
            return t
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--video-id", default=None)
    ap.add_argument("--topics", default=None,
                    help="CSV de tópicos para bucket + match")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reset-video-id", action="store_true",
                    help="Substituir video_id/tópicos já gravados em state "
                         "pelos passados via CLI neste run")
    ap.add_argument("--workflow", default=None,
                    help="PHASE 1 (topic-driven): carregar workflow de "
                         "data/library/workflows/<id>.json. Sem este flag, "
                         "comportamento legacy (processa tudo indiferenciadamente).")
    ap.add_argument("--maintenance-library-only", action="store_true",
                    help="Modo admin: processa biblioteca SEM active video. "
                         "EXCLUSIVO com --workflow. Para uso de maintenance "
                         "de inventory (não batch de produção).")
    ap.add_argument("--no-prefilter", action="store_true",
                    help="DEPRECATED: pre-filter já é opt-in via --lazy-filter. "
                         "Este flag fica para retro-compat; não faz nada.")
    ap.add_argument("--lazy-filter", action="store_true",
                    help="OPT-IN: em --workflow, filtra por substring do nome "
                         "do ficheiro. Default é OFF (porque 908 órfãos têm "
                         "filenames hash do Pexels, sem keywords do topic).")
    ap.add_argument("--force-redo-done", action="store_true",
                    help="TEST-ONLY: limpa state[\"done\"] em memória antes do "
                         "loop, permitindo reprocessar mp4 já DONE em runs "
                         "anteriores. NÃO toca no state.json persistido até o "
                         "loop confirmar novo resultado DONE. Para dev/test "
                         "apenas; em prod use --reset-video-id + clear state.")
    args = ap.parse_args()

    # UPSTREAM-CHANGE 2026-08-11 §D: reconcile de produção exige
    # EXACTAMENTE um dos dois modos:
    #   --workflow <id>             → produção, linkage ao active workset
    #   --maintenance-library-only  → admin, processa sem vídeo (fail-loud)
    # Sem qualquer um dos dois, ERROR fail-closed (não aceita "reconcile
    # sem rumo"). Esta regra impede os runs de 5 dias.
    # UPSTREAM-CHANGE 2026-08-11 §P5: inicializar requirement_prompts
    # no topo da main() para estar em scope no call site de _process_one.
    # Em --workflow porto-essencia-001 será populated pela WORKSET LOAD;
    # em --maintenance-library-only fica vazio (legacy fallback per-shot).
    requirement_prompts: dict[str, str] = {}
    if not args.workflow and not args.maintenance_library_only:
        log.error(
            "reconcile: production reconcile requires EXACTLY one of:\n"
            "  --workflow <video_id>          (active video production)\n"
            "  --maintenance-library-only     (admin inventory only)\n"
            "Refusing to run without an active scope — ver task 2026-08-11 §D."
        )
        log.error(
            "Crie workflow primeiro com: studio workflows create --video-id "
            "<id> --theme '<text>' --topics 't1,t2,...'.")
        return 2
    if args.workflow and args.maintenance_library_only:
        log.error(
            "reconcile: --workflow e --maintenance-library-only são "
            "MUTUAMENTE EXCLUSIVOS. Decida um modo."
        )
        return 2

    from studio.library.dedup import DedupIndex
    from studio.library.db import LibraryDB
    from studio.library.embed import SiglipEmbedder
    from studio.config import get_settings
    dedup = DedupIndex()

    # Pipeline real: LibraryDB (write-locked) + SiglipEmbedder (Singleton FIFO)
    # + Settings (Gemini+API keys). Falha em import = abort fail-closed (não
    # procesamos nada sem tools carregados).
    db = LibraryDB(MEDIA_DIR.parent)  # data/library/
    embedder = SiglipEmbedder()
    settings = get_settings()
    log.info("reconcile: LibraryDB + SiglipEmbedder + Settings prontos")

    # PHASE 1 — Workflow-driven mode (--workflow <id>): carrega workflow.json
    # que define tema + target_topics + meta_coverage. Se já existir bucket
    # com is_ready=true, abort fail-closed (a meta já está coberta).
    workflow_data = None
    if args.workflow:
        from studio.library.buckets import read_workflow, get_progress
        workflow_data = read_workflow(args.workflow)
        if not workflow_data:
            log.error("--workflow %s mas workflow.json não existe em "
                      "data/library/workflows/", args.workflow)
            return 2
        # Só sobrescreve args.video_id/args.topics se NÃO foram passados
        if not args.video_id:
            args.video_id = workflow_data["video_id"]
        if not args.topics:
            args.topics = ",".join(t["name"] for t in workflow_data["target_topics"])
        log.info("workflow '%s': tema='%s'  target_topics=%d  meta=%d/%d",
                 args.workflow, workflow_data.get("theme", ""),
                 len(workflow_data.get("target_topics", [])),
                 workflow_data.get("meta_coverage", {}).get("covered", 0),
                 workflow_data.get("meta_coverage", {}).get("required", 0))
        # Fail-closed early: bucket já com is_ready de iteração anterior
        prog = get_progress(args.workflow) or get_progress(args.video_id)
        if prog and prog.get("is_ready"):
            log.info("workflow '%s' bucket já está is_ready — abort "
                     "(meta atingida anteriormente, retomar manualmente se preciso).",
                     args.workflow)
            return 0

    state = _load_state()
    if args.video_id and not state.get("video_id"):
        state["video_id"] = args.video_id
        state["topics"] = [t.strip() for t in (args.topics or "").split(",")
                           if t.strip()]
        state.setdefault("_coverage_progress", [])
        state.setdefault("_confirmed_index", {})
        state.setdefault("_coverage_plan", None)
        _save_state(state)
    video_id = state.get("video_id") or args.video_id
    topics = state.get("topics") or []

    # Init bucket: usa theme do workflow se disponível
    bucket_theme = "auto-reconcile"
    if workflow_data:
        bucket_theme = workflow_data.get("theme", bucket_theme)
    if video_id and topics:
        init_bucket(video_id, script_theme=bucket_theme, topics=topics)

    # UPSTREAM-CHANGE 2026-08-11 §F: workset visual_requirements.json é a
    # FONTE CANÓNICA de requirements. Workflow.target_topics[*] mantido
    # para retro-compat mas funciona como hint/override (apenas nomes).
    # Resolve em ordem: workset > workflow.target_topics > vazio.
    if workflow_data:
        spans_source = "workset/visual_requirements.json"
        spans = []
        # UPSTREAM-CHANGE 2026-08-11 §D: production reconcile é
        # FAIL-CLOSED em workset ausente/inválido. workflow.target_topics
        # é apenas hint retro-compat (sem t_in/t_out, sem coverage). Para
        # --workflow em produção, workset/visual_requirements.json é
        # OBRIGATÓRIO — não cai em fallback.
        work_vr = _load_workset_visual_requirements(args.workflow)
        if not work_vr or not work_vr.get("requirements"):
            log.error(
                "reconcile: --workflow '%s' mas workset/visual_requirements.json "
                "ausente ou vazia em data/library/worksets/%s/. "
                "REFUSING to run (production fail-closed per task §D 2026-08-11). "
                "Corrige: cria ou popula workset/visual_requirements.json com "
                "canonical_entity/required_seconds/target_seconds/min_distinct_shots.",
                args.workflow, args.workflow,
            )
            return 1   # SystemExit equivalente a fail-closed em main()
        log.info("workset visual_requirements canonical para %s: %d entities",
                 args.workflow, len(work_vr["requirements"]))
        for req in work_vr["requirements"]:
            from studio.script.entities import EntitySpan, _slug
            # UPSTREAM-CHANGE 2026-08-11 §D: preserva EXACTAMENTE os
            # valores do JSON (não recalcula target_seconds/min_distinct_shots/
            # narration_t_in/_out/aliases). Defaults são apenas safety net se
            # o caller esqueceu um campo — log warning.
            canonical = req.get("canonical_entity", "")
            if not canonical:
                log.warning("workset/visual_requirements.json: req sem "
                            "canonical_entity — skip (key=%r)",
                            req.get("requirement_id", "?"))
                continue
            target_s = float(req.get("target_seconds", 0.0) or 0.0)
            min_shots = int(req.get("min_distinct_shots", 1) or 1)
            if target_s <= 0:
                log.warning("workset/visual_requirements.json: req '%s' "
                            "target_seconds<=0 (got %.2f) — coverage gate "
                            "vai sinalizar PARTIAL.", canonical, target_s)
            if min_shots <= 0:
                log.warning("workset/visual_requirements.json: req '%s' "
                            "min_distinct_shots<=0 (got %d) — coerce a 1.",
                            canonical, min_shots)
                min_shots = 1
            spans.append(EntitySpan(
                entity_id=f"workset_{slug(canonical)}:{(req.get('requirement_id') or '0000')}",
                canonical_name=canonical,
                entity_type=req.get("entity_type", "place") or "place",
                t_in=float(req.get("narration_t_in", 0.0) or 0.0),
                t_out=float(req.get("narration_t_out", 0.0) or 0.0),
                text=canonical,
                aliases=list(req.get("aliases", []) or []),
                importance=1.0,
                strict_visual=bool(req.get("strict", False)),
                location_context=req.get("location", "") or "",
            ))
        # UPSTREAM-CHANGE 2026-08-11 §P5: construir requirement_prompts
        # dict[canonical_entity -> text_en] UMA VEZ (caller do loop).
        # Cada text_en = canonical + aliases + location em inglês — SigLIP
        # text tower é EN-only (ADR-0003).
        requirement_prompts = _build_requirement_prompts(work_vr)
        log.info("reconcile: requirement_prompts pronto (%d entities) "
                 "para SigLIP triage no ingest", len(requirement_prompts))
        try:
            from studio.matching.coverage_plan import build_coverage_plan
            if spans:
                plan = build_coverage_plan(
                    spans, db, settings,
                    topic=workflow_data.get("theme", ""),
                )
                state["_coverage_plan"] = plan
                state["_confirmed_index"] = {}
                state["_visual_requirements_source"] = spans_source
                _save_state(state)
                log.info(
                    "coverage_plan carregado: %d entities (source=%s, "
                    "workflow='%s')", len(plan.ranked_entities), spans_source,
                    args.workflow,
                )
        except Exception as exc:
            log.warning(
                "coverage_plan load falhou (não fatal) — "
                "reconcile prossegue sem gate autoritativo: %s",
                exc.__class__.__name__)

    already_done = {d["file"] for d in state["done"]}
    already_failed_files = {f["file"] for f in state["failed"]}
    # UPSTREAM-CHANGE 2026-08-11 §T1: --force-redo-done TEST-ONLY. NÃO
    # persistimos a limpeza — o reconcile original adiciona novos done a
    # state[\"done\"]; com flag activa, começamos com lista vazia em memória
    # para esta run apenas (state.json mantém-se intacto até _save_state).
    if args.force_redo_done:
        log.warning("--force-redo-done ACTIVE: ignorando state[\"done\"] em "
                    "memória (apenas este run); state.json será actualizado "
                    "no fim do loop com novos done entries")
        already_done = set()
    candidates = sorted(
        mp4 for mp4 in MEDIA_DIR.iterdir()
        if mp4.suffix.lower() == ".mp4"
        and mp4.name not in already_done
        and mp4.name not in already_failed_files
    )
    if args.limit:
        candidates = candidates[:args.limit]
    # PHASE 1 — Cheap pre-filter OPT-IN (default OFF).
    # Os mp4 órfãos têm filenames tipo hash do Pexels (`00a47a9...47d.mp4`), sem
    # keywords do topic. Aplicar pre-filter por substrings do nome=drop-out 100%.
    # Em vez disso, confiamos em Gemini Vision (places_csv/landmarks_csv) para
    # tagagem, + is_ready stop quando a meta do workflow é atingida.
    if args.workflow and topics and getattr(args, "lazy_filter", False):
        norm_topics = [t.lower().replace("-", "").replace("_", "").replace(" ", "")
                       for t in topics if t.strip()]
        candidates = [m for m in candidates if any(
            nt and nt in m.name.lower().replace("-", "").replace("_", "").replace(" ", "")
            for nt in norm_topics
        )]
        log.info("workflow LAZY pre-filter: %d/%d ficheiros passam (user opt-in)",
                 len(candidates), len(norm_topics))
    total_today = len(candidates)
    total_ever = total_today + len(already_done)
    log.info("reconcile: candidatos=%d  já done=%d  já fail=%d  total_pool=%d",
             total_today, len(already_done), len(already_failed_files), total_ever)

    n_ok = n_skip = n_fail = 0
    for i, mp4 in enumerate(candidates):
        sid = _source_id_for(mp4)
        # UPSTREAM-CHANGE 2026-08-11 §T2: --force-redo-done também bypassa
        # dedup.has(sid) (LanceDB provider_cache). Sem isto, candidatos
        # recém-extraídos do filesystem mas já na dedup_index por runs
        # anteriores ficam SKIP_DUP antes de chegar a _process_one, e a
        # arquitectura nova (Gemini batch / SigLIP triage) nunca corre.
        # Em prod, --force-redo-done NUNCA é invocado; em dev/test, este
        # bypass é semanticamente equivalente a "rebuild from scratch".
        if dedup.has(sid) and not args.force_redo_done:
            log.info("[%d/%d] SKIP duplicado (dedup): %s", i + 1, total_today, sid)
            state["skipped_duplicate"].append({"file": mp4.name, "source_id": sid})
            n_skip += 1
            state["totals"]["skip"] += 1
            continue
        if args.dry_run:
            log.info("[%d/%d] DRY: %s", i + 1, total_today, sid)
            continue

        log.info("[%d/%d] a processar: %s", i + 1, total_today, sid)
        try:
            # Sempre pipeline real (Gemini + SigLIP + register_shot); sem
            # branch stub — user pediu dados reais e resiliência em retries.
            res = _process_one(mp4, sid, video_id, topics, state,
                                db, embedder, settings,
                                requirement_prompts=requirement_prompts)
            # Separar sucesso de falha por analyze.status + register_error
            # (code-review ALTA sequencial): falhas NÃO devem contar como ok,
            # NÃO devem entrar em dedup (para permitir retry em runs futuras).
            # register_error marca o caso "analyze OK mas LanceDB recusou" —
            # não está em lancedb; reportar como done seria FALSO.
            # Phase 6 v2 — outcomes baseados em AssetState enum (canónica
            # da state machine — studio.library.models). Mapeamento:
            #   DONE              → state["done"] (verificado por db.get_shot)
            #   FAILED_RETRYABLE  → state["failed"] retryable=True
            #   FAILED_PERMANENT  → state["failed"] retryable=False
            #                       (license rejeitada, empty_media, codec bad)
            #   outros            → unexpected_log + retryable=True
            asset_state = res.get("asset_state")
            cost_usd = (res["result"].cost_usd
                        if res.get("result") else 0.0) or 0.0
            if (asset_state is not None
                    and asset_state.state == AssetState.DONE):
                # Sucesso VERIFICADO (db.get_shot() readback OK).
                # dedup.add PRIMEIRO (file-review fix #4 — não-swallow).
                dedup.add(sid, media_sha="", status="reconciled-from-orphan")
                state["done"].append({
                    "file": mp4.name,
                    "source_id": sid,
                    "at": _now_iso(),
                    "asset_state": "DONE",
                    "topic_hit": res.get("topic_hit"),
                    "cost_usd": cost_usd,
                })
                n_ok += 1
                state["totals"]["ok"] += 1
                state["totals"]["cost_usd"] = state["totals"].get(
                    "cost_usd", 0.0) + float(cost_usd)
                log.info("[%d/%d] ✓ DONE: %s cost=$%.4f",
                         i + 1, total_today, sid, cost_usd)
                if res.get("topic_hit") and video_id:
                    update_topic_hit(video_id, res["topic_hit"], sid, mp4)
                    # UPSTREAM-CHANGE 2026-08-11 §B: bucket.is_ready era
                    # o gate de STOP. Agora is_workset_ready() é a única
                    # fonte autoritativa. Bucket fica como observer cheap.
                    try:
                        from studio.library.buckets import get_progress
                        prog = get_progress(video_id)
                        if prog and prog.get("is_ready"):
                            # Bucket indica “topics todos com count>0”,
                            # mas é sinal de observability (escalar de 0→1
                            # cobertura de tópicos). FONTE AUTORITATIVA
                            # vem de is_workset_ready() abaixo.
                            log.debug(
                                "[%d/%d] bucket.is_ready atingido (tracker "
                                "cheap); a confirmar via is_workset_ready "
                                "…", i + 1, total_today)
                    except Exception as exc:
                        log.debug("is_ready bucket check skip: %s", exc)
                    # FONTE AUTORITATIVA — chamada após cada asset DONE
                    # se o video_id tem um plano carregado. Quando
                    # ready=True, TERMINA a run antes de continuar a
                    # processar o pool (regra §B).
                    try:
                        if workflow_data and state.get("_coverage_plan"):
                            from studio.matching.coverage_plan import (
                                is_workset_ready,
                            )
                            plan = state["_coverage_plan"]
                            ready, per_st, _ = is_workset_ready(
                                plan, db, settings,
                                confirmed_index=state.get(
                                    "_confirmed_index", {}) or None,
                                # UPSTREAM-CHANGE 2026-08-11 (code-reviewer #4):
                                # remeasure=True é obrigatório aqui porque
                                # `_per_shot_durations` é PrivateAttr e não
                                # serializa em plan.model_dump_json(). Sem
                                # remeasure, strict_available_seconds fica 0
                                # em qualquer restart a partir de state.json.
                                remeasure=True,
                            )
                            # UPSTREAM-FIX (code-reviewer #2): cap do
                            # _coverage_progress a últimas 50 entries
                            # (~10KB cada) para não inchar o state.json
                            # após 900 assets (9MB).
                            prog_list = state["_coverage_progress"]
                            prog_list.append({
                                "asset": i + 1, "file": mp4.name,
                                "per_status": per_st, "ready": ready,
                                "at": _now_iso(),
                            })
                            if len(prog_list) > 50:
                                state["_coverage_progress"] = (
                                    prog_list[-50:])
                            # totals agregados — sempre disponíveis
                            state["_coverage_latest"] = {
                                "asset": i + 1, "file": mp4.name,
                                "per_status": per_st, "ready": ready,
                                "at": state["_coverage_progress"][-1]["at"],
                            }
                            if ready:
                                log.info(
                                    "[%d/%d] 🎯 is_workset_ready atingido "
                                    "('%s'); STOP ACTIVE VIDEO PREPARATION. "
                                    "Restantes ficam PENDING_LIBRARY_ENRICHMENT.",
                                    i + 1, total_today, video_id)
                                _save_state(state)
                                _log_finished_event(n_ok, n_skip, n_fail,
                                                     video_id, topics)
                                return 0
                    except Exception as exc:
                        # is_workset_ready não pode bloquear reconcile.
                        # Log debug; bucket.is_ready já dá sinal barato.
                        log.debug("is_workset_ready check skip: %s (%s)",
                                  exc.__class__.__name__, str(exc)[:120])
                # Throttling entre chamadas Gemini (code-review MED).
                time.sleep(1.5)
            elif (asset_state is not None
                  and asset_state.state == AssetState.FAILED_RETRYABLE):
                log.warning("[%d/%d] ⚠ FAILED_RETRYABLE: %s (%s)",
                            i + 1, total_today, sid,
                            (asset_state.last_error or "")[:120])
                state["failed"].append({
                    "file": mp4.name,
                    "source_id": sid,
                    "status": "transient_failed",
                    "error": asset_state.last_error,
                    "retryable": True,
                    "at": _now_iso(),
                })
                n_fail += 1
                state["totals"]["fail"] += 1
                # NÃO chamar dedup.add (mantém retriable em runs futuras).
                # NÃO chamar time.sleep(1.5) — falhas não tocam Gemini.
            elif (asset_state is not None
                  and asset_state.state == AssetState.FAILED_PERMANENT):
                err = (asset_state.last_error or "").lower()
                if "license" in err:
                    status = "license_rejected"
                elif "empty_media" in err:
                    status = "empty_media"
                else:
                    status = "failed_permanent"
                log.warning("[%d/%d] ✗ FAILED_PERMANENT: %s [%s] (%s)",
                            i + 1, total_today, sid, status,
                            (asset_state.last_error or "")[:120])
                state["failed"].append({
                    "file": mp4.name,
                    "source_id": sid,
                    "status": status,
                    "error": asset_state.last_error,
                    "retryable": False,
                    "at": _now_iso(),
                })
                n_fail += 1
                state["totals"]["fail"] += 1
                # NÃO chamar dedup.add — pode ser retentado se license
                # upgradada ou mp4 substituído. Throttling OK porque
                # FAILED_PERMANENT não tocou Gemini.
                time.sleep(1.5)
            else:
                log.error(
                    "[%d/%d] UNEXPECTED asset_state=%s — log + skip",
                    i + 1, total_today,
                    asset_state.state if asset_state else None,
                )
                state["failed"].append({
                    "file": mp4.name,
                    "source_id": sid,
                    "status": "unexpected_state",
                    "error": f"unexpected AssetState: "
                             f"{asset_state.state.value if asset_state else None}",
                    "retryable": True,
                    "at": _now_iso(),
                })
                n_fail += 1
                state["totals"]["fail"] += 1
        except KeyboardInterrupt:
            log.warning("reconcile: KeyboardInterrupt — gravando state e saindo")
            _save_state(state)
            with INGEST_LOG.open("a") as f:
                f.write(json.dumps({
                    "at": _now_iso(),
                    "event": "reconcile_aborted",
                    "processados_neste_run": n_ok,
                    "restantes": total_today - i - 1,
                }) + "\n")
            return 130
        except Exception as exc:
            log.error("[%d/%d] FALHA %s: %s", i + 1, total_today, sid, exc)
            state["failed"].append({"file": mp4.name, "erro": str(exc),
                                    "at": _now_iso()})
            n_fail += 1
            state["totals"]["fail"] += 1

        # Persist state every 5 entries + fade-during-run safety
        if (i + 1) % 5 == 0:
            _save_state(state)

    _save_state(state)
    _log_finished_event(n_ok, n_skip, n_fail, video_id, topics)
    log.info("reconcile: DONE  ok=%d  skip=%d  fail=%d  total_in_state=%d",
             n_ok, n_skip, n_fail, len(state["done"]))
    return 0 if n_fail == 0 else 2


def _log_finished_event(n_ok: int, n_skip: int, n_fail: int,
                        video_id: Optional[str], topics: list[str]) -> None:
    """Escreve evento reconcile_finished no ingest_log. Extraído para não
    duplicar o bloco no early-return is_ready e no fim do main()."""
    try:
        INGEST_LOG.parent.mkdir(parents=True, exist_ok=True)
        with INGEST_LOG.open("a") as f:
            f.write(json.dumps({
                "at": _now_iso(),
                "event": "reconcile_finished",
                "video_id": video_id,
                "topics": topics,
                "ok": n_ok, "skip": n_skip, "fail": n_fail,
            }) + "\n")
    except OSError as exc:
        log.warning("ingest_log write falhou: %s", exc)


def _build_requirement_prompts(work_vr: dict) -> dict[str, str]:
    """UPSTREAM-CHANGE 2026-08-11 §P5: construir dict[canonical_entity
    -> text_en] para SigLIP triage pré-Gemini.

    Cada text_en = canonical + entity_type + location + aliases (EN).
    SigLIP text tower é EN-only (ADR-0003) — qualquer token não-EN degrada
    o coseno drasticamente. Em revisão futura, podem usar-se traduções
    automáticas PT→EN; por agora os canonical_entities já são nomes
    latinizados (Lello, Francesinha, Sao Bento) aceitáveis para SigLIP.

    Args:
        work_vr: dict carregado de workset/visual_requirements.json.

    Returns:
        dict[canonical_entity -> "text_en composto"]. vazio se work_vr
        malformado.
    """
    out: dict[str, str] = {}
    for req in work_vr.get("requirements", []):
        if not isinstance(req, dict):
            continue
        canon = (req.get("canonical_entity") or "").strip()
        if not canon:
            continue
        parts: list[str] = [canon]
        et = (req.get("entity_type") or "").strip()
        if et:
            parts.append(et)
        loc = (req.get("location") or "").strip()
        if loc:
            parts.append(loc)
        for alias in (req.get("aliases") or []):
            if not alias:
                continue
            a = str(alias).strip()
            if a and a.lower() != canon.lower():
                parts.append(a)
        text_en = " ".join(parts).strip()
        if text_en:
            out[canon] = text_en
    return out


def _load_workset_visual_requirements(workflow_id: str) -> Optional[dict]:
    """UPSTREAM-CHANGE 2026-08-11 §F: resolver visual_requirements.json do
    workset como FONTE CANÓNICA. Hierarchy de paths tentados:
      1. data/library/worksets/<workflow_id>/visual_requirements.json
      2. data/library/worksets/<workflow_id>.json (legado standalone)
    Retorna None se nemhum path existir OU JSON inválido.

    O schema canonical:
      {"requirements": [{"canonical_entity", "entity_type",
                         "strict", "required_seconds", "target_seconds",
                         "min_distinct_shots", "narration_t_in", ...}]}
    """
    candidates = [
        _DATA_ROOT / "library" / "worksets" / workflow_id
                  / "visual_requirements.json",
        _DATA_ROOT / "library" / "worksets" / f"{workflow_id}.json",
    ]
    for p in candidates:
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "requirements" in data:
                return data
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("_load_workset_visual_requirements: %s ilegível (%s)",
                        p, exc.__class__.__name__)
    return None


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    sys.exit(main())
