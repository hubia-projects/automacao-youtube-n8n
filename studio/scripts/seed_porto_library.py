"""Seed curated Porto content via Pexels para fechar TEST5C_VALID.

Estratégia §P3 (2026-08-11):
  1. Scout mission: testar PEXELS_API_KEY com 1 download "Ribeira Porto".
  2. Se scout OK, correr 6 entities × 3 query-variants × ≥3 takes (≥18 ideal).
  3. Cada candidate: ffprobe valid → extract 1 frame → embed via SigLIP →
     cosine ≥ 0.18 vs requirement embedding → inserir ingest_asset canónico.
  4. Licença Pexels via validate_license (fonte='pexels', license='pexels').
  5. Idempotência: dedup por SHA-256 em ingest_asset + provider_cache.

Output:
  - Tabela por query (results/downloaded/passed/failed).
  - Aggregate por entity (takes ≥ 0.18, takes < 0.18).
  - JSON em data/runs/porto_seed_<ts>/{summary.json,query_log.jsonl}.

Usage:
  cd <repo>
  uv run --directory studio python scripts/seed_porto_library.py [--scout-only]
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "studio" / "src"))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(REPO / ".env")

from studio.config import get_settings              # noqa: E402
from studio.library.db import LibraryDB             # noqa: E402
from studio.library.embed import SiglipEmbedder     # noqa: E402
from studio.library.ingest_asset import (            # noqa: E402
    ingest_asset, make_orphan_license,
)
from studio.library.licenses import validate_license, LicenseRecord  # noqa: E402
from studio.library.shots import (                  # noqa: E402
    extract_representative_frame, probe_video,
)
from studio.library.sources.pexels import sweep as pexels_sweep  # noqa: E402

log = logging.getLogger("seed_porto")
MEDIA_DIR = REPO / "data" / "library" / "media"
SEED_TMP_DIR = REPO / "data" / "library" / "media_seed_tmp"

# Threshold inicial fallback; valor final lido em main() de settings.
LOW_COSINE_THRESHOLD_FALLBACK = 0.18

# Queries exaustivas por entity (≥3 variants ≥3 takes cada).
# Cada entity tem 3 queries (1 primária + 2 variantes para hedge).
ENTITY_QUERIES: dict[str, list[str]] = {
    "Ribeira do Porto": [
        "Ribeira Porto Portugal", "Porto Ribeira waterfront",
        "Douro riverfront Porto",
    ],
    "Ponte Dom Luís I": [
        "Dom Luis bridge Porto Portugal", "Ponte Dom Luis Porto",
        "Porto iron bridge Dom Luís I",
    ],
    "Estação de São Bento": [
        "São Bento station Porto", "azulejo Porto train station",
        "São Bento railway station historic Porto",
    ],
    "Livraria Lello": [
        "Livraria Lello Porto bookstore interior",
        "Lello bookshop Porto staircase",
        "Harry Potter bookstore Porto Portugal",
    ],
    "Francesinha": [
        "Francesinha Porto sandwich", "francesinha restaurant plate",
        "Porto francesinha food close up",
    ],
    "Rio Douro": [
        "Rio Douro Portugal", "Douro river valley",
        "Douro vineyards Portugal landscape",
    ],
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _embed_requirement(text_en: str, canon: str, settings) -> "np.ndarray":
    import numpy as np
    emb = SiglipEmbedder()
    return emb.embed_text(
        text_en,
        requirement_id=canon,
        prompt_version="v1",
        workflow_id="porto-essencia-001",
        model_id=settings.whisper_model or "siglip-base",
    )


def _cosine(a: "np.ndarray", b: "np.ndarray") -> float:
    import numpy as np
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na < 1e-8 or nb < 1e-8:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def scout_mission(settings) -> bool:
    """Testa que API está funcional com 1 download R01 Ribeira.
    §fix-code-reviewer-1: budget 120s (Pexels cold cache pode levar 60-90s)."""
    print("=== SCOUT MISSION: Ribeira Porto (sentinel, 120s budget) ===")
    if not settings.pexels_api_key:
        print("SCOUT FAIL: PEXELS_API_KEY em falta")
        return False
    SEED_TMP_DIR.mkdir(parents=True, exist_ok=True)
    import concurrent.futures
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            future = ex.submit(
                pexels_sweep,
                query_en="Ribeira Porto Portugal",
                count=1, settings=settings, dest=SEED_TMP_DIR,
            )
            # §fix: 120s para cobrir Pexels cold cache + retries (1+4+10s backoff).
            results = future.result(timeout=120)
    except concurrent.futures.TimeoutError:
        print("SCOUT FAIL: timeout 120s excedido (download lento, API rate-limited, ou rede)")
        return False
    except Exception as exc:
        print(f"SCOUT FAIL: {exc.__class__.__name__}: {exc}")
        return False
    if not results:
        print("SCOUT FAIL: 0 candidatos em 'Ribeira Porto Portugal'")
        return False
    path, lic = results[0]
    size_mb = round(path.stat().st_size / 1024 / 1024, 1)
    print(f"SCOUT OK: {path.name}  size={size_mb}MB  license={lic.get('license')}")
    return True


def _cleanup_seed_tmp() -> None:
    """Helper para cleanup SEED_TMP_DIR em qualquer return path."""
    try:
        import shutil
        shutil.rmtree(SEED_TMP_DIR, ignore_errors=True)
    except Exception:
        pass


def verify_and_ingest(
    mp4_path: Path, license_dict: dict, canon: str,
    req_emb: "np.ndarray", settings, db: LibraryDB,
    req_text: str, embedder: SiglipEmbedder, threshold: float = 0.18,
) -> dict:
    """Verifica SigLIP cosine ≥ threshold antes de inserir via ingest_asset.
    Threshold vem de settings.library_triage_possible_threshold (SSoT).

    Returns structured result para logging.
    """
    probe = probe_video(mp4_path)
    if not probe.valid:
        return {
            "file": mp4_path.name, "entity": canon,
            "ffprobe_ok": False, "reason": f"invalid: {probe.error}",
            "cosine": 0.0, "ingested": False,
        }
    # 1 representative frame → SigLIP cosine vs requirement
    try:
        frame = SEED_TMP_DIR / f"_frame_{mp4_path.stem}.jpg"
        extract_representative_frame(mp4_path, frame, probe.duration)
        vec = embedder.embed_images([frame])[0]
        cos = _cosine(vec, req_emb)
    except Exception as exc:
        return {
            "file": mp4_path.name, "entity": canon,
            "ffprobe_ok": True, "reason": f"siglip_fail: {exc.__class__.__name__}: {exc}",
            "cosine": 0.0, "ingested": False,
        }
    if cos < threshold:
        return {
            "file": mp4_path.name, "entity": canon,
            "ffprobe_ok": True, "reason": f"cosine_low({cos:.4f}<{threshold})",
            "cosine": cos, "ingested": False,
        }
    # Inserir via ingest_asset canónico
    try:
        lic = LicenseRecord(
            source=license_dict["source"],
            source_url=license_dict["source_url"],
            license=license_dict["license"],
            author=license_dict.get("author", ""),
            verified_by=license_dict.get("verified_by", "api"),
        )
        lic = validate_license(lic)
    except Exception as exc:
        return {
            "file": mp4_path.name, "entity": canon,
            "ffprobe_ok": True, "reason": f"license_fail: {exc}",
            "cosine": cos, "ingested": False,
        }
    try:
        result, ast = ingest_asset(
            mp4_path, lic, db, settings, embedder,
            source_id=license_dict["source_url"],
            video_id="porto-essencia-001",
        )
        ingested = (result.shots_added > 0)
        outcome = ast.state.value if ast else "?"
        return {
            "file": mp4_path.name, "entity": canon,
            "ffprobe_ok": True, "reason": outcome,
            "cosine": cos, "ingested": ingested,
            "shots_added": result.shots_added,
            "state": outcome,
        }
    except Exception as exc:
        return {
            "file": mp4_path.name, "entity": canon,
            "ffprobe_ok": True, "reason": f"ingest_fail: {exc.__class__.__name__}: {exc}",
            "cosine": cos, "ingested": False,
        }


def main():
    ap = argparse.ArgumentParser(description="Seed Porto content (Pexels curated).")
    ap.add_argument("--scout-only", action="store_true",
                    help="Apenas corre scout mission e sai")
    ap.add_argument("--per-query", type=int, default=3,
                    help="Quantos takes per query (default 3)")
    ap.add_argument("--max-workers", type=int, default=3,
                    help="Parallel downloads (3-4 safe para rate limit Pexels)")
    args = ap.parse_args()

    from studio.logging_setup import configure_logging
    configure_logging(level=logging.INFO,
                       fmt="%(asctime)s %(name)s %(levelname)s %(message)s")
    settings = get_settings()

    # 0. Scout mission
    if not scout_mission(settings):
        print("\n=== SEED ABORTADO: scout falhou. Verifica PEXELS_API_KEY em .env. ===")
        return 1
    if args.scout_only:
        print("=== SCOUT OK. Use sem --scout-only para correr seed completo. ===")
        return 0

    # §fix-code-reviewer-1: threshold lido de Settings (SSoT, não hardcoded).
    try:
        raw_thr = getattr(settings, "library_triage_possible_threshold",
                          LOW_COSINE_THRESHOLD_FALLBACK)
        THRESHOLD = float(raw_thr or LOW_COSINE_THRESHOLD_FALLBACK)
    except (TypeError, ValueError) as exc:
        log.warning("threshold parse falhou (%s) — fallback 0.18", exc)
        THRESHOLD = LOW_COSINE_THRESHOLD_FALLBACK
    print(f"using cosine threshold: {THRESHOLD} (de settings.library_triage_possible_threshold)")

    # 1. Setup embedder (lazy load, 1× por processo)
    # §fix-code-reviewer-3: usa o MESMO requirements_text do workset
    # (reconcile._build_requirement_prompts) para alinhar cosine entre
    # seed e TEST 5C gates. Sem isto, seed pode adicionar shots que o
    # triage do TEST 5C rejeita.
    print("\n=== SETUP: SiglipEmbedder + 6 requirement embeddings (from workset) ===")
    embedder = SiglipEmbedder()
    from studio.library.reconcile import (
        _load_workset_visual_requirements,
        _build_requirement_prompts,
    )
    work_vr = _load_workset_visual_requirements("porto-essencia-001")
    if not work_vr:
        print("ERROR: workset ausente; abort.")
        _cleanup_seed_tmp()
        return 1
    requirements_text = _build_requirement_prompts(work_vr)
    print(f"  workset loaded: {len(requirements_text)} requirements")
    canonical_queries = set(ENTITY_QUERIES.keys())
    work_canonicals = set(requirements_text.keys())
    overlap = canonical_queries & work_canonicals
    missing_in_workset = canonical_queries - work_canonicals
    extra_in_workset = work_canonicals - canonical_queries
    if missing_in_workset:
        # §fix-code-reviewer-3: abort early em vez de silent run with partial coverage.
        print(f"ERROR: ENTITY_QUERIES keys ausentes no workset: "
              f"{sorted(missing_in_workset)}. Corrigir typos em "
              f"studio/scripts/seed_porto_library.py ou em workset entities.")
        _cleanup_seed_tmp()
        return 3
    if extra_in_workset:
        print(f"  NOTE: workset tem extras (não seed): {sorted(extra_in_workset)}")
    print(f"  cross-filter overlap: {len(overlap)}/{len(canonical_queries)} "
          f"({sorted(overlap)})")
    requirements_text = {k: v for k, v in requirements_text.items()
                        if k in canonical_queries}
    if not requirements_text:
        print("ERROR: 0 requirements após cross-filter ENTITY_QUERIES. "
              "Vê cross-filter overlap acima para diagnosticar.")
        _cleanup_seed_tmp()
        return 2
    req_embs: dict[str, "np.ndarray"] = {}
    for canon, text in requirements_text.items():
        req_embs[canon] = embedder.embed_text(
            text, requirement_id=canon, prompt_version="v1",
            workflow_id="porto-essencia-001",
            model_id=settings.whisper_model or "siglip-base",
        )
    print(f"  req_embs cache stats: {embedder.text_cache_stats}")

    db = LibraryDB(MEDIA_DIR.parent)

    # 2. Loop 6 entities × N queries × M takes
    SEED_TMP_DIR.mkdir(parents=True, exist_ok=True)
    aggregate: dict[str, dict] = {
        canon: {"queries": 0, "candidates": 0, "downloaded": 0,
                 "verified_high": 0, "verified_low": 0, "ingested": 0,
                 "files": []}
        for canon in ENTITY_QUERIES
    }
    query_log: list[dict] = []
    t_start = time.perf_counter()

    for canon, queries in ENTITY_QUERIES.items():
        print(f"\n=== ENTITY {canon} ===")
        for q in queries:
            print(f"  query: '{q}'")
            try:
                results = pexels_sweep(
                    query_en=q, count=args.per_query,
                    settings=settings, dest=SEED_TMP_DIR,
                )
            except Exception as exc:
                print(f"  sweep ERROR: {exc.__class__.__name__}: {exc}")
                query_log.append({
                    "entity": canon, "query": q,
                    "results_n": 0, "downloaded_n": 0,
                    "error": f"{exc.__class__.__name__}: {exc}",
                })
                time.sleep(5)
                continue
            aggregate[canon]["queries"] += 1
            aggregate[canon]["candidates"] += len(results)
            print(f"    → {len(results)} candidates")
            query_log.append({
                "entity": canon, "query": q,
                "results_n": len(results), "downloaded_n": len(results),
            })
            # Verify + ingest cada candidate
            for path, lic in results:
                aggregate[canon]["downloaded"] += 1
                res = verify_and_ingest(
                    path, lic, canon, req_embs[canon],
                    settings, db, requirements_text[canon], embedder,
                    threshold=THRESHOLD,
                )
                if res["ingested"]:
                    aggregate[canon]["ingested"] += 1
                    aggregate[canon]["verified_high"] += 1
                    aggregate[canon]["files"].append({
                        "file": res["file"], "cosine": res["cosine"],
                        "shots_added": res.get("shots_added", 0),
                        "state": res.get("state", "?"),
                    })
                    print(f"    ✓ {res['file'][:30]}  cos={res['cosine']:.4f}  "
                          f"shot={res.get('shots_added', '?')}  state={res.get('state', '?')}")
                elif res["ffprobe_ok"] and "low" in res["reason"]:
                    aggregate[canon]["verified_low"] += 1
                    print(f"    − {res['file'][:30]}  cos={res['cosine']:.4f}  {res['reason'][:60]}")
                else:
                    print(f"    ✗ {res['file'][:30]}  reason={res['reason'][:80]}")

    elapsed = time.perf_counter() - t_start

    # 3. Final report
    print("\n=== SEED AGGREGATE ===")
    total_ingested = 0
    total_candidates = 0
    total_queries = 0
    for canon, stats in aggregate.items():
        total_ingested += stats["ingested"]
        total_candidates += stats["candidates"]
        total_queries += stats["queries"]
        print(f"  {canon:30} queries={stats['queries']:2}  "
              f"candidates={stats['candidates']:3}  "
              f"ingested={stats['ingested']:2}  "
              f"verified_low={stats['verified_low']:2}")
    print(f"\n  TOTAL queries={total_queries}  "
          f"candidates={total_candidates}  "
          f"ingested={total_ingested}")
    print(f"  Wall clock: {round(elapsed, 1)}s")
    print(f"  SigLIP text cache at end: {embedder.text_cache_stats}")

    # 4. Save summary
    out_dir = REPO / "data" / "runs" / f"porto_seed_{int(time.time())}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "summary.json").write_text(json.dumps({
        "test": "porto_seed_v1",
        "video_id": "porto-essencia-001",
        "at": _now_iso(),
        "wall_s": round(elapsed, 1),
        "aggregate": aggregate,
        "totals": {
            "queries": total_queries,
            "candidates": total_candidates,
            "ingested": total_ingested,
        },
        "siglip_text_cache": embedder.text_cache_stats,
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        (out_dir / "query_log.jsonl").write_text(
            "\n".join(json.dumps(q) for q in query_log) + "\n",
            encoding="utf-8",
        )
    except Exception as exc:
        log.warning("query_log write falhou (%s) — summary.json ainda salvo", exc)
    print(f"\nSave: {out_dir}/summary.json + query_log.jsonl")
    _cleanup_seed_tmp()
    print(f"cleanup: {SEED_TMP_DIR} removido")
    return 0


if __name__ == "__main__":
    # §fix-code-reviewer-2 (refinado): __main__ propagates return code.
    sys.exit(main())
