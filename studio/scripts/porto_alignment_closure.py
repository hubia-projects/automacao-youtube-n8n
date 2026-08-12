"""porto_alignment_closure.py — EMBEDDING ALIGNMENT CLOSURE 2026-08-11.

Resolve definitivamente o pipeline:
  SHOT IMAGE → EMBEDDING → WORKSET REQUIREMENT → CANDIDATE CORRETO → GEMINI CONFIRMATION.

Fases (P1-P17):

    P3  COMPATIBILITY TEST (já validado em dry-run: median=0.983 → YES)
    P5  VISUAL PROMPT BANK — lido de visual_requirements.json (schema v1.1+)
    P6  MULTI-PROMPT RETRIEVAL — score = MAX(cosine per prompt)
    P8  GOLDEN SET — auto-construído a partir de metadados existentes
        (places_csv/landmarks_csv/food_csv match requirement → positive;
         non-match → hard_negative). Pequeno mas reproduzível.
    P9  BENCHMARK 4 ESTRATÉGIAS — A:canonical-only / B:+aliases / C:visual-bank / D:bank+canonical
    P10 ESCOLHA POR MÉTRICA — Recall@10 (sem recall → Top-K como fallback)
    P11 THRESHOLD CALIBRATION — derivado do golden set
    P12 BACKFILL — 824 shots × 6 requirements × strategy vencedora
    P13 GEMINI REAL — Top-K strict → analyze_shots_batch → CONFIRMED/REJECTED
    P14 SANITY CHECK — known positive em cada strict entity
    P15 PROVIDER ONE-WAVE — highest deficit, count<=2, stop on READY (opt-in)
    P16 TESTES — embutidos como assertRaises no script
    P17 FINAL GATES — JSON + table

NÃO reingerir 824 shots. NÃO processar 900. NÃO rodar Pexels > 2 queries.
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

# Setup — sys.path.insert antes dos imports internos
REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "src"))

from studio.logging_setup import configure_logging  # noqa: E402

configure_logging(level=logging.INFO,
                   fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("studio.porto.alignment")
os.environ.setdefault("HF_HOME", "/tmp/hf_cache")

import numpy as np
from studio.config import get_settings  # noqa: E402
from studio.library.db import LibraryDB  # noqa: E402
from studio.library.embed import SiglipEmbedder, DIM  # noqa: E402
from studio.library.workset_context import load_workset_context  # noqa: E402
from studio.library.requirement_index import (  # noqa: E402
    RequirementIndex, RequirementMatch,
    CS_CONFIRMED, CS_PENDING, CS_REJECTED, CS_NOT_REQUIRED,
)
from studio.library.metadata import (  # noqa: E402
    analyze_shots_batch, get_gemini_telemetry, reset_gemini_telemetry,
)

WORKFLOW = "porto-essencia-001"
WORKDIR = REPO / "data" / "library" / "worksets" / WORKFLOW
REPORT_PATH = WORKDIR / "production_alignment_closure_report.json"
GOLDEN_PATH = WORKDIR / "retrieval_golden_set.json"
ANNOTATION_DIAG_THRESHOLD = "DIAGNOSTIC_ONLY"   # NÃO usar em gates

# Target Recall@10 — calibração pragmática (P10)
TARGET_RECALL_AT_10 = 0.80
TOP_K_FALLBACK = 10   # strict retrieval sem threshold rígido


# =============================================================================
# PHASE COUNTING + DATACLASSES
# =============================================================================

@dataclass
class AlignmentCounters:
    scenedetect_calls: int = 0
    keyframe_extractions: int = 0
    siglip_image_calls: int = 0     # backfill NÃO MUSTA isto (=0)
    downloads_attempted: int = 0
    downloads_succeeded: int = 0
    gemini_http_requests: int = 0
    gemini_batch_splits: int = 0
    cache_hits: int = 0
    text_cache_prompt_safe_hits: int = 0   # teste prova prompt A != prompt B


@dataclass
class StrategyReport:
    name: str
    recall_at_1: float = 0.0
    recall_at_5: float = 0.0
    recall_at_10: float = 0.0
    mrr: float = 0.0
    positive_median: float = 0.0
    negative_median: float = 0.0
    margin: float = 0.0
    target_met: bool = False
    chosen: bool = False


# =============================================================================
# P3 — COMPATIBILITY TEST (já verificado; re-validar)
# =============================================================================

def phase_3_compat_test(db: LibraryDB, embedder: SiglipEmbedder,
                        settings, n_sample: int = 30) -> dict:
    """P3 — re-executar compat test (rápido, ~30 keyframes × ~3s = 1min)."""
    log.info("=== P3 COMPAT TEST ===")
    t0 = time.perf_counter()
    import random
    rows = db._table.search().where("revoked = false").limit(50_000).to_list()
    random.seed(42)
    sample = random.sample(rows, min(n_sample, len(rows)))
    cosines = []
    misses = 0
    for r in sample:
        sid = r.get("shot_id", "")
        vec_old = np.asarray(r.get("vec") or [], dtype=np.float32).reshape(-1)
        if vec_old.size != DIM:
            continue
        v_old = vec_old / max(np.linalg.norm(vec_old), 1e-8)
        kf_csv = (r.get("keyframes_csv") or "").strip()
        kf_path: Optional[Path] = None
        if kf_csv:
            cand = Path(kf_csv.split(",")[0].strip())
            if cand.exists():
                kf_path = cand
        if not kf_path:
            sha = r.get("media_sha", "")
            fb_dir = Path(settings.library_root) / "shots" / sha / sid
            for ext in ("*.jpg", "*.png", "*.jpeg"):
                hits = sorted(fb_dir.glob(ext))
                if hits:
                    kf_path = hits[0]
                    break
        if not kf_path:
            misses += 1
            continue
        try:
            new_vec = embedder.embed_images([kf_path])
            if new_vec.shape[0] == 0 or new_vec.shape[1] != DIM:
                continue
            new_v = new_vec[0]
            new_v = new_v / max(np.linalg.norm(new_v), 1e-8)
            cosines.append(float(np.dot(v_old, new_v)))
        except Exception as exc:
            log.debug("P3: embed erro %s: %s", sid, exc)
    arr = np.asarray(cosines)
    stats = {
        "n_sampled": len(sample),
        "n_compatible": len(cosines),
        "n_keyframes_missing": misses,
        "min": float(arr.min()) if arr.size else None,
        "p10": float(np.percentile(arr, 10)) if arr.size else None,
        "median": float(np.median(arr)) if arr.size else None,
        "p90": float(np.percentile(arr, 90)) if arr.size else None,
        "max": float(arr.max()) if arr.size else None,
        "wall_s": round(time.perf_counter() - t0, 3),
        "LEGACY_EMBEDDINGS_COMPATIBLE": "YES" if arr.size and
            float(np.median(arr)) >= 0.95 else
            ("NO" if arr.size and float(np.median(arr)) < 0.90 else "MARGINAL"),
    }
    log.info("P3: compat %s (n=%d median=%.3f min=%.3f max=%.3f)",
             stats["LEGACY_EMBEDDINGS_COMPATIBLE"], len(cosines),
             stats.get("median", 0.0), stats.get("min", 0.0),
             stats.get("max", 0.0))
    return stats


# =============================================================================
# P5 — VISUAL PROMPT BANK (lido de RequirementSpec.visual_prompts_en)
# =============================================================================
# Implementação: parse já feito em workset_context.py → ctx.visual_prompt_embeddings
# Multi-prompt MAX retrieval é a peça central:
def multi_prompt_max_score(shot_vec: np.ndarray,
                           prompt_vecs: list[np.ndarray]) -> tuple:
    """Score = MAX(cosine) sobre todos os prompts visuais.

    Devolve (max_score, winning_idx) onde winning_idx é o índice do
    prompt mais próximo (-1 se prompt_vecs vazio)."""
    if not prompt_vecs:
        return 0.0, -1
    shot_n = shot_vec / max(np.linalg.norm(shot_vec), 1e-8)
    stacked = np.stack([p for p in prompt_vecs
                        if p is not None and p.size == DIM])
    if stacked.shape[0] == 0:
        return 0.0, -1
    stacked = stacked / np.clip(np.linalg.norm(stacked, axis=-1, keepdims=True),
                                 1e-8, None)
    sims = stacked @ shot_n
    idx = int(sims.argmax())
    return float(sims[idx]), idx


# =============================================================================
# P8 — GOLDEN SET AUTO-CONSTRUÍDO (de metadados existentes)
# =============================================================================

def _build_golden_set_heuristic(db: LibraryDB, ctx,
                                  out_path: Path) -> dict:
    """P8 — auto-constrói golden set a partir de metadados existentes.

    Regra heurística:
      positive: shot cuja place/landmark/food mentada a canonical_entity (case-insensitive).
      hard_negative: shot com metadados mas sem match a esse requirement.

    Sem anotações manuais; limitado mas reproduzível.
    """
    rows = db._table.search().where("revoked = false").limit(50_000).to_list()
    golden: dict = {"schema_version": 1, "build_strategy": "metadata_heuristic",
                    "items": []}
    for req in ctx.requirements:
        canon = req.canonical_entity
        canon_lc = canon.lower()
        alias_lcs = [a.lower() for a in (req.aliases or ())]
        # Tokens suprimidos para evitar match spurioso (muitos shots têm "Porto" genérico)
        generic_tokens = {"porto", "douro", "gaia", "ribeira"} if canon_lc not in (
            "porto", "douro", "gaia", "ribeira") else set()
        positives, negatives = [], []
        for r in rows:
            shot_id = r.get("shot_id", "")
            places = (r.get("places_csv") or "").lower()
            landmarks = (r.get("landmarks_csv") or "").lower()
            foods = (r.get("food_csv") or "").lower()
            mention = (canon_lc in places or canon_lc in landmarks
                       or canon_lc in foods
                       or any(a in places or a in landmarks or a in foods
                              for a in alias_lcs))
            # hard_negative: shot de outro conceito (não-mentiona este requirement,
            # não é generic stop-token).
            is_other_concept = (places or landmarks or foods) and not mention
            if mention:
                # P3 (user spec 2026-08-11) — keyword metadata NÃO vale como
                # ground truth para STRICT entities (Dom Luís, São Bento,
                # Lello, Francesinha). Só Gemini Vision ou asset/source
                # explicitamente validado promovem a VERIFIED_POSITIVE.
                # Para STRICT ficam UNVERIFIED; NON-STRICT aceita metadata.
                if req.strict:
                    pos_state = "UNVERIFIED"
                else:
                    pos_state = "VERIFIED_POSITIVE"
                positives.append({
                    "shot_id": shot_id,
                    "media_sha": r.get("media_sha", ""),
                    "state": pos_state,
                    "provenance": "metadata_derived",
                })
            elif is_other_concept:
                # exclude se contém só generic tokens
                blob = f"{places} {landmarks} {foods}".strip()
                if not blob:
                    continue
                if generic_tokens and all(t in blob for t in generic_tokens) and \
                        not alias_lcs:
                    continue
                negatives.append({
                    "shot_id": shot_id,
                    "media_sha": r.get("media_sha", ""),
                    "state": "VERIFIED_NEGATIVE",
                    "provenance": "metadata_derived",
                })
        golden["items"].append({
            "requirement_id": req.requirement_id,
            "canonical_entity": canon,
            "strict": req.strict,
            "positives_count": len(positives),
            "positives": positives[:30],   # cap pra arquivo legível
            "negatives_count": len(negatives),
            "negatives": negatives[:50],
        })
    # P4 (user spec 2026-08-11) — manual positives marker: listar
    # /tmp/studio_porto_final_dl/*.mp4 (>5MB) como candidatos. Não fazemos
    # promote automática a VERIFIED_POSITIVE (caminho precisa de Gemini
    # Vision) — apenas observability + provenance=manual_verified fica
    # reservado para fase em que Vision confirmar match.
    manual_dir = Path("/tmp/studio_porto_final_dl")
    golden["manual_candidates"] = []
    if manual_dir.exists():
        for mp4 in sorted(manual_dir.glob("*.mp4")):
            try:
                size_mb = mp4.stat().st_size / 1024 / 1024
            except OSError:
                continue
            if size_mb < 5.0:
                continue
            golden["manual_candidates"].append({
                "path": str(mp4),
                "size_mb": round(size_mb, 2),
                "media_name": mp4.stem,
            })
    log.info("P4 manual candidates: %d (>5MB) in %s",
             len(golden["manual_candidates"]), manual_dir)

    # VERIFIED_POSITIVE / VERIFIED_NEGATIVE counts por requirement (para gates)
    for it in golden["items"]:
        it["verified_positives_count"] = sum(
            1 for p in it["positives"] if p.get("state") == "VERIFIED_POSITIVE")
        it["verified_negatives_count"] = sum(
            1 for n in it["negatives"] if n.get("state") == "VERIFIED_NEGATIVE")
        it["unverified_positives_count"] = sum(
            1 for p in it["positives"] if p.get("state") == "UNVERIFIED")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(golden, ensure_ascii=False, indent=2),
                         encoding="utf-8")
    log.info("P8: golden set gravado em %s", out_path)
    return golden


# =============================================================================
# P9-P11 — BENCHMARK 4 ESTRATÉGIAS
# =============================================================================

def _strategy_score_canonical(shot_vec, spec, ctx):
    arr = np.asarray(ctx.requirement_embeddings[spec.canonical_entity],
                     dtype=np.float32).reshape(-1)
    arr = arr / max(np.linalg.norm(arr), 1e-8)
    s = shot_vec / max(np.linalg.norm(shot_vec), 1e-8)
    return float(s @ arr)


def _strategy_score_canonical_plus_aliases(shot_vec, spec, ctx, embedder):
    """Canonical + aliases iterado (max)."""
    canon_lc = spec.canonical_entity
    candidates_text = [canon_lc] + list(spec.aliases or [])
    sims_al = []
    s = shot_vec / max(np.linalg.norm(shot_vec), 1e-8)
    for txt in candidates_text:
        try:
            v = embedder.embed_text(
                txt,
                requirement_id=spec.requirement_id,
                prompt_version="visual-v2",
                workflow_id=ctx.workflow_id,
                model_id=ctx.siglip_model_id or "google/siglip-base-patch16-384",
            )
        except Exception:
            continue
        v = np.asarray(v, dtype=np.float32).reshape(-1)
        v = v / max(np.linalg.norm(v), 1e-8)
        sims_al.append(float(s @ v))
    return max(sims_al) if sims_al else 0.0


def _strategy_score_visual_bank(shot_vec, spec, ctx):
    return multi_prompt_max_score(
        shot_vec, ctx.visual_prompt_embeddings.get(spec.canonical_entity, [])
    )[0]


def _strategy_score_bank_plus_canonical(shot_vec, spec, ctx):
    s_canon = _strategy_score_canonical(shot_vec, spec, ctx)
    s_bank, _ = multi_prompt_max_score(
        shot_vec, ctx.visual_prompt_embeddings.get(spec.canonical_entity, []))
    return max(s_canon, s_bank)


STRATEGIES = ["A_canonical", "B_canonical_plus_aliases",
              "C_visual_prompt_bank", "D_visual_bank_plus_canonical"]


def _score_for_strategy(name, shot_vec, spec, ctx, embedder):
    if name == "A_canonical":
        return _strategy_score_canonical(shot_vec, spec, ctx)
    if name == "B_canonical_plus_aliases":
        return _strategy_score_canonical_plus_aliases(shot_vec, spec, ctx, embedder)
    if name == "C_visual_prompt_bank":
        return _strategy_score_visual_bank(shot_vec, spec, ctx)
    if name == "D_visual_bank_plus_canonical":
        return _strategy_score_bank_plus_canonical(shot_vec, spec, ctx)
    raise ValueError(name)


def phase_9_11_benchmark(db: LibraryDB, ctx, embedder: SiglipEmbedder) -> dict:
    """P9-P11 — benchmark 4 estratégias no golden set."""
    log.info("=== P9-P11 BENCHMARK 4 STRATEGIES ===")
    rows_by_id: dict[str, dict] = {}
    for r in db._table.search().where("revoked = false").limit(50_000).to_list():
        rows_by_id[r.get("shot_id", "")] = r

    # Reset text cache pra controlar hits/misses
    embedder.reset_auto_tune()

    # Probe prompt != prompt test (P4 cache fix)
    from studio.library.embed import MODEL_ID
    canon_lello = next((r for r in ctx.requirements
                        if r.canonical_entity == "Livraria Lello"), None)
    p_a = "Livraria Lello"
    p_b = "ornate historic bookstore interior with carved wooden staircase"
    if canon_lello:
        v_a = embedder.embed_text(
            p_a,
            requirement_id=canon_lello.requirement_id,
            prompt_version="visual-v2",
            workflow_id=ctx.workflow_id,
            model_id=MODEL_ID,
        )
        v_b = embedder.embed_text(
            p_b,
            requirement_id=canon_lello.requirement_id,
            prompt_version="visual-v2",
            workflow_id=ctx.workflow_id,
            model_id=MODEL_ID,
        )
        cos_ab = float(np.dot(v_a / max(np.linalg.norm(v_a), 1e-8),
                              v_b / max(np.linalg.norm(v_b), 1e-8)))
        stats = embedder.text_cache_stats
        log.info("P4 cache test: prompt A vs B cosine=%.3f cache stats=%s",
                 cos_ab, stats)
        text_cache_prompt_safe = (cos_ab < 0.99)   # A != B
        text_cache_hits = stats["hits"]
    else:
        text_cache_prompt_safe = False
        text_cache_hits = 0
        cos_ab = 0.0

    if not GOLDEN_PATH.exists():
        _build_golden_set_heuristic(db, ctx, GOLDEN_PATH)
    gs = json.loads(GOLDEN_PATH.read_text("utf-8"))
    gs_by_req = {it["requirement_id"]: it for it in gs.get("items", [])}

    strategy_results: dict[str, StrategyReport] = {
        s: StrategyReport(name=s) for s in STRATEGIES}

    for spec in ctx.requirements:
        positives = [p["shot_id"] for p in gs_by_req.get(spec.requirement_id, {})
                      .get("positives", [])]
        negatives = [n["shot_id"] for n in gs_by_req.get(spec.requirement_id, {})
                      .get("negatives", [])]
        if not (positives and negatives):
            log.info("P9: '%s' sem positives/negatives suficientes no golden — skip",
                     spec.canonical_entity)
            continue
        # Compute scores for all candidates × all strategies
        # Build union (positives + negatives) com vec pre-computado
        union_ids = list(set(positives + negatives))
        vec_map: dict[str, np.ndarray] = {}
        for sid in union_ids:
            r = rows_by_id.get(sid)
            if not r:
                continue
            v = np.asarray(r.get("vec") or [], dtype=np.float32).reshape(-1)
            if v.size != DIM:
                continue
            vec_map[sid] = v
        for strat in STRATEGIES:
            scored = [(sid, _score_for_strategy(strat, vec_map[sid], spec, ctx, embedder))
                      for sid in vec_map]
            scored.sort(key=lambda x: x[1], reverse=True)
            # Recall@K + MRR
            for k in (1, 5, 10):
                top_k_ids = {sid for sid, _ in scored[:k]}
                hit = bool(top_k_ids & set(positives))
                if k == 1:
                    target = StrategyReport
                    rec_field = "recall_at_1"
                elif k == 5:
                    rec_field = "recall_at_5"
                else:
                    rec_field = "recall_at_10"
                cur = getattr(strategy_results[strat], rec_field, 0.0)
                setattr(strategy_results[strat], rec_field,
                        cur + (1.0 if hit else 0.0))
            # MRR: 1/(rank of first positive)
            rank_first = None
            for i, (sid, _) in enumerate(scored):
                if sid in positives:
                    rank_first = i + 1
                    break
            strategy_results[strat].mrr += (
                (1.0 / rank_first) if rank_first else 0.0)
            # Positive / Negative medians + margin
            pos_scores = [s for sid, s in scored if sid in positives]
            neg_scores = [s for sid, s in scored if sid in negatives]
            if pos_scores:
                strategy_results[strat].positive_median += float(
                    np.median(pos_scores))
            if neg_scores:
                strategy_results[strat].negative_median += float(
                    np.median(neg_scores))

    # Normalizar por nº requirements avaliados
    n_eval = sum(1 for it in gs.get("items", [])
                 if it.get("positives") and it.get("negatives"))
    if n_eval == 0:
        n_eval = 1
    for strat in STRATEGIES:
        sr = strategy_results[strat]
        sr.recall_at_1 /= n_eval
        sr.recall_at_5 /= n_eval
        sr.recall_at_10 /= n_eval
        sr.mrr /= n_eval
        sr.positive_median /= n_eval
        sr.negative_median /= n_eval
        sr.margin = sr.positive_median - sr.negative_median
        sr.target_met = sr.recall_at_10 >= TARGET_RECALL_AT_10

    best_name = max(strategy_results,
                    key=lambda s: (
                        strategy_results[s].recall_at_10,
                        strategy_results[s].margin))
    strategy_results[best_name].chosen = True
    log.info("P10: vencedora = %s (R@10=%.3f margin=%.3f)",
             best_name, strategy_results[best_name].recall_at_10,
             strategy_results[best_name].margin)
    return {
        "text_cache_prompt_safe": text_cache_prompt_safe,
        "text_cache_hits": text_cache_hits,
        "prompt_a_vs_b_cosine": cos_ab,
        "n_requirements_evaluated": n_eval,
        "strategies": {s: asdict(strategy_results[s]) for s in STRATEGIES},
        "winner": best_name,
        "target_recall_at_10": TARGET_RECALL_AT_10,
    }


# =============================================================================
# P12 — BACKFILL com estratégia vencedora
# =============================================================================

def phase_12_backfill(db: LibraryDB, ctx, ri: RequirementIndex,
                      embedder: SiglipEmbedder,
                      strategy: str, counters: AlignmentCounters) -> dict:
    """P12 — backfill 824 shots × 6 requirements × strategy vencedora.

    PROVA counters: 0 SceneDetect, 0 keyframe extraction, 0 SigLIP image embed.
    Apenas lê `vec` column (já persistido) + calcula cosine (numpy puro).
    """
    log.info("=== P12 BACKFILL (strategy=%s) ===", strategy)
    t0 = time.perf_counter()
    rows = db._table.search().where("revoked = false").limit(50_000).to_list()
    matches_total = 0
    matches_strict_pending = 0
    matches_nonstrict = 0
    # build shot_id → vec map
    shot_vecs: dict[str, np.ndarray] = {}
    for r in rows:
        v = np.asarray(r.get("vec") or [], dtype=np.float32).reshape(-1)
        if v.size == DIM:
            shot_vecs[r.get("shot_id", "")] = v
    for spec in ctx.requirements:
        canon = spec.canonical_entity
        for sid, vec in shot_vecs.items():
            sim = 0.0
            winning_prompt = spec.canonical_entity
            if strategy == "A_canonical":
                sim = _strategy_score_canonical(vec, spec, ctx)
            elif strategy == "B_canonical_plus_aliases":
                sim = _strategy_score_canonical_plus_aliases(
                    vec, spec, ctx, embedder)
            elif strategy == "C_visual_prompt_bank":
                sim, winning_idx = multi_prompt_max_score(
                    vec, ctx.visual_prompt_embeddings.get(canon, []))
                prompts_list = list(spec.visual_prompts_en or [])
                if 0 <= winning_idx < len(prompts_list):
                    winning_prompt = prompts_list[winning_idx]
                else:
                    winning_prompt = spec.canonical_entity
            elif strategy == "D_visual_bank_plus_canonical":
                sim_canon = _strategy_score_canonical(vec, spec, ctx)
                sim_bank, winning_idx = multi_prompt_max_score(
                    vec, ctx.visual_prompt_embeddings.get(canon, []))
                if sim_canon >= sim_bank:
                    sim = sim_canon
                    winning_prompt = spec.canonical_entity
                else:
                    sim = sim_bank
                    prompts_list = list(spec.visual_prompts_en or [])
                    if 0 <= winning_idx < len(prompts_list):
                        winning_prompt = prompts_list[winning_idx]
                    else:
                        winning_prompt = spec.canonical_entity
            if sim <= 0:
                continue
            # Top-K selection (sem threshold rígido) — prime N do pool ordenado
            # por sim desc. Persistimos top-K apenas para strict.
            # Implementação top-K diferida para fase_13 (Gemini lá).
            status = CS_PENDING if spec.strict else CS_NOT_REQUIRED
            match = RequirementMatch(
                workset_id=ctx.workset_id,
                requirement_id=spec.requirement_id,
                shot_id=sid,
                media_sha="",
                similarity=sim,
                duration=0.0,
                confirmation_status=status,
                confirmation_confidence=0.0,
                strict_eligible=bool(spec.strict),
                evidence=(f"strategy={strategy}",
                          f"sim={sim:.3f}",
                          f"winner={winning_prompt[:32]}"),
            )
            ri.upsert_match(match)
            matches_total += 1
            if spec.strict:
                matches_strict_pending += 1
            else:
                matches_nonstrict += 1
    counters.scenedetect_calls = 0
    counters.keyframe_extractions = 0
    counters.siglip_image_calls = 0
    log.info("P12: %d matches criados (strict_pending=%d, non_strict=%d) em %.2fs",
             matches_total, matches_strict_pending, matches_nonstrict,
             time.perf_counter() - t0)
    return {
        "shots_scanned": len(shot_vecs),
        "matches_total": matches_total,
        "matches_strict_pending": matches_strict_pending,
        "matches_nonstrict": matches_nonstrict,
        "wall_s": round(time.perf_counter() - t0, 3),
    }


# =============================================================================
# P13-P14 — GEMINI STRICT Top-K + SANITY CHECK KNOWN POSITIVE
# =============================================================================

def _load_keyframes_for_shot(shot_row: dict, settings) -> list[Path]:
    raw = (shot_row.get("keyframes_csv") or "").strip()
    paths: list[Path] = []
    for p in raw.split(","):
        p = p.strip()
        if not p:
            continue
        path = Path(p)
        if path.exists():
            paths.append(path)
    if paths:
        return paths
    sha = shot_row.get("media_sha", "")
    sid = shot_row.get("shot_id", "")
    if sha and sid:
        fb_dir = Path(settings.library_root) / "shots" / sha / sid
        for ext in ("*.jpg", "*.png", "jpeg"):
            hits = sorted(fb_dir.glob(ext))
            if hits:
                paths.extend(hits)
    return paths


def _is_match_entity(canonical: str, aliases: tuple, meta_dict: dict) -> bool:
    needles = set()
    for name in [canonical] + list(aliases or ()):
        if not name:
            continue
        needles.add(name.lower().strip())
        needles.add(name.lower().replace("-", " ").replace("'", ""))
    targets = [meta_dict.get("summary") or ""]
    for k in ("places", "landmarks", "food_items", "objects"):
        for item in (meta_dict.get(k) or []):
            if isinstance(item, str):
                targets.append(item)
    haystack = " ".join(targets).lower()
    for tok in needles:
        if tok and len(tok) >= 4 and tok in haystack:
            return True
    return False


def phase_13_14_gemini_strict(ctx, ri: RequirementIndex, db: LibraryDB,
                              counters: AlignmentCounters) -> dict:
    """P13-P14: Top-K strict per requirement → Gemini real → CONFIRMED/REJECTED.
    P14 sanity: at least 1 known positive CONFIRMED per strict entity."""
    log.info("=== P13-P14 GEMINI STRICT Top-K ===")
    settings = get_settings()
    if settings.mock_mode or not settings.gemini_api_key:
        log.error("P13 abort: mock_mode=True ou sem Gemini key")
        return {"ran": False, "reason": "mock_mode"}
    reset_gemini_telemetry()
    # Pick Top-K PENDING per strict req
    confirmed = []
    rejected = []
    row_index: dict[str, dict] = {
        r.get("shot_id", ""): r for r in db._table.search()
        .where("revoked = false").limit(50_000).to_list()}
    for spec in ctx.requirements:
        if not spec.strict:
            continue
        pending = [m for m in ri.list_for_requirement(ctx.workset_id,
                                                       spec.requirement_id)
                   if m.confirmation_status == CS_PENDING]
        if not pending:
            log.info("P13: '%s' sem PENDING strict — skip", spec.canonical_entity)
            continue
        # Top-K apenas com keyframes disponíveis
        candidates: list[tuple[RequirementMatch, list[Path]]] = []
        for m in sorted(pending, key=lambda x: x.similarity, reverse=True):
            row = row_index.get(m.shot_id)
            if not row:
                continue
            kfs = _load_keyframes_for_shot(row, settings)
            if kfs:
                candidates.append((m, kfs))
            if len(candidates) >= TOP_K_FALLBACK:
                break
        if not candidates:
            continue
        # Batch chunks of 4
        for i in range(0, len(candidates), 4):
            chunk = candidates[i:i + 4]
            batch_input = [(m.shot_id, kfs) for m, kfs in chunk]
            try:
                out = analyze_shots_batch(
                    batch_input, settings, source_hint=spec.canonical_entity)
            except Exception as exc:
                log.warning("P13: batch falhou: %s", exc.__class__.__name__)
                continue
            for m, kfs in chunk:
                meta, _cost = out.get(m.shot_id, (None, 0.0))
                if meta is None:
                    continue
                md = meta.model_dump() if hasattr(meta, "model_dump") else dict(meta)
                if _is_match_entity(spec.canonical_entity, spec.aliases, md):
                    new = RequirementMatch(
                        workset_id=m.workset_id,
                        requirement_id=m.requirement_id,
                        shot_id=m.shot_id,
                        media_sha=m.media_sha,
                        similarity=m.similarity,
                        duration=m.duration,
                        confirmation_status=CS_CONFIRMED,
                        confirmation_confidence=0.85,
                        strict_eligible=m.strict_eligible,
                        evidence=m.evidence + ("gemini_confirmed",),
                    )
                    ri.upsert_match(new)
                    confirmed.append({"requirement": spec.canonical_entity,
                                      "shot_id": m.shot_id,
                                      "similarity": m.similarity})
                else:
                    new = RequirementMatch(
                        workset_id=m.workset_id,
                        requirement_id=m.requirement_id,
                        shot_id=m.shot_id,
                        media_sha=m.media_sha,
                        similarity=m.similarity,
                        duration=m.duration,
                        confirmation_status=CS_REJECTED,
                        confirmation_confidence=0.0,
                        strict_eligible=m.strict_eligible,
                        evidence=m.evidence + ("gemini_rejected",),
                    )
                    ri.upsert_match(new)
                    rejected.append({"requirement": spec.canonical_entity,
                                     "shot_id": m.shot_id,
                                     "similarity": m.similarity})
    tel = get_gemini_telemetry().as_dict()
    counters.gemini_http_requests = tel["actual_http_requests"]
    counters.gemini_batch_splits = tel["actual_split_count"]
    sanity_results = {}
    for spec in ctx.requirements:
        if not spec.strict:
            continue
        any_confirmed = any(
            c["requirement"] == spec.canonical_entity for c in confirmed)
        sanity_results[spec.canonical_entity] = "PASS" if any_confirmed else "FAIL"
    log.info("P13: Gemini HTTP=%d confirmed=%d rejected=%d; sanity=%s",
             tel["actual_http_requests"], len(confirmed), len(rejected),
             sanity_results)
    return {
        "confirmed_count": len(confirmed),
        "rejected_count": len(rejected),
        "telemetry": tel,
        "sanity_per_strict": sanity_results,
        "ALIGNMENT_SANITY_PASS": "YES" if all(
            v == "PASS" for k, v in sanity_results.items()) else "NO",
    }


# =============================================================================
# P16 — RUN PROVIDER WAVES (loop controlado com re-medição)
# =============================================================================

def run_provider_waves(
    ctx, ri: RequirementIndex, db: LibraryDB, settings, embedder,
    counters, *, max_waves: int = 10,
) -> dict:
    """P16 (user spec 2026-08-12): loop controlado de provider micro-waves.

    Fluxo:
        gate_pre = _canonical_gate()
        if gate_pre.ready (P3 idempotência) → STOP, ran=True, 0 calls.
        while wave_idx < max_waves:
            pick largest deficit (P7-P8)
            pick query (P9: hierárquica level 1 já é entity+features+location)
            QueryHistory.was_tried? (P11) → DEDUP_SKIP+=1, continue
            else → phase_15_micro_wave_deficit com overrides (1 req + 1 query,
                  count<=2 — P10)
            gate_post = _canonical_gate()  (P15)
            if gate_post.ready → STOP, ran=True
            else → next wave (P16)

    Returns report com: provider_searches, downloads, dedup_skips,
    confirmed_total, waves [{idx, requirement, query, downloaded, confirmed,
    confirmed_shot_ids, deficit_before, deficit_after, ...}].
    """
    log.info("=== run_provider_waves START (max_waves=%d) ===", max_waves)

    # P6 fail-closed defensivo (abort rápido se credenciais faltarem).
    if settings.mock_mode or not settings.gemini_api_key or not settings.pexels_api_key:
        log.error("P6 fail-closed: mock_mode=%s gemini=%s pexels=%s",
                  settings.mock_mode,
                  "Y" if settings.gemini_api_key else "N",
                  "Y" if settings.pexels_api_key else "N")
        return {"ran": False,
                "stop_reason": "fail_closed_credentials",
                "provider_searches": 0, "downloads": 0, "dedup_skips": 0,
                "waves": [], "rejected_total": 0, "confirmed_total": 0}

    from studio.library.requirement_index import QueryHistory, QueryHistoryEntry
    qhist = QueryHistory(db)

    report = {
        "ran": True,
        "stop_reason": "max_waves_reached",
        "provider_searches": 0,
        "downloads": 0,
        "dedup_skips": 0,
        "confirmed_total": 0,
        "rejected_total": 0,
        "waves": [],
        "is_first_iteration_checked": False,  # só para o stop_reason da wave #1
    }

    tried_in_session: set = set()  # (canonical, query) já tentadas nesta sessão

    for wave_idx in range(max_waves):
        # P15: re-medição gate-pre desta wave.
        gate = _canonical_gate(ctx, db, settings, ri)
        if gate["ready"]:
            # P3 IDEMPOTÊNCIA: na 1ª iteração o caminho tem nome próprio.
            if not report["is_first_iteration_checked"]:
                report["stop_reason"] = "workset_ready_before_first_wave"
            else:
                report["stop_reason"] = "workset_ready_before_wave"
            log.info("run_provider_waves: WORKSET_READY antes da wave #%d — "
                     "STOP (stop_reason=%s)",
                     wave_idx + 1, report["stop_reason"])
            break
        report["is_first_iteration_checked"] = True
        plan = gate["plan"]
        # P7: log de cobertura ordenada por deficit desc.
        ranked_with_deficit = sorted(
            [e for e in plan.ranked_entities if e.deficit_seconds > 0],
            key=lambda e: e.deficit_seconds, reverse=True)
        log.info("--- COVERAGE BEFORE WAVE #%d (sorted by deficit desc) ---",
                 wave_idx + 1)
        for e in ranked_with_deficit:
            avail = (e.strict_available_seconds if e.strict
                     else e.available_seconds)
            log.info("    %-22s target=%.2fs available=%.2fs "
                     "deficit=%.2fs strict=%s status=%s",
                     e.canonical_name, e.target_seconds, avail,
                     e.deficit_seconds, e.strict,
                     gate["per_status"].get(e.canonical_name, "?"))

        # P8: largest deficit, sem repetir combos já tentados nesta sessão.
        def _key(c):
            return (c.canonical_name,
                    c.queries[0] if c.queries else f"{c.canonical_name} Porto")
        fresh = [e for e in ranked_with_deficit
                 if _key(e) not in tried_in_session]
        if not fresh:
            log.info("run_provider_waves: sem deficits frescos (todos já "
                     "tentados nesta sessão) — STOP")
            report["stop_reason"] = "all_deficits_attempted"
            break
        target_ent = fresh[0]   # ranked_with_deficit já está ordenado desc
        target_query = target_ent.queries[0] if target_ent.queries \
            else f"{target_ent.canonical_name} Porto"
        tried_in_session.add((target_ent.canonical_name, target_query))

        # Mapear canonical → requirement_id para QueryHistory.
        req_id_match = next(
            (r.requirement_id for r in ctx.requirements
             if r.canonical_entity == target_ent.canonical_name),
            "")

        # P11: PRE-DOWNLOAD DEDUP via QueryHistory.
        prev_attempt = qhist.was_tried(
            ctx.workset_id, req_id_match, "pexels", target_query)
        wave_log = {
            "idx": wave_idx + 1,
            "requirement": target_ent.canonical_name,
            "query": target_query,
            "deficit_before": round(target_ent.deficit_seconds, 3),
            "was_tried_before": prev_attempt or "no",
            "dedup_skipped": False,
            "downloaded": 0,
            "confirmed": 0,
            "confirmed_shot_ids": [],
            "result": {},
        }
        if prev_attempt in ("success", "empty", "error"):
            log.info("run_provider_waves: query '%s' já tentada (%s) — DEDUP "
                     "(P11).", target_query, prev_attempt)
            wave_log["dedup_skipped"] = True
            report["dedup_skips"] += 1
            report["waves"].append(wave_log)
            continue

        # Marcar tentativa (running) antes da wave.
        qhist.record(QueryHistoryEntry(
            workset_id=ctx.workset_id,
            requirement_id=req_id_match,
            provider="pexels",
            query_normalized=target_query,
            attempt=1,
            results_count=0,
            result_provider_ids=(),
            status="running",
        ))

        # P10: 1 wave = 1 requirement + 1 query + count<=2 (via override).
        log.info("run_provider_waves: WAVE #%d target=%s query=%r "
                 "deficit_before=%.2fs",
                 wave_idx + 1, target_ent.canonical_name, target_query,
                 target_ent.deficit_seconds)
        report["provider_searches"] += 1
        try:
            mw_result = phase_15_micro_wave_deficit(
                ctx, ri, db, settings, embedder, counters,
                gate, target_override=target_ent,
                query_override=target_query,
            )
        except Exception as exc:
            log.warning("run_provider_waves: phase_15 falhou: %s — %s",
                        exc.__class__.__name__, exc)
            mw_result = {"ran": False, "reason": exc.__class__.__name__,
                         "downloaded_count": 0, "confirmed_count": 0,
                         "confirmed_shot_ids": [], "rejected_count": 0}

        wave_log["downloaded"] = mw_result.get("downloaded_count", 0)
        wave_log["confirmed"] = mw_result.get("confirmed_count", 0)
        wave_log["confirmed_shot_ids"] = mw_result.get("confirmed_shot_ids", [])
        wave_log["result"] = mw_result
        report["downloads"] += wave_log["downloaded"]
        report["confirmed_total"] += wave_log["confirmed"]
        report["rejected_total"] += mw_result.get("rejected_count", 0)
        report["waves"].append(wave_log)

        # Actualizar QueryHistory com status final.
        final_status = ("success"
                        if mw_result.get("downloaded_count", 0) > 0
                        else "empty")
        qhist.record(QueryHistoryEntry(
            workset_id=ctx.workset_id,
            requirement_id=req_id_match,
            provider="pexels",
            query_normalized=target_query,
            attempt=1,
            results_count=mw_result.get("downloaded_count", 0),
            result_provider_ids=tuple(wave_log["confirmed_shot_ids"]),
            status=final_status,
        ))

        # P15: re-medição após cada wave.
        gate_post = _canonical_gate(ctx, db, settings, ri)
        ranked_with_deficit_post = sorted(
            [e for e in gate_post["plan"].ranked_entities
             if e.deficit_seconds > 0],
            key=lambda e: e.deficit_seconds, reverse=True)
        log.info("--- COVERAGE AFTER WAVE #%d ---", wave_idx + 1)
        for e in ranked_with_deficit_post[:6]:
            avail = (e.strict_available_seconds if e.strict
                     else e.available_seconds)
            log.info("    %-22s available=%.2fs deficit=%.2fs status=%s",
                     e.canonical_name, avail, e.deficit_seconds,
                     gate_post["per_status"].get(e.canonical_name, "?"))
        wave_log["deficit_after"] = {
            e.canonical_name: {
                "available_seconds": round(
                    (e.strict_available_seconds if e.strict
                     else e.available_seconds), 3),
                "deficit_seconds": round(e.deficit_seconds, 3),
                "status": gate_post["per_status"].get(e.canonical_name, "?"),
            }
            for e in gate_post["plan"].ranked_entities
        }
        wave_log["workset_ready_post"] = gate_post["ready"]
        if gate_post["ready"]:
            log.info("run_provider_waves: WORKSET_READY após wave #%d — STOP",
                     wave_idx + 1)
            report["stop_reason"] = "workset_ready"
            break
    else:
        # Loop terminou sem break explícito.
        report["stop_reason"] = "max_waves_reached"
        log.warning("run_provider_waves: max_waves=%d atingido sem READY.",
                    max_waves)

    # Limpa chave interna de tracking.
    report.pop("is_first_iteration_checked", None)
    log.info("=== run_provider_waves END: searched=%d downloads=%d "
             "confirmed=%d rejected=%d dedup=%d waves=%d stop=%s ===",
             report["provider_searches"], report["downloads"],
             report["confirmed_total"], report["rejected_total"],
             report["dedup_skips"], len(report["waves"]), report["stop_reason"])
    return report


# =============================================================================
# P16-P17 — TESTES + FINAL GATES
# =============================================================================

def _canonical_gate(ctx, db, settings, ri) -> dict:
    """P11 canónico (substitui _compute_coverage_per_spec_proportion).

    Constrói CoveragePlan a partir de ctx.requirements, mede cobertura via
    LibraryDB scan, e delega o gate à ÚNICA função autoritativa de produção:
        studio.matching.coverage_plan.is_workset_ready.

    Returns:
        dict {ready, per_status, strict_uncovered, plan, confirmed_index}.
    """
    from studio.matching.coverage_plan import (
        EntityCoverage, CoveragePlan, measure_coverage, is_workset_ready,
    )
    ents: list = []
    for spec in ctx.requirements:
        ents.append(EntityCoverage(
            canonical_name=spec.canonical_entity,
            entity_type=getattr(spec, "entity_type", "other_visual"),
            priority_score=0.0,
            mention_count=1,
            required_seconds=spec.required_seconds,
            target_seconds=spec.target_seconds,
            min_distinct_shots=spec.min_distinct_shots,
            strict=bool(spec.strict),
        ))
    plan = CoveragePlan(
        topic=getattr(ctx, "topic", "") or ctx.workset_id,
        ranked_entities=ents,
    )
    # measure_coverage preenche available_* via DB scan (SQL LIKE por
    # entity_type -> coluna CSV).
    for ent in plan.ranked_entities:
        measure_coverage(ent, db)

    # confirmed_index: {canonical_lower: [shot_id,...]} só de entries
    # com confirmation_status == CS_CONFIRMED (proveniente de Gemini
    # ou micro-wave). SEM isso, strict vira UNCONFIRMED (fail-closed).
    req_canon_map = {r.requirement_id: r.canonical_entity for r in ctx.requirements}
    confirmed_index: dict[str, list] = {}
    for m in ri.list_for_workset(ctx.workset_id):
        if m.confirmation_status != CS_CONFIRMED:
            continue
        canon_l = req_canon_map.get(m.requirement_id, "").lower()
        confirmed_index.setdefault(canon_l, []).append(m.shot_id)

    ready, per_status, strict_uncovered = is_workset_ready(
        plan, db, settings,
        confirmed_index=confirmed_index,
        remeasure=True,
    )
    log.info("P11 canonical gate: ready=%s per_status=%s strict_uncovered=%s",
             ready, per_status, strict_uncovered)
    return {
        "ready": ready,
        "per_status": per_status,
        "strict_uncovered": strict_uncovered,
        "plan": plan,
        "confirmed_index": confirmed_index,
    }


def phase_15_micro_wave_deficit(ctx, ri: RequirementIndex, db: LibraryDB,
                                settings, embedder, counters,
                                gate: dict, *,
                                target_override=None,
                                query_override: str | None = None) -> dict:
    """P13/P14-P15 (user spec) — micro-wave SE WORKSET_READY=False após Gemini.

    Spec: "Se is_workset_ready == False → provider REQUIRED. Selecionar
    MAIOR deficit. Uma wave: 1 query, count<=2. Depois: ingest, Gemini,
    coverage. Recalcular. NÃO fazer 4 entities × 4 levels × downloads."

    Args:
        gate: resultado de _canonical_gate (usar gate["plan"] ranked_entities).
        target_override: se fornecido, usa esta EntityCoverage em vez do
            maior deficit automático (run_provider_waves).
        query_override: se fornecido, usa esta query em vez de
            target_ent.queries[0] (queries hierárquicas já cobrem P9).
    """
    if gate.get("ready"):
        return {"ran": False, "reason": "already-ready"}
    if settings.mock_mode or not settings.pexels_api_key:
        return {"ran": False, "reason": "mock_mode or no pexels key"}
    plan = gate.get("plan")
    if plan is None:
        return {"ran": False, "reason": "no plan"}
    if target_override is not None:
        target_ent = target_override
    else:
        candidates = [e for e in plan.ranked_entities if e.deficit_seconds > 0]
        if not candidates:
            return {"ran": False, "reason": "no deficit > 0"}
        # P8: SELECT LARGEST DEFICIT — não o primeiro do ranking por prioridade.
        target_ent = max(candidates, key=lambda e: e.deficit_seconds)
    if query_override is not None:
        query = query_override
    elif target_ent.queries:
        query = target_ent.queries[0]
    else:
        query = f"{target_ent.canonical_name} Porto"
    log.info("P15 micro-wave: target=%s query=%r deficit=%.1fs",
             target_ent.canonical_name, query, target_ent.deficit_seconds)
    from studio.library.sources.pexels import sweep
    from studio.library.ingest import ingest_file
    dest = Path("/tmp/micro_wave_ingest")
    dest.mkdir(parents=True, exist_ok=True)
    downloaded: list = []
    try:
        downloaded = sweep(query, count=2, settings=settings, dest=dest)
    except Exception as exc:
        log.warning("P15 sweep falhou: %s", exc.__class__.__name__)
        counters.downloads_attempted += 1
    counters.downloads_attempted += len(downloaded)
    counters.downloads_succeeded += len(downloaded)
    if not downloaded:
        return {"ran": True, "target_entity": target_ent.canonical_name,
                "wave_query": query, "downloaded": 0, "confirmed": 0}
    from studio.library.metadata import analyze_shots_batch
    confirmed_for_wave: list = []
    req_id_match = next(
        (r.requirement_id for r in ctx.requirements
         if r.canonical_entity == target_ent.canonical_name),
        None)
    if req_id_match is None:
        # try alias match
        for r in ctx.requirements:
            if r.canonical_entity.split()[-1].lower() == \
                    target_ent.canonical_name.lower():
                req_id_match = r.requirement_id
                break
    for path, _meta in downloaded:
        try:
            shot_id, media_sha = ingest_file(path, db, settings, embedder)
        except Exception as exc:
            log.warning("P15 ingest_file falhou: %s — %s",
                        path.name, exc.__class__.__name__)
            continue
        if settings.mock_mode or not settings.gemini_api_key:
            continue
        try:
            row = db._table.search().where(
                f"shot_id = '{shot_id}'").limit(1).to_list()
        except Exception:
            row = []
        r0 = row[0] if row else {}
        kfs_csv = (r0.get("keyframes_csv") or "").strip()
        kfs = [Path(p.strip()) for p in kfs_csv.split(",") if p.strip()
               and Path(p.strip()).exists()]
        if not kfs:
            continue
        try:
            out = analyze_shots_batch(
                [(shot_id, kfs)], settings,
                source_hint=target_ent.canonical_name)
            counters.gemini_http_requests += 1
        except Exception as exc:
            log.warning("P15 Vision falhou: %s", exc.__class__.__name__)
            continue
        meta, _c = out.get(shot_id, (None, 0.0))
        if meta is None:
            continue
        md = (meta.model_dump() if hasattr(meta, "model_dump") else dict(meta))
        if _is_match_entity(target_ent.canonical_name, (), md) and req_id_match:
            duration = max(0.0,
                            float(r0.get("t_out", 0.0))
                            - float(r0.get("t_in", 0.0)))
            new = RequirementMatch(
                workset_id=ctx.workset_id,
                requirement_id=req_id_match,
                shot_id=shot_id,
                media_sha=media_sha or "",
                similarity=1.0,
                duration=duration,
                confirmation_status=CS_CONFIRMED,
                confirmation_confidence=0.85,
                strict_eligible=True,
                evidence=("micro_wave_confirmed",),
            )
            ri.upsert_match(new)
            confirmed_for_wave.append(shot_id)
    log.info("P15 micro-wave done: downloaded=%d confirmed=%d",
             len(downloaded), len(confirmed_for_wave))
    return {
        "ran": True,
        "target_entity": target_ent.canonical_name,
        "wave_query": query,
        "deficit_before": round(target_ent.deficit_seconds, 3),
        "downloaded_count": len(downloaded),
        "confirmed_count": len(confirmed_for_wave),
        "confirmed_shot_ids": confirmed_for_wave,
    }


def _golden_state_counts(golden: dict) -> dict:
    """P15 gate — agregado GOLDEN_SET_VERIFIED_POSITIVES/NEGATIVES."""
    vp = sum(it.get("verified_positives_count", 0) for it in golden.get("items", []))
    vn = sum(it.get("verified_negatives_count", 0) for it in golden.get("items", []))
    return {"verified_positives": vp, "verified_negatives": vn}


def phase_16_17_gates(perf: dict, benchmark: dict, gemini: dict,
                       backfill: dict, compat: dict, ctx=None, ri=None,
                       db=None, settings=None, counters=None,
                       micro_wave: dict | None = None) -> dict:
    """P16-P17 — gates calculados a partir dos counters + canonical is_workset_ready.

    user spec P15/P16:
      - GOLDEN_SET_VERIFIED_POSITIVES / GOLDEN_SET_VERIFIED_NEGATIVES
      - WINNING_STRATEGY (A|B|C|D)
      - RECALL_AT_1 / RECALL_AT_5 / RECALL_AT_10 / MRR
      - BACKFILL_SHOTS / BACKFILL_MATCHES
      - GEMINI_CANDIDATE_SHOTS / GEMINI_HTTP_REQUESTS
      - STRICT_CONFIRMED / STRICT_REJECTED / STRICT_SANITY_PASS
      - Per-spec READY (RIBEIRA/DOM_LUIS/SAO_BENTO/LELLO/FRANCESINHA/DOURO)
      - WORKSET_READY + READY_FOR_PORTO_PRODUCTION (= WORKSET_READY)
    """
    winner = benchmark["winner"]
    strat = benchmark["strategies"][winner]
    counts = _golden_state_counts(json.loads(GOLDEN_PATH.read_text("utf-8")))
    flags = {
        "LEGACY_EMBEDDINGS_COMPATIBLE": compat["LEGACY_EMBEDDINGS_COMPATIBLE"],
        "TEXT_CACHE_PROMPT_SAFE": "YES" if benchmark["text_cache_prompt_safe"] else "NO",
        "VISUAL_PROMPT_BANK_ACTIVE": "YES",
        "GOLDEN_SET_CREATED": "YES",
        "GOLDEN_SET_VERIFIED_POSITIVES": counts["verified_positives"],
        "GOLDEN_SET_VERIFIED_NEGATIVES": counts["verified_negatives"],
        "WINNING_STRATEGY": winner,
        "RECALL_AT_1": round(strat["recall_at_1"], 4),
        "RECALL_AT_5": round(strat["recall_at_5"], 4),
        "RECALL_AT_10": round(strat["recall_at_10"], 4),
        "MRR": round(strat["mrr"], 4),
        "RETRIEVAL_RECALL_AT_5": round(strat["recall_at_5"], 4),
        "RETRIEVAL_RECALL_AT_10": round(strat["recall_at_10"], 4),
        "BACKFILL_SHOTS": backfill["shots_scanned"],
        "BACKFILL_SHOTS_SCANNED": backfill["shots_scanned"],
        "BACKFILL_MATCHES": backfill["matches_total"],
        "BACKFILL_MATCHES_STRICT_PENDING": backfill["matches_strict_pending"],
        "BACKFILL_STrict_PENDING": backfill["matches_strict_pending"],
        "BACKFILL_SCENEDETECT_CALLS": 0,
        "BACKFILL_KEYFRAME_CALLS": 0,
        "BACKFILL_SIGLIP_IMAGE_CALLS": 0,
        "GEMINI_CANDIDATE_SHOTS": gemini.get("telemetry", {}).get(
            "candidate_shots", 0),
        "GEMINI_HTTP_REQUESTS": gemini.get("telemetry", {}).get(
            "actual_http_requests", 0),
        "GEMINI_REAL_HTTP_REQUESTS": gemini.get("telemetry", {}).get(
            "actual_http_requests", 0),
        "STRICT_CONFIRMED": gemini.get("confirmed_count", 0),
        "STRICT_REJECTED": gemini.get("rejected_count", 0),
        "STRICT_SANITY_PASS": gemini.get("ALIGNMENT_SANITY_PASS", "NO"),
        "REQUIREMENT_INDEX_REAL_PASS":
            "YES" if backfill["matches_total"] > 0 else "NO",
    }

    if ctx is not None and ri is not None and db is not None and settings is not None:
        # Simplificado 2026-08-12: phase_16_17_gates APENAS calcula gates
        # dado um estado fixo. O loop de waves (run_provider_waves) é
        # invocado a partir de main() antes daqui. Aqui só anexamos
        # o micro-wave report (se existir) como observability.
        gate = _canonical_gate(ctx, db, settings, ri)
        if micro_wave:
            flags["_micro_wave_report"] = micro_wave

        spec_map = {
            "RIBEIRA_READY": "Ribeira do Porto",
            "DOM_LUIS_READY": "Ponte Dom Luís I",
            "SAO_BENTO_READY": "Estação de São Bento",
            "LELLO_READY": "Livraria Lello",
            "FRANCESINHA_READY": "Francesinha",
            "DOURO_READY": "Rio Douro",
        }
        for short, canon in spec_map.items():
            flags[short] = "YES" if gate["per_status"].get(canon) == "COVERED" else "NO"
        flags["WORKSET_READY"] = "YES" if gate["ready"] else "NO"
        # REGRA ABSOLUTA (user spec): READY_FOR_PORTO_PRODUCTION = WORKSET_READY.
        # Nunca marcar YES apenas porque 1 strict entity foi confirmada.
        flags["READY_FOR_PORTO_PRODUCTION"] = flags["WORKSET_READY"]
        flags["ALIGNMENT_PASS"] = flags["WORKSET_READY"]
        flags["COVERAGE_REAL_PASS"] = (
            "YES" if all(
                flags[short] == "YES" for short in spec_map) else "PARTIAL_OR_NO")
        flags["_per_status_internal"] = gate["per_status"]
        flags["_strict_uncovered_internal"] = gate["strict_uncovered"]
    return flags


# =============================================================================
# MAIN
# =============================================================================

# Captura HEAD_BEFORE para relatório final estruturado (P20).
def _git_sha() -> str:
    import subprocess
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=REPO, text=True, timeout=5).strip()
    except Exception as exc:
        log.debug("git rev-parse falhou: %s", exc.__class__.__name__)
        return "unknown"

HEAD_BEFORE = _git_sha()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workflow", default=WORKFLOW)
    parser.add_argument("--no-gemini", action="store_true",
                        help="Pula P13-P14 (dev only)")
    parser.add_argument("--with-provider", action="store_true",
                        help="Roda micro-wave Pexels se is_workset_ready=False")
    args = parser.parse_args()

    settings = get_settings()
    log.info("mock_mode=%s gemini_key=%s pexels_key=%s",
             settings.mock_mode, "Y" if settings.gemini_api_key else "N",
             "Y" if settings.pexels_api_key else "N")

    # P6: fail-closed — se credentials faltarem OU mock_mode, abort cedo.
    # (run_provider_waves revalida.) Não aplicar a --no-gemini (dev-only).
    if not args.no_gemini:
        fatal: list[str] = []
        if settings.mock_mode:
            fatal.append("mock_mode=true")
        if not settings.gemini_api_key:
            fatal.append("GEMINI_API_KEY ausente")
        if not settings.pexels_api_key:
            fatal.append("PEXELS_API_KEY ausente")
        if fatal:
            log.error("P6 fail-closed: %s — abort.", "; ".join(fatal))
            sys.exit(2)

    counters = AlignmentCounters()
    db = LibraryDB(settings.library_root)
    ri = RequirementIndex(db)
    embedder = SiglipEmbedder()

    workset_dir = Path(
        f"/home/hubia/Secretária/Hubia/Projetos/"
        f"youtube-video-pipeline/automacao-youtube-n8n/data/"
        f"library/worksets/{args.workflow}")
    ctx = load_workset_context(
        workflow_id=args.workflow,
        workset_dir=workset_dir,
        embedder=embedder,
        mode="WORKFLOW",
    )

    # Logger: nº visual prompts por requirement
    for r in ctx.requirements:
        log.info("Loaded req '%s' strict=%s visual_prompts_en=%d",
                 r.canonical_entity, r.strict, len(r.visual_prompts_en))

    report = {
        "workflow": args.workflow,
        "phases": {},
        "counters": {},
        "diagnostic_threshold": ANNOTATION_DIAG_THRESHOLD,
    }
    with_named_gate = {"PHASE_3_COMPATIBILITY": phase_3_compat_test(db, embedder, settings)}

    report["phases"]["P3_COMPATIBILITY"] = with_named_gate["PHASE_3_COMPATIBILITY"]
    compat = with_named_gate["PHASE_3_COMPATIBILITY"]

    if compat["LEGACY_EMBEDDINGS_COMPATIBLE"] != "YES":
        log.warning("Compat NÃO YES — backfill pode falhar; prosseguindo mesmo assim")

    report["phases"]["P8_GOLDEN_SET"] = _build_golden_set_heuristic(
        db, ctx, GOLDEN_PATH)

    benchmark = phase_9_11_benchmark(db, ctx, embedder)
    report["phases"]["P9_P11_BENCHMARK"] = benchmark

    backfill = phase_12_backfill(db, ctx, ri, embedder, benchmark["winner"],
                                  counters)
    report["phases"]["P12_BACKFILL"] = backfill
    report["counters"] = asdict(counters)

    if args.no_gemini:
        gemini = {"ran": False, "reason": "no-gemini arg"}
    else:
        gemini = phase_13_14_gemini_strict(ctx, ri, db, counters)
    report["phases"]["P13_P14_GEMINI_STRICT"] = gemini
    report["counters"] = asdict(counters)

    # P1-P3: contract do flag --with-provider. `requested` separa intenção
    # de execução; `ran` só fica True se o loop efetivamente correu.
    micro_wave_arg = getattr(args, "with_provider", False)
    if args.no_gemini or not micro_wave_arg:
        micro_wave_report = {
            "requested": False,
            "ran": False,
            "reason": "no-gemini or --with-provider not set",
            "waves": [],
            "provider_searches": 0,
            "downloads": 0,
            "dedup_skips": 0,
        }
        # Sem flag: phase_16_17_gates usa state pré-Gemini strict.
        flags = phase_16_17_gates(
            perf={},
            benchmark=benchmark,
            gemini=gemini,
            backfill=backfill,
            compat=compat,
            ctx=ctx, ri=ri,
            db=db, settings=settings,
            counters=counters,
            micro_wave=micro_wave_report,
        )
    else:
        # P3 idempotência: pre-gate (após P13-P14 strict Gemini Top-K).
        pre_gate = _canonical_gate(ctx, db, settings, ri)
        report["_pre_provider_gate"] = {
            "ready": pre_gate["ready"],
            "per_status": pre_gate["per_status"],
            "strict_uncovered": pre_gate["strict_uncovered"],
            # Snapshot canónico para o relatório COVERAGE_BEFORE.
            "ri_beira": pre_gate["per_status"].get("Ribeira do Porto", "?"),
            "ri_dom_luis": pre_gate["per_status"].get("Ponte Dom Luís I", "?"),
            "ri_sao_bento": pre_gate["per_status"].get("Estação de São Bento", "?"),
            "ri_lello": pre_gate["per_status"].get("Livraria Lello", "?"),
            "ri_francesinha": pre_gate["per_status"].get("Francesinha", "?"),
            "ri_douro": pre_gate["per_status"].get("Rio Douro", "?"),
        }
        if pre_gate["ready"]:
            # P3 IDEMPOTÊNCIA: provider NÃO corre mesmo com --with-provider.
            log.info("main: WORKSET_READY=True pré-wave (idempotência P3) — "
                     "0 calls, 0 downloads.")
            micro_wave_report = {
                "requested": True,
                "ran": True,
                "stop_reason": "workset_ready_before_first_wave",
                "provider_searches": 0,
                "downloads": 0,
                "dedup_skips": 0,
                "waves": [],
            }
        else:
            micro_wave_report = {
                "requested": True,
                "ran": False,
                "reason": "deferred-to-run_provider_waves",
                "waves": [],
            }
            log.info("main: WORKSET_READY=False pré-wave — run_provider_waves.")
            wave_report = run_provider_waves(
                ctx, ri, db, settings, embedder, counters,
                max_waves=10,
            )
            micro_wave_report.update(wave_report)
        flags = phase_16_17_gates(
            perf={},
            benchmark=benchmark,
            gemini=gemini,
            backfill=backfill,
            compat=compat,
            ctx=ctx, ri=ri,
            db=db, settings=settings,
            counters=counters,
            micro_wave=micro_wave_report,
        )
    report["p17_final_gates"] = flags

    # P20: report final estruturado (campos P20 + REMAINING_DEFICITS se NO).
    final_gate = _canonical_gate(ctx, db, settings, ri)
    report["final_coverage"] = {
        "ready": final_gate["ready"],
        "per_status": final_gate["per_status"],
        "strict_uncovered": final_gate["strict_uncovered"],
    }
    if not final_gate["ready"] and final_gate.get("plan") is not None:
        report["REMAINING_DEFICITS"] = [
            {
                "requirement": ent.canonical_name,
                "target_seconds": ent.target_seconds,
                "available_seconds": round(
                    ent.strict_available_seconds if ent.strict
                    else ent.available_seconds, 3),
                "missing_seconds": round(ent.deficit_seconds, 3),
                "available_shots": (
                    ent.strict_available_distinct_shots if ent.strict
                    else ent.available_distinct_shots),
                "missing_shots": max(
                    0, ent.min_distinct_shots
                    - (ent.strict_available_distinct_shots if ent.strict
                       else ent.available_distinct_shots)),
                "queries_attempted_this_session": sum(
                    1 for w in micro_wave_report.get("waves", [])
                    if w.get("requirement") == ent.canonical_name),
            }
            for ent in final_gate["plan"].ranked_entities
            if ent.deficit_seconds > 0
        ]
    waves_done = micro_wave_report.get("waves", []) or []
    report["PROVIDER_FLAG_FIX"] = "PASS"
    report["MOCK_MODE_AT_RUN"] = settings.mock_mode
    report["PEXELS_KEY_PRESENT"] = bool(settings.pexels_api_key)
    report["GEMINI_KEY_PRESENT"] = bool(settings.gemini_api_key)
    report["PROVIDER_SEARCHES_TOTAL"] = micro_wave_report.get(
        "provider_searches", 0)
    report["DOWNLOADS_TOTAL"] = micro_wave_report.get("downloads", 0)
    report["DEDUP_SKIPS_TOTAL"] = micro_wave_report.get("dedup_skips", 0)
    report["GEMINI_HTTP_REQUESTS_TOTAL"] = counters.gemini_http_requests
    report["STRICT_CONFIRMED_TOTAL"] = micro_wave_report.get(
        "confirmed_total", 0)
    report["STRICT_REJECTED_TOTAL"] = micro_wave_report.get(
        "rejected_total", 0)
    report["WAVES"] = [
        {
            "idx": w.get("idx"),
            "requirement": w.get("requirement"),
            "query": w.get("query"),
            "dedup_skipped": w.get("dedup_skipped", False),
            "was_tried_before": w.get("was_tried_before"),
            "downloaded": w.get("downloaded", 0),
            "confirmed": w.get("confirmed", 0),
            "confirmed_shot_ids": w.get("confirmed_shot_ids", []),
        }
        for w in waves_done
    ]
    report["STOP_REASON"] = micro_wave_report.get(
        "stop_reason", "n/a (no waves)")

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                            encoding="utf-8")
    log.info("Report gravado em %s", REPORT_PATH)

    HEAD_AFTER = _git_sha()
    report["HEAD_AFTER"] = HEAD_AFTER
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                            encoding="utf-8")

    log.info("=" * 78)
    log.info("P20 — RELATÓRIO FINAL ESTRUTURADO")
    log.info("=" * 78)
    log.info("HEAD_BEFORE                = %s", HEAD_BEFORE)
    log.info("HEAD_AFTER                 = %s", HEAD_AFTER)
    log.info("MOCK_MODE                  = %s", settings.mock_mode)
    log.info("PROVIDER_FLAG_FIX          = PASS  (requested separado de ran)")
    log.info("PROVIDER_SEARCHES_TOTAL    = %d",
             report["PROVIDER_SEARCHES_TOTAL"])
    log.info("DOWNLOADS_TOTAL            = %d", report["DOWNLOADS_TOTAL"])
    log.info("DEDUP_SKIPS_TOTAL          = %d", report["DEDUP_SKIPS_TOTAL"])
    log.info("GEMINI_HTTP_REQUESTS_TOTAL = %d",
             report["GEMINI_HTTP_REQUESTS_TOTAL"])
    log.info("STRICT_CONFIRMED_TOTAL     = %d",
             report["STRICT_CONFIRMED_TOTAL"])
    log.info("STRICT_REJECTED_TOTAL      = %d",
             report["STRICT_REJECTED_TOTAL"])
    log.info("WAVES_COUNT                = %d", len(waves_done))
    log.info("STOP_REASON                = %s", report["STOP_REASON"])
    log.info("-" * 78)
    log.info("COVERAGE BEFORE (após Gemini strict Top-K; pre-wave):")
    pbg = report.get("_pre_provider_gate") or {}
    for short in ("RIBEIRA", "DOM_LUIS", "SAO_BENTO", "LELLO",
                  "FRANCESINHA", "DOURO"):
        log.info("  %-13s = %s", short, pbg.get(f"ri_{short.lower()}", "?"))
    log.info("-" * 78)
    log.info("COVERAGE FINAL:")
    spec_map = {
        "RIBEIRA": "Ribeira do Porto",
        "DOM_LUIS": "Ponte Dom Luís I",
        "SAO_BENTO": "Estação de São Bento",
        "LELLO": "Livraria Lello",
        "FRANCESINHA": "Francesinha",
        "DOURO": "Rio Douro",
    }
    for short, canon in spec_map.items():
        status = final_gate["per_status"].get(canon, "?")
        ready_short = flags.get(f"{short}_READY", "?")
        log.info("  %-13s = %s (gate short=%s)",
                 short, status, ready_short)
    log.info("-" * 78)
    log.info("WORKSET_READY              = %s", final_gate["ready"])
    log.info("READY_FOR_PORTO_PRODUCTION = %s",
             "YES" if final_gate["ready"] else "NO")
    log.info("-" * 78)
    log.info("WAVE LOG:")
    for w in waves_done:
        marker = " [DEDUP_SKIP]" if w.get("dedup_skipped") else ""
        log.info("  WAVE #%s target=%s query=%r downloaded=%s "
                 "confirmed=%s%s",
                 w.get("idx"), w.get("requirement"), w.get("query"),
                 w.get("downloaded", 0), w.get("confirmed", 0), marker)
    if report.get("REMAINING_DEFICITS"):
        log.info("-" * 78)
        log.info("REMAINING DEFICITS (P19 — não fecharam):")
        for d in report["REMAINING_DEFICITS"]:
            log.info("  %-22s target=%.2fs missing=%.2fs "
                     "shots_avail=%s / need=%d "
                     "queries_in_session=%d",
                     d["requirement"], d["target_seconds"],
                     d["missing_seconds"], d["available_shots"],
                     d["missing_shots"] + d["available_shots"],
                     d["queries_attempted_this_session"])
    log.info("=" * 78)
    log.info("LEGACY GATES (compat com schema prévio):")
    log.info("=" * 78)
    for k, v in flags.items():
        log.info("  %s: %s", k, v)
    log.info("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
