"""Ingestão — o único caminho para dentro da biblioteca (ARCHITECTURE.md §6).

Fail-closed: sem licença válida → rejeitado. Duplicado (SHA-256) → no-op.
Tudo registado em ingest_log.jsonl.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.library.embed import DIM, Embedder, mean_pool
from studio.library.licenses import LicenseError, LicenseRecord, validate_license
from studio.library.metadata import analyze_shot
from studio.library.shots import detect_shots, extract_keyframes
from studio.perf import Profiler

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
    """Ingerir 1 ficheiro na biblioteca. Instrumentada via Profiler (Fase 1) — 8 categorias.

    Categorias: ingest_sha, ingest_copy, ingest_scenedetect, keyframes, siglip,
    gemini_metadata, ingest_lancedb, ingest_file (sinal de carga total).
    Acumulam-se em <run>/performance.json + linha resumo PERF para o S08.

    try/finally garante Profiler.record("ingest_file") em TODOS os caminhos:
    happy path (ingested), rejected (licença inválida), skipped_duplicate (já
    ingested). Sem isso, performance.json subestimava volume real de
    invocações (cenários fail-closed desapareciam da observability).
    """
    t_ingest = time.perf_counter()
    # sentinel pattern (mais idiomático que mutable container): o finally
    # lê shots["n"] que o happy-path actualiza; early-returns (rejected /
    # skipped_duplicate) deixam-no em 0. Funciona porque `dict` é mutável
    # por closure — mas é lexicalmente claro que é só um canal de saída.
    shots_out = {"n": 0}

    try:
        # 1. Licença (fail-closed — LIBRARY_POLICY.md)
        try:
            lic = validate_license(license_raw)
        except LicenseError as exc:
            _log_entry(settings, {"file": str(path), "status": "rejected", "reason": str(exc)})
            log.warning("rejeitado (licença): %s — %s", path.name, exc)
            return IngestResult(status="rejected", reason=str(exc))

        # 2. Dedup por conteúdo
        t_sha = time.perf_counter()
        sha = _sha256(path)
        Profiler.record("ingest_sha", time.perf_counter() - t_sha,
                        items=path.stat().st_size if path.exists() else 0)
        if db.media_exists(sha):
            _log_entry(settings, {"file": str(path), "status": "skipped_duplicate", "sha": sha})
            return IngestResult(status="skipped_duplicate", media_sha=sha)

        # 3. Media content-addressed
        media_dir = settings.library_root / "media"
        media_dir.mkdir(parents=True, exist_ok=True)
        media_path = media_dir / f"{sha}{path.suffix.lower()}"
        if not media_path.exists():
            t_copy = time.perf_counter()
            shutil.copy2(path, media_path)
            Profiler.record("ingest_copy", time.perf_counter() - t_copy,
                            items=path.stat().st_size)

        # 4. Shots → keyframes → embedding + metadados (Pass 4 two-phase)
        t_scene = time.perf_counter()
        shots = detect_shots(media_path)
        Profiler.record("ingest_scenedetect", time.perf_counter() - t_scene,
                        items=len(shots))
        rows, total_cost = [], 0.0
        now = datetime.now(timezone.utc).isoformat()

        # --- Phase A: extract ALL keyframes per shot (ffmpeg-bound) ---
        # Ordem preservada = ordem de inserção LanceDB (determinismo). Cada
        # shot guarda o seu índice + slice na lista global para grouping
        # posterior. Mantemos também o path absoluto para o row da DB.
        shot_keyframes_meta: list[tuple[int, str, list[Path], float, float]] = []
        for idx, (t_in, t_out) in enumerate(shots):
            shot_id = f"{sha[:12]}_{idx:03d}"
            kf_dir = settings.library_root / "shots" / sha / shot_id
            t_kf = time.perf_counter()
            keyframes = extract_keyframes(media_path, t_in, t_out, kf_dir)
            Profiler.record("keyframes", time.perf_counter() - t_kf,
                            items=len(keyframes))
            shot_keyframes_meta.append((idx, shot_id, keyframes, t_in, t_out))

        # --- Phase B: UMA chamada SigLIP com TODOS os keyframes ---
        # Speedup esperado ~5-10× vs loop per-shot: eliminando N calls com
        # pequeno batch (profiler mede o tempo da chamada única). O
        # embedder aplica auto-tune (Pass 4) — o batching adaptativo cuida
        # do tamanho ideal sem intervenção do ingest.
        all_kf_paths: list[Path] = [kf for _, _, kfs, _, _ in shot_keyframes_meta
                                     for kf in kfs]
        t_emb = time.perf_counter()
        if all_kf_paths:
            all_vecs = embedder.embed_images(all_kf_paths)
        else:
            all_vecs = np.zeros((0, DIM), dtype=np.float32)
        Profiler.record("siglip", time.perf_counter() - t_emb,
                        items=len(all_kf_paths))
        # Mapping shot_idx -> slice [lo, hi) em all_vecs (ordem preservada).
        shot_slices: list[tuple[int, str, int, int, list[Path], float, float]] = []
        cursor = 0
        for idx, shot_id, kfs, t_in, t_out in shot_keyframes_meta:
            n = len(kfs)
            shot_slices.append((idx, shot_id, cursor, cursor + n, kfs, t_in, t_out))
            cursor += n

        # --- Phase C: metadata Vision + LanceDB write (por-shot, UNchanged APIs) ---
        for idx, shot_id, lo, hi, keyframes, t_in, t_out in shot_slices:
            slot = all_vecs[lo:hi]
            if slot.shape[0] > 0:
                vec = mean_pool(slot)
            else:
                # Sem keyframes (shot vazio) — vec DETERMINÍSTICO-por-shot-id
                # (não zeros, evita colisão similarity LanceDB: vários shots
                # vazios teriam o mesmo vec=0 idêntico, false positives em
                # search_shots()). seed = sha256(shot_id)[:8] é estável por
                # shot entre runs. `import hashlib` já está module-level
                # (não reimport dentro do hot loop — code-reviewer Pass 5).
                _seed = int.from_bytes(hashlib.sha256(shot_id.encode()).digest()[:8], "big")
                _rng = np.random.default_rng(_seed)
                _placeholder = _rng.standard_normal((1, DIM), dtype=np.float32)
                _norms = np.linalg.norm(_placeholder, axis=-1, keepdims=True)
                _placeholder = _placeholder / np.clip(_norms, 1e-8, None)
                vec = mean_pool(_placeholder)
            try:
                t_meta = time.perf_counter()
                meta, cost = analyze_shot(keyframes, settings, source_hint=path.name)
                Profiler.record("gemini_metadata", time.perf_counter() - t_meta,
                                items=1)
            except Exception as exc:
                # shot mau não pode matar o ficheiro inteiro — salta e regista
                log.warning("shot %s saltado (análise falhou): %s", shot_id, exc)
                _log_entry(settings, {"file": str(path), "status": "shot_skipped",
                                      "shot_id": shot_id, "reason": str(exc)[:200]})
                continue
            total_cost += cost
            # Pass 3: negative cache wired — Vision heuristic confidence
            # baixa => cache_mark_rejected(lic.source_url, reason).
            # Heurística: nº evidence fields (places+landmarks+food) >= 8
            # => confidence 1.0; abaixo disso => linear até 0. Phase 3
            # approximation; entity confirm (Fase E) substitui por Vision
            # real em Pass 4+).
            try:
                min_conf = float(getattr(settings, "entity_confirm_min_confidence", 0.85) or 0.85)
                n_evidence = (
                    len(meta.places or []) + len(meta.landmarks or [])
                    + len(meta.food_items or [])
                )
                vision_conf = round(min(1.0, n_evidence / 8.0), 3)
                if vision_conf < min_conf:
                    src_provider = (getattr(lic, "source", "") if lic else "") or "pexels"
                    src_url = (getattr(lic, "source_url", "") if lic else "") or ""
                    db.cache_mark_rejected(
                        src_provider, src_url,
                        f"vision_low_confidence={vision_conf:.2f} [heuristic]",
                    )
                    # code-reviewer Pass 3 C+D: is_heuristic=True no log entry
                    # sinaliza que vision_conf vem de heuristica len(evidence)/8
                    # (nao Vision LLM real). Operador ve flag no log + reason.
                    _log_entry(settings, {"file": str(path), "status": "shot_low_confidence",
                                          "shot_id": shot_id,
                                          "confidence": vision_conf,
                                          "is_heuristic": True})
            except Exception as exc:
                log.debug("cache_mark_rejected(vision) falhou (não fatal): %s",
                          exc.__class__.__name__)
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

        # 5. LanceDB writes (pode dominar tempo se shots > 50)
        t_db = time.perf_counter()
        db.add_shots(rows)
        Profiler.record("ingest_lancedb", time.perf_counter() - t_db,
                        items=len(rows))
        shots_out["n"] = len(rows)   # sinalizar happy-path ao finally
        _log_entry(settings, {"file": str(path), "status": "ingested", "sha": sha,
                              "shots": len(rows), "cost_usd": round(total_cost, 4),
                              "license": lic.license, "source": lic.source})
        log.info("ingerido %s: %d shots (%s)", path.name, len(rows), lic.source)
        return IngestResult(status="ingested", media_sha=sha,
                            shots_added=len(rows), cost_usd=total_cost)
    finally:
        # cobre TODOS os caminhos (happy / rejected / skipped_duplicate).
        # observability-first: Profiler nunca bloqueia o caminho real.
        # ASSIMETRIA INTENCIONAL vs alignment.py: o finally é mais largo
        # (AttributeError+RuntimeError+TypeError) propositadamente — um
        # finally NUNCA deve crashar mesmo se Profiler estiver completamente
        # partido. alignment.py está no hot-path do validate_alignment e
        # usa narrow AttributeError porque bugs reais devem propagar.
        try:
            Profiler.record("ingest_file",
                            time.perf_counter() - t_ingest,
                            items=shots_out["n"])
        except (AttributeError, RuntimeError, TypeError) as exc:
            log.debug("Profiler.record(ingest_file) falhou (%s)",
                      exc.__class__.__name__)
