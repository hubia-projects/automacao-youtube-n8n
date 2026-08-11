"""TEST 5 REAL v3 — processa 5 mp4 NOVOS do data/library/media/, estratificados
por bucket de tamanho (representatividade estatística), captura tabela completa
para o gate de READY_FOR_TEST_50.

Hot path (já wired em §P2-P5):
  ingest_asset → ingest_file → SigLIP batch → triage → Gemini batched →
  LanceDB write → DB verify.

Sampling v3: stratified random (1 mp4 por bucket de tamanho).
Buckets (size em MB): 2-10 / 10-30 / 30-100 / >100. Seed=42 (reprodutível).
Exclui já-DONE via `state["done"]`.

Outputs:
  - Tabela markdown no stdout (per-asset + agregados + coverage after).
  - JSON em data/runs/test5_real_<timestamp>/summary.json + performance.json.

Uso:
    cd <repo>
    uv run --directory studio python scripts/test5_real.py [--limit 5] [--no-save]

NOTA: REQUER venv activo (uv run). pydantic+numpy+timm+lancedb não estão
disponíveis em python3 plain.
"""
from __future__ import annotations

import argparse
import json
import logging
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "studio" / "src"))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(REPO / ".env")

from studio.config import get_settings           # noqa: E402
from studio.library.db import LibraryDB          # noqa: E402
from studio.library.embed import SiglipEmbedder  # noqa: E402
from studio.library.reconcile import (          # noqa: E402
    _build_requirement_prompts,
    _load_workset_visual_requirements,
    _load_state,
    _source_id_for,
)
from studio.library.ingest_asset import (       # noqa: E402
    ingest_asset,
    make_orphan_license,
)
from studio.library.ingest_asset import _path_based_id  # noqa: E402
from studio.perf import Profiler                # noqa: E402

log = logging.getLogger("test5")

MEDIA_DIR = REPO / "data" / "library" / "media"
WORKSET_ID = "porto-essencia-001"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# -----------------------------------------------------------------------------
# Sampling — stratified random (1 mp4 de cada bucket de size, seed fixo)
# -----------------------------------------------------------------------------
def pick_candidates(limit: int, *, seed: int = 42) -> list[Path]:
    """Stratified random: 1 mp4 de cada bucket de tamanho (representatividade).

    Buckets (size em MB): 2-10 / 10-30 / 30-100 / >100. Exclui <2MB (esperado
    0 scenes por asset) e já DONE. Seed=42 garante reprodutibilidade. Falta
    bucket → warning + skip; nunca panic.
    """
    state = _load_state()
    already_done = {d["file"] for d in state.get("done", [])}

    buckets: dict[str, list[Path]] = {
        "2-10MB": [], "10-30MB": [], "30-100MB": [], ">100MB": [],
    }

    def _bucket(sz_mb: float) -> str:
        if sz_mb < 2: return "<2MB"
        if sz_mb < 10: return "2-10MB"
        if sz_mb < 30: return "10-30MB"
        if sz_mb < 100: return "30-100MB"
        return ">100MB"

    all_mp4 = list(MEDIA_DIR.glob("*.mp4"))
    for p in all_mp4:
        if p.name in already_done:
            continue
        sz_mb = p.stat().st_size / 1024 / 1024
        b = _bucket(sz_mb)
        if b in buckets:
            buckets[b].append(p)

    log.info("buckets disponíveis para stratified sampling: " +
             ", ".join(f"{k}={len(v)}" for k, v in buckets.items()))

    random.seed(seed)
    picks: list[Path] = []
    for b in ("2-10MB", "10-30MB", "30-100MB", ">100MB"):
        pool = buckets[b]
        if not pool:
            log.warning("pick_candidates: bucket '%s' vazio — skip", b)
            continue
        pick = random.choice(pool)
        picks.append(pick)
        log.info("pick_candidates: %s → '%s' (%d MB)",
                 b, pick.name, int(pick.stat().st_size // (1024 * 1024)))
        if len(picks) >= limit:
            break
    if len(picks) < limit:
        log.warning("pick_candidates: só %d/%d picks disponíveis", len(picks), limit)
    return picks


# -----------------------------------------------------------------------------
# Per-asset runner
# -----------------------------------------------------------------------------
def run_one(mp4: Path, idx: int, db: LibraryDB, embedder: SiglipEmbedder,
            settings, requirement_prompts: dict[str, str]) -> dict:
    """Processa 1 mp4 via ingest_asset canónico + mede tudo."""
    Profiler.begin()
    t0 = time.perf_counter()
    size_mb = round(mp4.stat().st_size / 1024 / 1024, 1)
    sid = _source_id_for(mp4)
    orphan_lic = make_orphan_license(
        source_id=f"orphan:{sid}",
        attribution_text=f"test5_real ({mp4.name})",
    )
    try:
        result, asset_state = ingest_asset(
            mp4, orphan_lic, db, settings, embedder,
            source_id=sid, video_id=WORKSET_ID,
            requirement_prompts=requirement_prompts,
        )
        elapsed = time.perf_counter() - t0
        return {
            "asset": idx,
            "file": mp4.name,
            "size_mb": size_mb,
            "wall_clock_s": round(elapsed, 1),
            "asset_state": asset_state.state.value if asset_state else "?",
            "media_sha_prefix": (result.media_sha[:12]
                                 if result and result.media_sha else ""),
            "shots_added": result.shots_added if result else 0,
            "triage_high": result.triage_high if result else 0,
            "triage_possible": result.triage_possible if result else 0,
            "triage_global": result.triage_global if result else 0,
            "gemini_requests": result.gemini_requests if result else 0,
            "gemini_batches": result.gemini_batches if result else 0,
            "cost_usd": round(float(result.cost_usd), 6) if result else 0.0,
            "skipped_duplicate": (result.status == "skipped_duplicate")
                if result else False,
            "result_status": result.status if result else "exception",
            "error": None,
        }
    except Exception as exc:
        elapsed = time.perf_counter() - t0
        log.error("[%d] %s — exception: %s", idx, mp4.name, exc)
        return {
            "asset": idx, "file": mp4.name, "size_mb": size_mb,
            "wall_clock_s": round(elapsed, 1),
            "asset_state": "EXCEPTION", "media_sha_prefix": "",
            "shots_added": 0,
            "triage_high": 0, "triage_possible": 0, "triage_global": 0,
            "gemini_requests": 0, "gemini_batches": 0, "cost_usd": 0.0,
            "skipped_duplicate": False, "result_status": "exception",
            "error": f"{exc.__class__.__name__}: {str(exc)[:120]}",
        }


# -----------------------------------------------------------------------------
# Coverage AFTER — schema correto + try/except gracioso
# -----------------------------------------------------------------------------
def compute_coverage_after(work_vr: dict, db: LibraryDB, settings,
                            confirmed_index: dict | None) -> dict:
    """Coverage AFTER: converte work_vr em EntitySpans + plan + is_workset_ready.

    critical: EntitySpan exige entity_id (slug + requirement_id) e location_context.
    """
    try:
        from studio.script.entities import EntitySpan, _slug
        from studio.matching.coverage_plan import (
            build_coverage_plan, is_workset_ready,
        )
        spans: list[EntitySpan] = []
        for req in work_vr.get("requirements", []):
            canon = req.get("canonical_entity", "")
            if not canon:
                continue
            rid = req.get("requirement_id") or "r0000"
            spans.append(EntitySpan(
                entity_id=f"workset_{_slug(canon)}:{rid}",
                canonical_name=canon,
                entity_type=req.get("entity_type", "place"),
                t_in=float(req.get("narration_t_in", 0.0) or 0.0),
                t_out=float(req.get("narration_t_out", 0.0) or 0.0),
                text=canon,
                aliases=list(req.get("aliases", []) or []),
                importance=1.0,
                strict_visual=bool(req.get("strict", False)),
                location_context=req.get("location", "") or "",
            ))
        if not spans:
            return {"ready": False, "per_status": {}, "plan_entities": 0,
                    "error": "no valid spans"}
        plan = build_coverage_plan(spans, db, settings, topic="Porto")
        ready, per_status, _strict_uncovered = is_workset_ready(
            plan, db, settings,
            confirmed_index=confirmed_index or {},
            remeasure=True,
        )
        return {
            "ready": ready,
            "per_status": per_status,
            "strict_uncovered": _strict_uncovered,
            "plan_entities": len(plan.ranked_entities),
        }
    except Exception as exc:
        log.warning("compute_coverage_after falhou: %s", exc)
        return {"ready": False, "per_status": {}, "plan_entities": 0,
                "error": str(exc)[:120]}


# -----------------------------------------------------------------------------
# Presentation helpers
# -----------------------------------------------------------------------------
def emit_markdown_table(rows: list[dict]) -> str:
    headers = ["#", "file", "size_mb", "wall_s", "state",
               "shots", "H/P/G", "gem_req", "cost"]
    lines = ["| " + " | ".join(headers) + " |",
             "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        lines.append(
            f"| {r['asset']} | `{r['file'][:20]}…` | {r['size_mb']} "
            f"| {r['wall_clock_s']} | {r['asset_state'][:14]} "
            f"| {r['shots_added']} "
            f"| {r['triage_high']}/{r['triage_possible']}/{r['triage_global']} "
            f"| {r['gemini_requests']} "
            f"| ${r['cost_usd']} |"
        )
    return "\n".join(lines)


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="TEST 5 real runner (v3 stratified).")
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--no-save", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")

    settings = get_settings()
    print(f"=== TEST 5 REAL v3 (limit={args.limit}, seed={args.seed}) ===")
    print(f"MOCK_MODE={settings.mock_mode}  "
          f"GEMINI_KEY={'set' if settings.gemini_api_key else 'EMPTY'}")

    work_vr = _load_workset_visual_requirements(WORKSET_ID)
    if not work_vr:
        print(f"ERROR: workset {WORKSET_ID}/visual_requirements.json ausente.")
        return 1

    requirement_prompts = _build_requirement_prompts(work_vr)
    print(f"requirement_prompts: {len(requirement_prompts)} entities")
    for k, v in requirement_prompts.items():
        print(f"  - {k!r:30} ← '{v[:60]}'")

    db = LibraryDB(MEDIA_DIR.parent)
    embedder = SiglipEmbedder()
    candidates = pick_candidates(args.limit, seed=args.seed)
    print(f"\ncandidatos ({len(candidates)}):")
    for p in candidates:
        print(f"  {p.name}  ({p.stat().st_size//1024//1024} MB)")

    Profiler.reset()
    rows = []
    for i, mp4 in enumerate(candidates, 1):
        row = run_one(mp4, i, db, embedder, settings, requirement_prompts)
        rows.append(row)
        print(f"\n[{i}/{len(candidates)}] {mp4.name}:")
        print(f"  state={row['asset_state']}  shots={row['shots_added']}  "
              f"triage H/P/G={row['triage_high']}/{row['triage_possible']}/"
              f"{row['triage_global']}  gem={row['gemini_requests']} "
              f"({row['gemini_batches']} batches)  cost=${row['cost_usd']}  "
              f"wall={row['wall_clock_s']}s")

    snap = Profiler.snapshot()

    before = json.loads((REPO / "data" / "library" / "worksets" /
                         WORKSET_ID / "coverage.json").read_text())
    before_not_found = before.get("not_found_count", 0)
    before_covered = before.get("covered_count", 0)

    after = compute_coverage_after(work_vr, db, settings, confirmed_index={})
    print(f"\n=== COVERAGE BEFORE → AFTER ===")
    print(f"BEFORE: not_found={before_not_found}/6  covered={before_covered}/6")
    print(f"AFTER:  per_status={after.get('per_status')}")
    if "error" in after:
        print(f"        compute_coverage_after: {after['error']}")

    # === Aggregate ===
    n_ingested = sum(1 for r in rows if r["asset_state"] == "DONE")
    n_skipped = sum(1 for r in rows if r["skipped_duplicate"])
    n_failed = sum(1 for r in rows
                   if r["asset_state"] not in ("DONE",)
                   and not r["skipped_duplicate"])
    total_shots = sum(r["shots_added"] for r in rows)
    total_high = sum(r["triage_high"] for r in rows)
    total_pos = sum(r["triage_possible"] for r in rows)
    total_glb = sum(r["triage_global"] for r in rows)
    total_gem = sum(r["gemini_requests"] for r in rows)
    total_cost = sum(float(r["cost_usd"]) for r in rows)
    wall_ingested = sum(r["wall_clock_s"] for r in rows
                        if r["asset_state"] == "DONE")
    wall_total = sum(r["wall_clock_s"] for r in rows)

    avg_per_asset_s = (wall_ingested / max(n_ingested, 1)) if n_ingested else 0.0
    assets_per_h = (n_ingested / max(wall_ingested, 1)) * 3600 if wall_ingested else 0.0
    shots_per_h = (total_shots / max(wall_ingested, 1)) * 3600 if wall_ingested else 0.0
    avg_shots_per_gem = (total_shots / max(total_gem, 1))

    print("\n=== TEST 5 SUMMARY ===")
    print(f"Assets processados:        {len(rows)}")
    print(f"DONE:                     {n_ingested}")
    print(f"Skipped (dup):            {n_skipped}")
    print(f"Failed:                   {n_failed}")
    print(f"Total shots:              {total_shots}")
    print(f"Triage HIGH/POSS/GLOBAL:  {total_high}/{total_pos}/{total_glb}")
    print(f"Gemini requests (batches): {total_gem}")
    print(f"Avg shots/request:        {round(avg_shots_per_gem, 2)}")
    print(f"Cost total:               ${round(total_cost, 4)}")
    print(f"Wall (ingested only):     {round(wall_ingested, 1)}s")
    print(f"Wall (total incl. fails): {round(wall_total, 1)}s")
    print(f"Avg per asset (ingested): {round(avg_per_asset_s, 1)}s")
    print(f"Assets/h:                 {round(assets_per_h, 1)}")
    print(f"Shots/h:                  {round(shots_per_h, 1)}")

    print("\n=== PER-ASSET TABLE ===")
    print(emit_markdown_table(rows))

    top_ops = sorted(snap["operations"].items(),
                     key=lambda kv: -kv[1]["seconds"])[:8]
    print("\n=== PROFILER (top 8 ops) ===")
    for cat, st in top_ops:
        print(f"  {cat:24}  {st['seconds']:>8.2f}s  "
              f"({st['calls']} calls, {st['items']} items)")
    print(f"  {'TOTAL wall':24}  {snap['wall_clock_seconds']:>8.2f}s")

    # === Projection ===
    proj_new_assets = 908 - 213  # 695 new
    if avg_per_asset_s > 0 and n_ingested > 0:
        proj_h_new = (proj_new_assets * avg_per_asset_s) / 3600
        proj_h_dup = 0.5
        proj_h_combined = proj_h_new + proj_h_dup
        print("\n=== PROJECTION (900 assets ≈ 695 NEW) ===")
        print(f"NEW INGEST h:        {round(proj_h_new, 1)}")
        print(f"DUPLICATE h:         ~{proj_h_dup:.1f}h")
        print(f"COMBINED realistic:  ~{round(proj_h_combined, 1)}h")
        ready_50 = "YES" if proj_h_combined <= 4 else "NO"
        print(f"READY_FOR_TEST_50 = {ready_50}  "
              f"(proj={round(proj_h_combined, 1)}h, gate=4h)")
    else:
        proj_h_combined = 0.0
        print("\nProjection: NO ingested assets (or worst=0s)")
        print("READY_FOR_TEST_50 = NO_DECISION_PENDING_VALID_RUN")

    if not args.no_save:
        out_dir = REPO / "data" / "runs" / f"test5_real_v3_{int(time.time())}"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "summary.json").write_text(json.dumps({
            "test": "TEST_5_REAL_v3",
            "video_id": WORKSET_ID,
            "at": _now_iso(),
            "seed": args.seed,
            "rows": rows,
            "totals": {
                "assets": len(rows),
                "ingested": n_ingested,
                "skipped": n_skipped,
                "failed": n_failed,
                "shots": total_shots,
                "triage_high": total_high,
                "triage_possible": total_pos,
                "triage_global": total_glb,
                "gemini_requests": total_gem,
                "total_cost_usd": round(total_cost, 4),
                "wall_ingested_s": round(wall_ingested, 1),
                "wall_total_s": round(wall_total, 1),
                "assets_per_h": round(assets_per_h, 1),
                "shots_per_h": round(shots_per_h, 1),
            },
            "coverage_before": before,
            "coverage_after": after,
            "profiler_snapshot": snap,
        }, indent=2, ensure_ascii=False), encoding="utf-8")
        Profiler.write(out_dir)
        print(f"\nSave: {out_dir}/summary.json + performance.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
