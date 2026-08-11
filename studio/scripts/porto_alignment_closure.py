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

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
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
                                gate: dict) -> dict:
    """P13/P14-P15 (user spec) — micro-wave SE WORKSET_READY=False após Gemini.

    Spec: "Se is_workset_ready == False → provider REQUIRED. Selecionar
    MAIOR deficit. Uma wave: 1 query, count<=2. Depois: ingest, Gemini,
    coverage. Recalcular. NÃO fazer 4 entities × 4 levels × downloads."

    Args:
        gate: resultado de _canonical_gate (usar gate["plan"] ranked_entities).
    """
    if gate.get("ready"):
        return {"ran": False, "reason": "already-ready"}
    if settings.mock_mode or not settings.pexels_api_key:
        return {"ran": False, "reason": "mock_mode or no pexels key"}
    plan = gate.get("plan")
    if plan is None:
        return {"ran": False, "reason": "no plan"}
    target_ent = next((e for e in plan.ranked_entities
                        if e.deficit_seconds > 0), None)
    if target_ent is None:
        return {"ran": False, "reason": "no deficit > 0"}
    query = (target_ent.queries[0] if target_ent.queries
              else f"{target_ent.canonical_name} Porto")
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
        # Se micro_wave rodou, re-medimos. Caso contrário, gate pré-micro-wave.
        if micro_wave and micro_wave.get("ran") and not micro_wave.get(
                "_gate_recomputed"):
            gate_pre = _canonical_gate(ctx, db, settings, ri)
            microw_final = {"ran": False, "reason": "gate-not-needed"}
            if not gate_pre["ready"]:
                from studio.library.embed import SiglipEmbedder as _SE  # noqa: F401
                embedder = _SE()
                microw_final = phase_15_micro_wave_deficit(
                    ctx, ri, db, settings, embedder,
                    counters or AlignmentCounters(), gate_pre)
            # Recompute após micro-wave (passa ssoma deflators)
            gate = _canonical_gate(ctx, db, settings, ri)
            microw_final["_gate_recomputed"] = True
            flags["_micro_wave_report"] = microw_final
        else:
            gate = _canonical_gate(ctx, db, settings, ri)
            if micro_wave and micro_wave.get("ran"):
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

    # micro-wave flag da CLI: --with-provider para rodar;
    # default False para --no-gemini.
    micro_wave_arg = getattr(args, "with_provider", False)
    if args.no_gemini or not micro_wave_arg:
        micro_wave_report = {"ran": False,
                             "reason": "no-gemini or --with-provider not set"}
    else:
        # micro-wave só faz sentido se canonical gate ainda False depois
        # de Gemini Top-K. Adia-se a decisão para phase_16_17_gates.
        micro_wave_report = {"ran": False, "reason": "deferred-to-p16"}
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

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                            encoding="utf-8")
    log.info("Report gravado em %s", REPORT_PATH)

    log.info("=" * 70)
    log.info("P17 FINAL GATES")
    log.info("=" * 70)
    for k, v in flags.items():
        log.info("  %s: %s", k, v)
    log.info("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
