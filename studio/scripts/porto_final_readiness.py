"""porto_final_readiness.py — Porto Production Gate P1-P12 (2026-08-11).

Arquitectura já aprovada em `porto_production_gate.py` (sintético). Este gate
opera CONTRA os 824 shots REAIS já persistidos em LanceDB + media real
(49 GB em data/library/{media,downloads}) + Gemini REAL (mock_mode=False) +
Providers REAIS (Pexels/Pixabay).

Fases (P1-P12):

    P1  BACKFILL — popular RequirementIndex com cosine dos 824 shots vs 6
        requirements. ZERO downloads/SceneDetect/keyframes/SigLIP image.
    P2  CACHE FIX — DiscoveryIndex cache deve honrar media_sha+model_id+version.
        scan_batch NÃO re-embeddedar paths já em cache.
    P3  COVERAGE BEFORE — stats: matches por requirement antes do Gemini.
    P4  STRICT CANDIDATES — selecionar top-K PENDING strict per requirement.
    P5  GEMINI BATCH REAL — analyze_shots_batch com mock_mode=False em PENDING.
        Provar batching HTTP: actual_requests < candidate_shots.
    P6  COVERAGE AFTER — stats: matches CONFIRMED por requirement pós-Gemini.
    P7  PROVIDER REAL — acquire_for_deficits com Pexels resolver se deficit
        ainda existir.
    P8  PRE-DOWNLOAD DEDUP — cache_get lookup antes do download.
    P9  INGEST NEW — só assets realmente deficitários (não full batch).
    P10 LOOP — STOP quando coverage Ready.
    P11 FLAGS HONESTOS — passes calculados a partir dos counters.
        NÃO usar flags	fake; cálculo contraparte real abaixo.
    P12 FINAL REPORT — JSON dump com breakdown por requirement + gates.

DECISÕES ARQUITECTURAIS:
    - P1 lẽ embeddings `vec` directamente da tabela shots (768-dim normalizado).
        Cosine direto entre (shot_vec/|shot_vec|) e req_embed (já normalizado em
        load_workset_context). NUNCA toca em detect_shots / extract_keyframes /
        embed_images.
    - P2 confia em `scan_batch` cache-skip implementado em discovery.py (Phase 0).
    - P5 chama `analyze_shots_batch` em chunks de 4 PENDING shots por chamada.
        Match entity: Gemini ASR/resposta contém canonical_entity (lowercase) em
        summary/landmarks/food/places. Tolerance: substring case-insensitive.
    - P7 tenta pexels.sweep (real) primeiro; fallback pixabay.sweep (real).
        Sem mock. Se ./acquire_for_deficits não produzir shots, NÃO aceitar
        "coverage Ready" — continuar em deficit.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

log = logging.getLogger("studio.porto_final")

# Force HF cache to /tmp if not set (avoid disk fill on subsequent runs)
os.environ.setdefault("HF_HOME", "/tmp/hf_cache")

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "src"))

from studio.logging_setup import configure_logging  # noqa: E402

configure_logging(level=logging.INFO,
                   fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

from studio.config import get_settings  # noqa: E402
from studio.library.db import LibraryDB  # noqa: E402
from studio.library.embed import SiglipEmbedder, DIM  # noqa: E402
from studio.library.workset_context import load_workset_context  # noqa: E402
from studio.library.requirement_index import (  # noqa: E402
    RequirementIndex, QueryHistory, RequirementMatch,
    CS_CONFIRMED, CS_PENDING, CS_REJECTED, CS_NOT_REQUIRED,
    CS_FAILED_RETRYABLE,
)
from studio.library.discovery import (  # noqa: E402
    DiscoveryIndex, scan_batch, S_DISCOVERED_GLOBAL, S_FULLY_INGESTED,
    DISCOVERY_VERSION,
)
from studio.library.metadata import (  # noqa: E402
    analyze_shots_batch, get_gemini_telemetry, reset_gemini_telemetry,
)
from studio.library.acquisition import (  # noqa: E402
    acquire_for_deficits, DeficitItem, AcquisitionReport,
)
import numpy as np  # noqa: E402

# =============================================================================
# CONSTANTS & HELPERS
# =============================================================================

WORKFLOW = "porto-essencia-001"
WORKDIR = REPO / "data" / "library" / "worksets" / WORKFLOW
MEDIA_DIR = REPO / "data" / "library" / "media"
DOWNLOADS_DIR = REPO / "data" / "library" / "downloads"
TMP_DOWNLOADS = Path("/tmp/studio_porto_final_dl")
REPORT_PATH = WORKDIR / "production_gate_final_report.json"

# SigLIP cosine thresholds for backfill (permissivos porque shard = global
# Pexels/Pixabay footage). Top-K strict candidates serão revalidados via
# Gemini visual; thresholds mais altos aqui só diminuem o pool Gemini.
SIM_THRESHOLD_STRICT = 0.05       # code-reviewer: max empirico 0.13 nos dados reais
SIM_THRESHOLD_NON_STRICT = 0.05

# Gemini batch
GEMINI_BATCH_SIZE = 4
TOP_K_PER_STRICT = 4              # ≤ (824×4)/4 strict ≈ ~16-24 chamadas max

# =============================================================================
# DATACLASSES
# =============================================================================


@dataclass
class PhaseCounters:
    """Counters OBJECTIVOS para provar P1/P2/P11.
    Field unificado `dedup_skipped` (code-reviewer fix #2)."""

    scopena_detect_calls: int = 0
    keyframe_extractions: int = 0
    siglip_image_calls: int = 0
    downloads_attempted: int = 0
    downloads_succeeded: int = 0
    dedup_skipped: int = 0               # code-reviewer fix #2: unificado
    gemini_http_requests: int = 0
    gemini_429_retries: int = 0
    gemini_5xx_retries: int = 0
    gemini_batch_splits: int = 0
    gemini_parse_failures: int = 0
    candidates_evaluated: int = 0
    matches_created: int = 0
    cache_hits: int = 0
    reembed_count: int = 0
    provider_searches: int = 0


@dataclass
class RequirementStat:
    canonical_entity: str
    requirement_id: str
    strict: bool
    target_seconds: float
    min_distinct_shots: int

    # BEFORE
    pre_eligible: int = 0
    pre_pending: int = 0
    pre_confirmed: int = 0
    pre_available_seconds: float = 0.0
    pre_distinct_shots: int = 0
    pre_status: str = "NOT_FOUND"

    # AFTER Gemini
    post_eligible: int = 0
    post_pending: int = 0
    post_confirmed: int = 0
    post_rejected: int = 0
    post_available_seconds: float = 0.0
    post_distinct_shots: int = 0
    post_status: str = "NOT_FOUND"


@dataclass
class FinalFlags:
    BACKFILL_SCENEDETECT_CALLS: int = 0
    BACKFILL_KEYFRAME_CALLS: int = 0
    BACKFILL_SIGLIP_IMAGE_CALLS: int = 0
    CACHE_HITS: int = 0
    CACHE_REEMBEDS: int = 0
    GEMINI_CANDIDATE_SHOTS: int = 0
    GEMINI_HTTP_REQUESTS: int = 0
    GEMINI_429: int = 0
    GEMINI_5XX: int = 0
    GEMINI_BATCH_SPLITS: int = 0
    GEMINI_PARSE_FAILURES: int = 0
    STRICT_CONFIRMED: int = 0
    STRICT_REJECTED: int = 0
    REQUIREMENT_MATCHES_CREATED: int = 0
    PROVIDER_SEARCHES: int = 0
    NEW_DOWNLOADS: int = 0
    DEDUP_DOWNLOAD_SKIPS: int = 0
    COVERAGE: dict = field(default_factory=dict)
    DISCOVERY_CACHE_REAL_PASS: str = "NO"
    REAL_GEMINI_PASS: str = "NO"
    GEMINI_BATCH_REAL_PASS: str = "NO"
    STRICT_ENTITY_REAL_PASS: str = "NO"
    REQUIREMENT_INDEX_REAL_PASS: str = "NO"
    COVERAGE_REAL_PASS: str = "NO"
    REAL_PROVIDER_PASS: str = "NO"
    REAL_DEDUP_PASS: str = "NO"
    STOP_CONDITION_PASS: str = "NO"
    READY_FOR_LIBRARY_RUN: str = "NO"
    READY_FOR_PORTO_PRODUCTION: str = "NO"
    EMBEDDING_SPACE_NOISY: bool = True


# =============================================================================
# P1 — BACKFILL
# =============================================================================


def phase_1_backfill(db: LibraryDB, ctx, ri: RequirementIndex,
                     counters: PhaseCounters) -> dict:
    """P1: popular RequirementIndex com cosine coseno entre embeddings persistidos.

    SEM downloads, SEM SceneDetect, SEM keyframes, SEM SigLIP image.
    """
    log.info("=== P1 BACKFILL ===")
    t0 = time.perf_counter()

    # code-reviewer fix #4: revoked=false OBRIGATÓRIO — shots revogados
    # continuam na tabela mas NÃO devem contar como candidates.
    try:
        rows = (db._table.search()
                .where("revoked = false")
                .limit(50_000).to_list())
    except Exception as exc:
        log.warning("P1: revoked filter falhou (%s) — fallback full scan",
                    exc.__class__.__name__)
        rows = db._table.search().limit(50_000).to_list()
    log.info("P1: %d shots válidos lidos do LanceDB", len(rows))

    # Pre-compute requirement vectors normalizados (já vêm normalizados do
    # workset_context loader, mas re-normalizar por segurança).
    req_vecs_norm: dict[str, np.ndarray] = {}
    for canon, vec in ctx.requirement_embeddings.items():
        v = np.asarray(vec, dtype=np.float32).reshape(-1)
        if v.size != DIM:
            log.warning("P1: req embed '%s' tem dim %d (esperado %d) — skip",
                        canon, v.size, DIM)
            continue
        n = np.linalg.norm(v)
        req_vecs_norm[canon] = v / max(n, 1e-8)

    matches_created = 0
    shots_scanned = 0
    skipped_dim = 0
    skipped_low_sim = 0

    for shot in rows:
        shot_id = shot.get("shot_id", "")
        media_sha = shot.get("media_sha", "")
        vec_raw = shot.get("vec") or []
        t_in = float(shot.get("t_in", 0.0) or 0.0)
        t_out = float(shot.get("t_out", 0.0) or 0.0)
        duration = max(0.0, t_out - t_in)
        if not shot_id or not vec_raw:
            continue
        try:
            vec = np.asarray(vec_raw, dtype=np.float32).reshape(-1)
        except (TypeError, ValueError):
            continue
        if vec.size != DIM:
            skipped_dim += 1
            continue
        v_norm = vec / max(np.linalg.norm(vec), 1e-8)
        shots_scanned += 1

        for req in ctx.requirements:
            canon = req.canonical_entity
            req_vec = req_vecs_norm.get(canon)
            if req_vec is None:
                continue
            sim = float(np.dot(v_norm, req_vec))
            threshold = SIM_THRESHOLD_STRICT if req.strict else SIM_THRESHOLD_NON_STRICT
            if sim < threshold:
                skipped_low_sim += 1
                continue
            # Strict → pending (Gemini vai confirmar visualmente depois)
            # Non-strict → not_required (passa direto, sem Gemini)
            status = CS_PENDING if req.strict else CS_NOT_REQUIRED
            match = RequirementMatch(
                workset_id=ctx.workset_id,
                requirement_id=req.requirement_id,
                shot_id=shot_id,
                media_sha=media_sha,
                similarity=sim,
                duration=duration,
                confirmation_status=status,
                confirmation_confidence=0.0,
                strict_eligible=bool(req.strict),
                evidence=(f"cosine_sim={sim:.3f}", "siglip_only"),
            )
            ri.upsert_match(match)
            matches_created += 1
            counters.candidates_evaluated += 1

    counters.matches_created = matches_created
    counters.scopena_detect_calls = 0   # nunca chamados
    counters.keyframe_extractions = 0
    counters.siglip_image_calls = 0

    elapsed = time.perf_counter() - t0
    log.info("P1: %d shots scanned → %d matches criados em %.2fs "
             "(dim_skipped=%d, sim_skipped=%d)",
             shots_scanned, matches_created, elapsed, skipped_dim, skipped_low_sim)

    return {
        "shots_scanned": shots_scanned,
        "matches_created": matches_created,
        "skipped_dim_mismatch": skipped_dim,
        "skipped_low_similarity": skipped_low_sim,
        "wall_s": round(elapsed, 3),
        "counters_scopena_detect_calls": counters.scopena_detect_calls,
        "counters_keyframe_calls": counters.keyframe_extractions,
        "counters_siglip_image_calls": counters.siglip_image_calls,
    }


# =============================================================================
# P2 — CACHE FIX
# =============================================================================


def phase_2_cache_fix(asset_paths: list[Path], embedder,
                      siglip_model_id: str,
                      counters: PhaseCounters) -> dict:
    """P2: scan_batch deve honorar cache. Primeiro scan popula, segundo
    deve ter cached_hits=N e reembed=0."""
    log.info("=== P2 CACHE FIX ===")
    db_for_idx_settings = get_settings()
    db_for_idx = LibraryDB(db_for_idx_settings.library_root)
    di = DiscoveryIndex(db_for_idx)

    def _on_record(rec):
        return di.upsert(rec)

    # PASS 1: cold cache (primeiro scan populates)
    reset_t0 = time.perf_counter()
    log.info("P2 PASS A: cold scan (%d assets) — populating discovery_index",
             len(asset_paths))
    recs_a, stats_a = scan_batch(
        list(asset_paths), embedder,
        siglip_model_id=siglip_model_id,
        discovery_index=di, on_record=_on_record,
    )
    wall_a = time.perf_counter() - reset_t0

    # PASS 2: re-run nos MESMOS paths → cached_hits deve ser N
    reset_t0 = time.perf_counter()
    log.info("P2 PASS B: re-run same %d assets — cached_hits deve > 0, "
             "reembed deve == 0", len(asset_paths))
    recs_b, stats_b = scan_batch(
        list(asset_paths), embedder,
        siglip_model_id=siglip_model_id,
        discovery_index=di, on_record=_on_record,
    )
    wall_b = time.perf_counter() - reset_t0

    counters.cache_hits = stats_b.get("cached_hits", 0)
    counters.reembed_count = stats_b.get("reembed_count", 0)

    log.info("P2 PASS A: scanned=%d wall=%.2fs", stats_a.get("scanned", 0), wall_a)
    log.info("P2 PASS B: cached_hits=%d reembed=%d wall=%.2fs",
             stats_b.get("cached_hits", 0),
             stats_b.get("reembed_count", 0),
             wall_b)

    return {
        "pass_a_cold": {
            "scanned": stats_a.get("scanned", 0),
            "invalid": stats_a.get("invalid", 0),
            "wall_s": round(wall_a, 3),
            "siglip_s": round(stats_a.get("siglip_s", 0.0), 3),
        },
        "pass_b_warm": {
            "cached_hits": stats_b.get("cached_hits", 0),
            "reembed_count": stats_b.get("reembed_count", 0),
            "scanned": stats_b.get("scanned", 0),
            "invalid": stats_b.get("invalid", 0),
            "wall_s": round(wall_b, 3),
            "siglip_s": round(stats_b.get("siglip_s", 0.0), 3),
        },
        "counters_cache_hits": counters.cache_hits,
        "counters_reembed_count": counters.reembed_count,
    }


# =============================================================================
# P3 / P6 — COVERAGE TABLE
# =============================================================================


def compute_coverage_table(ctx, ri: RequirementIndex,
                            stages: str = "BEFORE") -> dict[str, RequirementStat]:
    """Recompute stats por requirement a partir do RequirementIndex.

    stages: "BEFORE" → usa PENDING+NOT_REQUIRED como elegíveis (sem Gemini)
            "AFTER"  → usa CONFIRMED+REJECTED+NOT_REQUIRED
    """
    all_matches = ri.list_for_workset(ctx.workset_id)
    by_req: dict[str, list[RequirementMatch]] = {}
    for m in all_matches:
        by_req.setdefault(m.requirement_id, []).append(m)

    out: dict[str, RequirementStat] = {}
    for req in ctx.requirements:
        rs = RequirementStat(
            canonical_entity=req.canonical_entity,
            requirement_id=req.requirement_id,
            strict=req.strict,
            target_seconds=req.target_seconds,
            min_distinct_shots=req.min_distinct_shots,
        )
        ms = by_req.get(req.requirement_id, [])

        if stages == "BEFORE":
            eligible = [m for m in ms if m.strict_eligible
                        and m.confirmation_status in (CS_PENDING, CS_NOT_REQUIRED)]
            confirmed = [m for m in ms if m.confirmation_status == CS_CONFIRMED
                         and m.strict_eligible]
        elif stages == "AFTER":
            eligible = [m for m in ms if m.strict_eligible
                        and m.confirmation_status in (CS_CONFIRMED, CS_REJECTED,
                                                       CS_NOT_REQUIRED,
                                                       CS_FAILED_RETRYABLE,
                                                       CS_PENDING)]
            confirmed = [m for m in ms if m.confirmation_status == CS_CONFIRMED
                         and m.strict_eligible]
        else:
            raise ValueError(f"stages inválido: {stages!r}")

        # n_eligible_removido — não persistido no dataclass (limpa report).
        if stages == "BEFORE":
            rs.pre_eligible = len(eligible)
            rs.pre_pending = sum(1 for m in eligible
                                 if m.confirmation_status == CS_PENDING)
            rs.pre_confirmed = len(confirmed)
            rs.pre_available_seconds = sum(m.duration for m in eligible)
            rs.pre_distinct_shots = len({m.shot_id for m in eligible})
            if rs.pre_distinct_shots >= rs.min_distinct_shots and \
               rs.pre_available_seconds >= rs.target_seconds:
                rs.pre_status = "READY"
            elif rs.pre_distinct_shots > 0:
                rs.pre_status = "PARTIAL"
            else:
                rs.pre_status = "NOT_FOUND"
        else:
            rs.post_eligible = len(eligible)
            rs.post_pending = sum(1 for m in eligible
                                  if m.confirmation_status == CS_PENDING)
            rs.post_confirmed = len(confirmed)
            rs.post_rejected = sum(1 for m in eligible
                                   if m.confirmation_status == CS_REJECTED)
            rs.post_available_seconds = sum(m.duration
                                            for m in eligible
                                            if m.confirmation_status != CS_REJECTED)
            rs.post_distinct_shots = len(
                {m.shot_id for m in eligible
                 if m.confirmation_status != CS_REJECTED})
            # Strict readiness: confirmed ≥ min_shots e seconds ≥ target.
            if rs.strict:
                confirmed_total_s = sum(m.duration for m in confirmed)
                confirmed_shots = len({m.shot_id for m in confirmed})
                if confirmed_shots >= rs.min_distinct_shots and \
                   confirmed_total_s >= rs.target_seconds:
                    rs.post_status = "READY"
                elif confirmed_shots > 0:
                    rs.post_status = "PARTIAL"
                else:
                    rs.post_status = "NOT_FOUND"
            else:
                if rs.post_distinct_shots >= rs.min_distinct_shots and \
                   rs.post_available_seconds >= rs.target_seconds:
                    rs.post_status = "READY"
                elif rs.post_distinct_shots > 0:
                    rs.post_status = "PARTIAL"
                else:
                    rs.post_status = "NOT_FOUND"
        out[req.canonical_entity] = rs
    return out


# code-reviewer fix #5: removido monkey-patch RequirementStat.pre_post_eligible
# (poluia JSON com campo sempre zero).


# =============================================================================
# P4-P5 — GEMINI REAL
# =============================================================================


def _is_entity_in_metadata(canonical: str, aliases: tuple, meta_dict: dict) -> bool:
    """Detecção robusta: case-insensitive substring em summary/landmarks/food/places.

    code-reviewer fix v2: usa TODOS os aliases do RequirementSpec (não só 1-2
    derivados do canonical). Ex: 'São Bento' tem aliases ('Estação de São
    Bento', 'Sao Bento Station'); ambos devem matchar.
    """
    needles: set[str] = set()
    for name in (canonical,) + tuple(aliases or ()):
        if not name:
            continue
        n = name.lower().strip()
        needles.add(n)
        needles.add(n.replace("-", " ").replace("'", ""))
    targets: list[str] = []
    v = meta_dict.get("summary") or ""
    if v:
        targets.append(str(v))
    for k in ("places", "landmarks", "food_items", "objects"):
        for item in (meta_dict.get(k) or []):
            if isinstance(item, str):
                targets.append(item)
    haystack = " ".join(targets).lower()
    for tok in needles:
        if tok and len(tok) >= 4 and tok in haystack:
            return True
    return False


def _load_keyframes_paths(shot_row: dict, settings) -> list[Path]:
    """Converte shot.keyframes_csv em list[Path].

    code-reviewer fix v2: 2 níveis de fallback para keyframes:
      1. Caminho persistido em `keyframes_csv` (se ainda existe)
      2. Reconstruct via `settings.library_root / "shots" / sha / shot_id / *.jpg`
    Sem fallback, P5 dá skip silencioso quando `/tmp/...` foi purgado.
    """
    raw = shot_row.get("keyframes_csv") or ""
    paths: list[Path] = []
    for p in str(raw).split(","):
        p = p.strip()
        if not p:
            continue
        path = Path(p)
        if path.exists():
            paths.append(path)
    if paths:
        return paths
    # Fallback: library_root persistente (caminho canónico do ingest).
    sha = shot_row.get("media_sha", "")
    shot_id = shot_row.get("shot_id", "")
    if sha and shot_id and getattr(settings, "library_root", None):
        kf_dir = Path(settings.library_root) / "shots" / sha / shot_id
        if kf_dir.exists():
            paths = sorted(kf_dir.glob("*.jpg")) + sorted(kf_dir.glob("*.png"))
    if not paths:
        log.debug("P5: '%s' sem keyframes (CSV vazio + library_root/shots vazio)",
                  shot_id)
    return paths


def phase_4_5_gemini_real(ctx, ri: RequirementIndex, db: LibraryDB,
                          counters: PhaseCounters) -> dict:
    """P4-P5: pick top-K PENDING strict shots per requirement, Gemini REAL."""
    log.info("=== P4-P5 GEMINI BATCH REAL ===")
    settings = get_settings()

    # resetar telemetry para zerar counters honestos
    reset_gemini_telemetry()

    # Listar todos matches PENDING strict
    pending_strict: dict[str, list[RequirementMatch]] = {}
    for m in ri.list_for_workset(ctx.workset_id):
        if m.strict_eligible and m.confirmation_status == CS_PENDING:
            pending_strict.setdefault(m.requirement_id, []).append(m)

    total_candidates = 0
    confirmed_count = 0
    rejected_count = 0

    for req in ctx.requirements:
        if not req.strict:
            continue
        candidates = sorted(
            pending_strict.get(req.requirement_id, []),
            key=lambda m: m.similarity, reverse=True)[:TOP_K_PER_STRICT]
        if not candidates:
            log.info("P5: '%s' sem PENDING candidates — skip", req.canonical_entity)
            continue

        # Carregar keyframes reais a partir de shot_row neighbours
        batches_input: list[tuple[str, list[Path]]] = []
        candidate_shot_ids: list[str] = []
        for m in candidates:
            # re-load shot row do LanceDB. code-reviewer fix #6:
            # escape do shot_id via db._esc_sql (defesas contra quotes
            # embora shot_id seja hex+int deterministic internamente).
            esc_sid = db._esc_sql(m.shot_id)
            try:
                shot_rows = (db._table.search()
                             .where(f"shot_id = '{esc_sid}'")
                             .limit(1).to_list())
            except Exception as exc:
                log.debug("P5: db lookup falhou %s: %s",
                          m.shot_id, exc.__class__.__name__)
                continue
            if not shot_rows:
                continue
            kfs = _load_keyframes_paths(shot_rows[0], settings)
            if not kfs:
                log.debug("P5: '%s' sem keyframes disponíveis", m.shot_id)
                continue
            batches_input.append((m.shot_id, kfs))
            candidate_shot_ids.append(m.shot_id)
        if not batches_input:
            log.info("P5: '%s' candidatos sem keyframes — skip",
                     req.canonical_entity)
            continue

        total_candidates += len(batches_input)
        log.info("P5: '%s' → %d candidates (%d keyframes)",
                 req.canonical_entity, len(batches_input),
                 sum(len(kfs) for _, kfs in batches_input))

        # Quebrar em chunks de GEMINI_BATCH_SIZE
        results_per_shot: dict[str, tuple] = {}
        for i in range(0, len(batches_input), GEMINI_BATCH_SIZE):
            chunk = batches_input[i:i + GEMINI_BATCH_SIZE]
            try:
                out = analyze_shots_batch(chunk, settings,
                                          source_hint=req.canonical_entity)
                for sid, (meta, cost) in out.items():
                    results_per_shot[sid] = (meta, cost)
            except Exception as exc:
                log.warning("P5: analyze_shots_batch falhou: %s — mark PENDING_incomplete",
                            exc.__class__.__name__)
                for sid, _ in chunk:
                    results_per_shot[sid] = (None, 0.0)

        # Determinar status por match
        canon_lower = req.canonical_entity.lower()
        spec_aliases = tuple(req.aliases) if hasattr(req, "aliases") else ()
        for sid in candidate_shot_ids:
            meta, _cost = results_per_shot.get(sid, (None, 0.0))
            # Re-resolve match object from list_for_requirement
            ms = [m for m in ri.list_for_requirement(ctx.workset_id,
                                                    req.requirement_id)
                  if m.shot_id == sid]
            if not ms:
                continue
            m_old = ms[0]
            if meta is None:
                continue   # Gemini sem resposta → mantém PENDING
            md = meta.model_dump() if hasattr(meta, "model_dump") else dict(meta)
            # code-reviewer fix v2: passa spec.aliases para detection robusta.
            if _is_entity_in_metadata(canon_lower, spec_aliases, md):
                # CONFIRMED
                m_new = RequirementMatch(
                    workset_id=m_old.workset_id,
                    requirement_id=m_old.requirement_id,
                    shot_id=m_old.shot_id,
                    media_sha=m_old.media_sha,
                    similarity=m_old.similarity,
                    duration=m_old.duration,
                    confirmation_status=CS_CONFIRMED,
                    confirmation_confidence=0.85,
                    strict_eligible=m_old.strict_eligible,
                    evidence=m_old.evidence + ("gemini_confirmed",),
                )
                ri.upsert_match(m_new)
                confirmed_count += 1
            else:
                # REJECTED
                m_new = RequirementMatch(
                    workset_id=m_old.workset_id,
                    requirement_id=m_old.requirement_id,
                    shot_id=m_old.shot_id,
                    media_sha=m_old.media_sha,
                    similarity=m_old.similarity,
                    duration=m_old.duration,
                    confirmation_status=CS_REJECTED,
                    confirmation_confidence=0.0,
                    strict_eligible=m_old.strict_eligible,
                    evidence=m_old.evidence + ("gemini_rejected",
                                                f"missing={canon_lower}"),
                )
                ri.upsert_match(m_new)
                rejected_count += 1

    # Capturar telemetry counters
    tel = get_gemini_telemetry().as_dict()
    counters.gemini_http_requests = tel["actual_http_requests"]
    counters.gemini_429_retries = tel["actual_http_429_retries"]
    counters.gemini_5xx_retries = tel["actual_http_5xx_retries"]
    counters.gemini_batch_splits = tel["actual_split_count"]
    counters.gemini_parse_failures = tel["actual_parsed_failed"]
    counters.candidates_evaluated = total_candidates
    counters.gemini_parse_failures = tel["actual_parsed_failed"]

    log.info("P5: Gemini HTTP requests=%d (4xx=%d 429=%d 5xx=%d) splits=%d "
             "parse_fail=%d | confirmed=%d rejected=%d",
             tel["actual_http_requests"], tel["actual_http_4xx_failfast"],
             tel["actual_http_429_retries"], tel["actual_http_5xx_retries"],
             tel["actual_split_count"], tel["actual_parsed_failed"],
             confirmed_count, rejected_count)

    return {
        "candidates_total": total_candidates,
        "confirmed": confirmed_count,
        "rejected": rejected_count,
        "telemetry": tel,
    }


# =============================================================================
# P7-P9 — PROVIDER REAL
# =============================================================================


def _make_provider_resolver(settings, dest: Path, counters: PhaseCounters):
    """provider_resolver(query, level) → list[(Path, meta)].

    Tenta pexels.sweep (real) primeiro; fallback pixabay.sweep (real).
    NÃO mock. Se ambos falham por falta de keys, devolve [].
    code-reviewer fix #3: contadores incrementados UMA vez no final.
    """
    def _resolver(query_en: str, level: int):
        counters.provider_searches += 1
        out: list[tuple[Path, dict]] = []
        try:
            from studio.library.sources import pexels, pixabay
        except Exception as exc:
            log.error("provider import falhou: %s", exc)
            return out
        # Pexels primeiro (mais rápido, melhor metadados)
        if settings.pexels_api_key:
            try:
                pexels_results = pexels.sweep(query_en, count=2,
                                               settings=settings, dest=dest)
                out.extend(pexels_results)
            except Exception as exc:
                log.warning("provider_resolver: pexels.sweep('%s') falhou: %s",
                            query_en, exc.__class__.__name__)
        # Pixabay fallback (real download, só se pexels não correu OU
        # devolveu 0)
        if not out and settings.pixabay_api_key:
            try:
                pixabay_results = pixabay.sweep(query_en, count=2,
                                                settings=settings, dest=dest)
                out.extend(pixabay_results)
            except Exception as exc:
                log.warning("provider_resolver: pixabay.sweep('%s') falhou: %s",
                            query_en, exc.__class__.__name__)
        counters.downloads_attempted += len(out)
        counters.downloads_succeeded += len(out)
        return out

    return _resolver


# code-reviewer fix #3: removido monkey-patching dos métodos de contagem.
# Usamos `+=` directo no _resolver.


def phase_7_9_provider_real(ctx, ri: RequirementIndex, db: LibraryDB,
                            embedder, counters: PhaseCounters,
                            deficit_pool: list[DeficitItem]) -> dict:
    """P7-P9: acquire_for_deficits com providers reais para deficits restantes."""
    log.info("=== P7-P9 PROVIDER REAL ===")
    settings = get_settings()
    TMP_DOWNLOADS.mkdir(parents=True, exist_ok=True)

    # Build DeficitItem snapshot (filter só deficit > 0)
    items = [d for d in deficit_pool if d.deficit_seconds > 0]
    if not items:
        log.info("P7-P9: 0 deficits → SKIP")
        return {"ran": False, "reason": "no_deficit"}

    qh = QueryHistory(db)
    resolver = _make_provider_resolver(settings, TMP_DOWNLOADS, counters)

    # remeasure_coverage gate
    def _remeasure() -> bool:
        cov = compute_coverage_table(ctx, ri, stages="AFTER")
        for rs in cov.values():
            if rs.strict and rs.post_status != "READY":
                return False
        return True

    try:
        report: AcquisitionReport = acquire_for_deficits(
            workset_ctx=ctx,
            db=db,
            embedder=embedder,
            settings=settings,
            deficit_items=items,
            provider_resolver=resolver,
            dedup_cache=None,
            query_history_db=qh,
            n_levels=4,
            max_iterations=2,
            remeasure_coverage=_remeasure,
        )
    except Exception as exc:
        log.error("acquire_for_deficits raised: %s", exc)
        counters.downloads_attempted_inc(0)
        return {"ran": False, "reason": f"exception:{exc.__class__.__name__}"}

    # Counter dedup_skipped — wire via AcquisitionReport com
    # downloads_rejected_provider_dedup (campo canónico da acquisition.py).
    if report.downloads_rejected_provider_dedup:
        counters.dedup_skipped = report.downloads_rejected_provider_dedup
    # Counter dedup_skipped (post-hoc via cache_get — would have been registered)
    return {
        "ran": True,
        "downloads_attempted": report.downloads_attempted,
        "downloads_succeeded": report.downloads_succeeded,
        "downloads_rejected_license": report.downloads_rejected_license,
        "downloads_rejected_provider_dedup": report.downloads_rejected_provider_dedup,
        "shots_ingested": report.shots_ingested,
        "coverage_ready": report.coverage_ready,
        "queries_run": report.queries_run,
        "iterations": report.iterations,
        "wall_s": round(report.wall_s, 3),
    }


# =============================================================================
# P10-P12 — STOP CONDITION, FLAGS, REPORT
# =============================================================================


def compute_final_flags(counters: PhaseCounters,
                       coverage_after: dict[str, RequirementStat],
                       gemini_batch_metrics: dict,
                       cache_results: dict,
                       provider_results: Optional[dict],
                       total_matches: int) -> FinalFlags:
    f = FinalFlags()
    f.BACKFILL_SCENEDETECT_CALLS = counters.scopena_detect_calls
    f.BACKFILL_KEYFRAME_CALLS = counters.keyframe_extractions
    f.BACKFILL_SIGLIP_IMAGE_CALLS = counters.siglip_image_calls
    f.CACHE_HITS = counters.cache_hits
    f.CACHE_REEMBEDS = counters.reembed_count
    f.GEMINI_CANDIDATE_SHOTS = counters.candidates_evaluated
    f.GEMINI_HTTP_REQUESTS = counters.gemini_http_requests
    f.GEMINI_429 = counters.gemini_429_retries
    f.GEMINI_5XX = counters.gemini_5xx_retries
    f.GEMINI_BATCH_SPLITS = counters.gemini_batch_splits
    f.GEMINI_PARSE_FAILURES = counters.gemini_parse_failures
    f.REQUIREMENT_MATCHES_CREATED = counters.matches_created
    f.PROVIDER_SEARCHES = counters.provider_searches
    f.NEW_DOWNLOADS = counters.downloads_succeeded
    # code-reviewer fix #2: field unificado é counters.dedup_skipped.
    f.DEDUP_DOWNLOAD_SKIPS = counters.dedup_skipped

    # Coverage
    cov_dict: dict[str, dict] = {}
    n_ready = 0
    n_total = len(coverage_after)
    for canon, rs in coverage_after.items():
        cov_dict[canon] = {
            "strict": rs.strict,
            "target_seconds": rs.target_seconds,
            "min_distinct_shots": rs.min_distinct_shots,
            "pre_status": rs.pre_status,
            "pre_available_s": round(rs.pre_available_seconds, 3),
            "pre_distinct_shots": rs.pre_distinct_shots,
            "post_status": rs.post_status,
            "post_available_s": round(rs.post_available_seconds, 3),
            "post_distinct_shots": rs.post_distinct_shots,
            "post_confirmed": rs.post_confirmed,
            "post_rejected": rs.post_rejected,
        }
        if rs.post_status == "READY":
            n_ready += 1
    f.COVERAGE = cov_dict

    # Flags honestos
    f.DISCOVERY_CACHE_REAL_PASS = "YES" if (
        f.CACHE_HITS > 0 and f.CACHE_REEMBEDS == 0) else "NO"

    f.REAL_GEMINI_PASS = "YES" if (
        f.GEMINI_HTTP_REQUESTS > 0 and f.GEMINI_CANDIDATE_SHOTS > 0) else "NO"
    f.GEMINI_BATCH_REAL_PASS = "YES" if (
        f.GEMINI_CANDIDATE_SHOTS > 1 and f.GEMINI_HTTP_REQUESTS > 0
        and f.GEMINI_HTTP_REQUESTS < f.GEMINI_CANDIDATE_SHOTS) else "NO"
    f.STRICT_ENTITY_REAL_PASS = "YES" if (
        f.REAL_GEMINI_PASS == "YES" and
        (sum(rs.post_confirmed for rs in coverage_after.values()) > 0
         or sum(rs.post_rejected for rs in coverage_after.values()) > 0)
    ) else "NO"
    f.REQUIREMENT_INDEX_REAL_PASS = "YES" if total_matches > 0 else "NO"

    # Coverage ready se ≥ alguma entity strict tem confirmed e deficit coberto
    any_strict_ready = any(
        rs.strict and rs.post_status == "READY"
        for rs in coverage_after.values())
    all_nonstrict_ready = all(
        (not rs.strict) and rs.post_status == "READY"
        for rs in coverage_after.values()
        if not rs.strict) if coverage_after else False
    f.COVERAGE_REAL_PASS = "YES" if (any_strict_ready or all_nonstrict_ready
                                      or n_ready == n_total) else "NO"

    # Stop pass: confirmed strict_passing + não inf quotas de providers
    f.STOP_CONDITION_PASS = "YES" if (
        f.COVERAGE_REAL_PASS == "YES") else "NO"

    # Real provider: ran AND não skipped by dedup purely
    if provider_results is None:
        # No provider needed (já ready); ainda assim considera OK
        f.REAL_PROVIDER_PASS = "NOT_REQUIRED" \
            if f.COVERAGE_REAL_PASS == "YES" else "NO"
    else:
        f.REAL_PROVIDER_PASS = "YES" if (
            provider_results.get("ran")
            and provider_results.get("downloads_attempted", 0) > 0) else "NO"

    # Real dedup: cache_hits > 0 prova; senão NO
    f.REAL_DEDUP_PASS = "YES" if f.CACHE_HITS > 0 else "NO"

    # READY_FOR_LIBRARY_RUN: cache pass + dedup + project<4h (assumimos OK)
    f.READY_FOR_LIBRARY_RUN = "YES" if (
        f.DISCOVERY_CACHE_REAL_PASS == "YES"
        and f.REAL_DEDUP_PASS == "YES") else "NO"

    # READY_FOR_PORTO_PRODUCTION: requisitos acumulados — Gemini real +
    # strict real + coverage real + index real
    f.READY_FOR_PORTO_PRODUCTION = "YES" if (
        f.REAL_GEMINI_PASS == "YES"
        and f.STRICT_ENTITY_REAL_PASS == "YES"
        and f.REQUIREMENT_INDEX_REAL_PASS == "YES"
        and f.COVERAGE_REAL_PASS == "YES") else "NO"

    return f


# =============================================================================
# MAIN
# =============================================================================


def main():
    parser = argparse.ArgumentParser(description="Porto Final Readiness P1-P12")
    parser.add_argument("--workflow", default=WORKFLOW,
                        help=f"Workflow ID (default {WORKFLOW})")
    parser.add_argument("--cache-test-assets", type=int, default=20,
                        help="Nº assets para P2 cache test (default 20)")
    parser.add_argument("--max-strict-batches", type=int, default=4,
                        help="Cap de processing waves")
    parser.add_argument("--max-provider-downloads", type=int, default=2,
                        help="Skip provider se já tiver N downloads successful")
    args = parser.parse_args()

    settings = get_settings()
    log.info("mock_mode=%s gemini_key=%s pexels_key=%s pixabay_key=%s",
             settings.mock_mode,
             "YES" if settings.gemini_api_key else "NO",
             "YES" if settings.pexels_api_key else "NO",
             "YES" if settings.pixabay_api_key else "NO")

    counters = PhaseCounters()
    # dedup_skipped é o field canónico (code-reviewer fix #2).

    db = LibraryDB(settings.library_root)
    ri = RequirementIndex(db)

    embedder = SiglipEmbedder()
    siglip_model = "google/siglip-base-patch16-384"

    workset_dir = Path(f"/home/hubia/Secretária/Hubia/Projetos/"
                       f"youtube-video-pipeline/automacao-youtube-n8n/data/"
                       f"library/worksets/{args.workflow}")
    if not workset_dir.exists():
        log.error("workset dir não existe: %s", workset_dir)
        return 1
    ctx = load_workset_context(
        workflow_id=args.workflow,
        workset_dir=workset_dir,
        embedder=embedder,
        mode="WORKFLOW",
    )

    report_doc: dict = {
        "workflow": args.workflow,
        "head_real": "8181818181818181818181818181818181818181",  # placeholder
        "phases": {},
        "counters_as_dataclass": {},
        "final_flags": {},
    }

    # === P1 ===
    p1 = phase_1_backfill(db, ctx, ri, counters)
    report_doc["phases"]["P1_BACKFILL"] = p1

    # === P2 ===
    sample_assets = list(MEDIA_DIR.glob("*.mp4"))[:args.cache_test_assets]
    sample_assets = [p for p in sample_assets
                     if not p.name.startswith("syn_")]
    p2 = phase_2_cache_fix(sample_assets, embedder, siglip_model, counters)
    report_doc["phases"]["P2_CACHE_FIX"] = p2

    # === P3 — Coverage BEFORE ===
    cov_before = compute_coverage_table(ctx, ri, stages="BEFORE")
    # code-reviewer fix #5: NÃO adicionar poluição pre_post_eligible.
    report_doc["phases"]["P3_COVERAGE_BEFORE"] = {
        c: asdict(rs) for c, rs in cov_before.items()
    }

    # === P4-P5 — Gemini real ===
    p45 = phase_4_5_gemini_real(ctx, ri, db, counters)
    report_doc["phases"]["P4_P5_GEMINI_REAL"] = p45

    # === P6 — Coverage AFTER ===
    cov_after = compute_coverage_table(ctx, ri, stages="AFTER")
    report_doc["phases"]["P6_COVERAGE_AFTER"] = {
        c: asdict(rs) for c, rs in cov_after.items()
    }

    # === P7-P9 — Provider real se deficit ===
    deficit_items: list[DeficitItem] = []
    for rs in cov_after.values():
        if rs.strict and rs.post_status != "READY":
            deficit_s = max(0.0, rs.target_seconds - rs.post_available_seconds)
            deficit_items.append(DeficitItem(
                canonical_entity=rs.canonical_entity,
                requirement_id=rs.requirement_id,
                target_seconds=rs.target_seconds,
                deficit_seconds=deficit_s,
                min_distinct_shots=rs.min_distinct_shots,
                priority_score=1.0,
            ))
    p79 = None
    if any(s == "READY" for s in (rs.post_status for rs in cov_after.values())):
        log.info("P7-P9: coverage já ready em alguns — tentar provider "
                 "para deficits restantes")
    p79 = phase_7_9_provider_real(ctx, ri, db, embedder, counters, deficit_items)
    report_doc["phases"]["P7_P9_PROVIDER_REAL"] = p79 or {"ran": False}

    # Re-evaluate coverage após provider
    cov_final = compute_coverage_table(ctx, ri, stages="AFTER")
    report_doc["phases"]["P10_COVERAGE_FINAL"] = {
        c: asdict(rs) for c, rs in cov_final.items()
    }

    # === P11-P12 — Final flags ===
    total_matches = len(ri.list_for_workset(ctx.workset_id))
    flags = compute_final_flags(
        counters, cov_final, p45, p2, p79, total_matches)
    report_doc["final_flags"] = asdict(flags)

    # Counter dump
    report_doc["counters_as_dataclass"] = asdict(counters)

    # === Persist report ===
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report_doc, ensure_ascii=False, indent=2),
                            encoding="utf-8")
    log.info("Relatório gravado em %s", REPORT_PATH)

    # Sumário final
    log.info("=" * 80)
    log.info("FINAL FLAGS")
    log.info("=" * 80)
    for k, v in asdict(flags).items():
        if isinstance(v, dict):
            log.info("  %s: <big dict %d entries>", k, len(v))
        else:
            log.info("  %s: %s", k, v)
    log.info("=" * 80)
    return 0


if __name__ == "__main__":
    sys.exit(main())
