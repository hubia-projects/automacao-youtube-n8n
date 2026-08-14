"""Ingestão — o único caminho para dentro da biblioteca (ARCHITECTURE.md §6).

Fail-closed: sem licença válida → rejeitado. Duplicado (SHA-256) → no-op.
Tudo registado em ingest_log.jsonl.

UPSTREAM-CHANGE 2026-08-11 §P2-P5 (Hot path real):
  - SigLIP triage entre Phase B (SigLIP batch) e Phase C (Gemini):
      HIGH   (cosine ≥ settings.library_triage_high_threshold)  → Gemini batch
      POSSIBLE (≥ library_triage_possible_threshold)             → Gemini batch
      GLOBAL_ONLY                                              → stub sem Gemini
  - HIGH+POSSIBLE shots agrupados e enviados via analyze_shots_batch em
    chunks of settings.library_gemini_batch_size (default 4).
  - GLOBAL_ONLY shots guardam summary="NEEDS_ENRICHMENT" (sem HTTP Gemini).
  - requirement_prompts: dict[canonical_entity -> text_en] pré-calculado
    pelo reconcile (uma embedding_text() por canonical, cache no run).
    Se vazio/None → fallback legacy per-shot analyze_shot (compat retro).
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
from studio.library.metadata import ShotMetadata, analyze_shot, analyze_shots_batch
from studio.library.shots import detect_shots, extract_keyframes
from studio.perf import Profiler

log = logging.getLogger("studio.ingest")

# Tier classifications da triagem SigLIP.
TIER_HIGH = "HIGH_RELEVANCE"
TIER_POSSIBLE = "POSSIBLE_RELEVANCE"
TIER_GLOBAL = "GLOBAL_ONLY"

# Summary dos shots que ficaram em GLOBAL_ONLY (não chamaram Gemini).
NEEDS_ENRICHMENT_SUMMARY = "NEEDS_ENRICHMENT"


@dataclass
class IngestResult:
    status: str  # "ingested" | "skipped_duplicate" | "rejected"
    media_sha: str = ""
    shots_added: int = 0
    cost_usd: float = 0.0
    reason: str = ""
    triage_high: int = 0
    triage_possible: int = 0
    triage_global: int = 0
    gemini_requests: int = 0
    gemini_batches: int = 0


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


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na < 1e-8 or nb < 1e-8:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _triage_shots(
    shot_vecs: dict[str, np.ndarray],
    req_text_embeds: dict[str, np.ndarray | list[np.ndarray]],
    settings: Settings,
) -> dict[str, str]:
    """Cosine entre shot_vec e cada requirement_text_embed; classifica tier.

    Item 20 (retrieval relativo/calibrado, favorece recall): além do
    threshold absoluto (floor de segurança, mantido), um shot também
    entra em TIER_HIGH se estiver no Top-K de candidatos de QUALQUER
    requirement E tiver uma margem sobre a mediana dessa requirement —
    cobre o caso de um requirement específico (ex.: "Livraria Lello") cuja
    melhor correspondência real na biblioteca fica ligeiramente abaixo do
    threshold global 0.30 (thresholds absolutos fixos nunca calibram bem
    para toda a variedade de entidades nomeadas). SigLIP continua a ser
    candidate generator (recall alto) — a confirmação final é o Vision
    oracle (confirmation.py), não este triage.

    Args:
        shot_vecs: shot_id -> vec já calculado em Phase B.
        req_text_embeds: canonical_entity -> text_vec OU lista de
                          text_vecs (multi-prompt bank — item 16 doutrina,
                          score = MAX cosine entre os prompts do banco).
                          Pode ser vazio (sem triage).
        settings: thresholds (library_triage_high_threshold / possible_threshold
                  / library_triage_top_k / library_triage_margin).

    Returns:
        dict[shot_id -> TIER_HIGH|...] (TIER_GLOBAL se req_text_embeds vazio).
    """
    high_t = float(getattr(settings, "library_triage_high_threshold", 0.30) or 0.30)
    pos_t = float(getattr(settings, "library_triage_possible_threshold", 0.18) or 0.18)
    top_k = int(getattr(settings, "library_triage_top_k", 20) or 20)
    margin = float(getattr(settings, "library_triage_margin", 0.05) or 0.05)

    if not req_text_embeds or not shot_vecs:
        # Sem requirements → tudo fica GLOBAL_ONLY (fallback conservativo;
        # caller decide se ainda vale a pena chamar Gemini ou não).
        return {sid: TIER_GLOBAL for sid in shot_vecs}

    # multi-prompt bank: normaliza para lista de vectores por requirement.
    req_vecs: dict[str, list[np.ndarray]] = {
        canon: (v if isinstance(v, list) else [v])
        for canon, v in req_text_embeds.items()
    }

    shot_best: dict[str, float] = {}
    per_req_scores: dict[str, dict[str, float]] = {c: {} for c in req_vecs}
    for sid, svec in shot_vecs.items():
        best_overall = 0.0
        for canon, rvecs in req_vecs.items():
            best_for_req = max((_cosine(svec, rv) for rv in rvecs), default=0.0)
            per_req_scores[canon][sid] = best_for_req
            if best_for_req > best_overall:
                best_overall = best_for_req
        shot_best[sid] = best_overall

    # Top-K + margem por requirement: um shot no Top-K de UMA requirement
    # com margem clara sobre a mediana desse grupo conta como HIGH mesmo
    # sem bater o threshold absoluto global. Com poucos candidatos
    # (n pequeno), a margem sobre a mediana tende a zero — não promove
    # nada indevidamente; só ajuda quando há sinal relativo real.
    top_k_shots: set[str] = set()
    for scores in per_req_scores.values():
        if len(scores) < 3:
            continue  # amostra pequena — sinal relativo não é fiável
        ordered = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        vals = sorted(scores.values())
        median = vals[len(vals) // 2]
        for sid, sc in ordered[:top_k]:
            if sc - median >= margin:
                top_k_shots.add(sid)

    out: dict[str, str] = {}
    for sid, best in shot_best.items():
        if best >= high_t or sid in top_k_shots:
            out[sid] = TIER_HIGH
        elif best >= pos_t:
            out[sid] = TIER_POSSIBLE
        else:
            out[sid] = TIER_GLOBAL
    return out


def _stub_metadata_for_global() -> ShotMetadata:
    """ShotMetadata vazio para GLOBAL_ONLY (sem Gemini call). summary é o
    sentinel 'NEEDS_ENRICHMENT' para o pipeline detectar que precisa de
    enrichment futuro sem marcar como falha."""
    return ShotMetadata(
        summary=NEEDS_ENRICHMENT_SUMMARY,
        places=[],
        landmarks=[],
        food_items=[],
        objects=[],
        ocr_text="",
        shot_type="unknown",
        camera_motion="unknown",
        time_of_day="day",
        indoor_outdoor="unknown",
        people_present=False,
        quality=5,
        defects=["needs_enrichment=true"],
    )


def ingest_file(
    path: Path,
    license_raw: dict | LicenseRecord,
    db: LibraryDB,
    settings: Settings,
    embedder: Embedder,
    *,
    requirement_prompts: dict[str, str] | None = None,
    requirement_embeddings: dict[str, np.ndarray] | None = None,
    visual_prompt_embeddings: dict[str, list] | None = None,
    media_kind: str = "video",
) -> IngestResult:
    """Ingerir 1 ficheiro na biblioteca. Instrumentada via Profiler.

    Categorias instrumentadas (ordenadas por pipeline stage):
      ingest_sha, ingest_copy, ingest_scenedetect, keyframes, siglip,
      triage, gemini_metadata (= total de chamadas Gemini no batch),
      ingest_lancedb, ingest_file (sinal de carga total).

    Args:
        requirement_prompts: canonical_entity -> text_en. Pre-calculado pelo
            reconcile (uma embed_text() por canonical). None ou vazio →
            fallback legacy per-shot analyze_shot (retro-compat).
        requirement_embeddings / visual_prompt_embeddings: item G (closure
            pass) — embeddings JÁ computadas por
            `workset_context.load_workset_context()` (1× por run, cacheadas
            no SiglipEmbedder). Quando fornecido, tem PRIORIDADE sobre
            `requirement_prompts` — evita recomputar embed_text() por
            ficheiro ingerido. `visual_prompt_embeddings` (bank multi-prompt)
            tem prioridade sobre `requirement_embeddings` (single vector)
            por canonical.
        media_kind: "video" (default) ou "image" (item MediaKind — closure
            de cobertura multi-provider). Imagem salta detect_shots/
            extract_keyframes (video-only, exigem duration>0/ffmpeg seek) —
            produz exactamente 1 shot sintético (t_in=0,
            t_out=image_virtual_duration_default_s) com a própria imagem
            como keyframe único. Tudo a seguir (SigLIP embed, triage,
            Gemini metadata, LanceDB row) é kind-agnostic, sem alteração.

    try/finally garante Profiler.record("ingest_file") em TODOS os caminhos
    (happy / rejected / skipped_duplicate).

    Hot path real (§P2-P5 2026-08-11):
      Phase A — detect_shots + extract_keyframes (ffmpeg-bound)
      Phase B — SigLIP batch (UMA chamada para TODOS os keyframes)
      Phase B2 — SigLIP triage (cosine entre shot_vec e req_text_embed)
      Phase C — Gemini batched: HIGH/POSSIBLE em chunks of
                library_gemini_batch_size; GLOBAL_ONLY → stub sem HTTP
      Phase D — LanceDB write
    """
    t_ingest = time.perf_counter()
    shots_out = {"n": 0, "triage_high": 0, "triage_possible": 0,
                 "triage_global": 0, "gemini_requests": 0, "gemini_batches": 0}

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

        # 4. Shots → keyframes → embedding (Pass 4 two-phase)
        # item MediaKind: imagem não tem timeline nem scenes — 1 shot
        # sintético, a própria imagem como único "keyframe" (embed_images
        # trata-o como qualquer outro JPEG). detect_shots/extract_keyframes
        # (ffprobe duration>0 + PySceneDetect + seeks ffmpeg) são
        # inteiramente video-only e saltados aqui.
        if media_kind == "image":
            dur = float(getattr(settings, "image_virtual_duration_default_s", 5.0) or 5.0)
            shots = [(0.0, dur)]
            shot_keyframes_meta = [(0, f"{sha[:12]}_000", [media_path], 0.0, dur)]
        else:
            t_scene = time.perf_counter()
            shots = detect_shots(media_path)
            Profiler.record("ingest_scenedetect", time.perf_counter() - t_scene,
                            items=len(shots))

            # --- Phase A: extract ALL keyframes per shot (ffmpeg-bound) ---
            shot_keyframes_meta = []
            for idx, (t_in, t_out) in enumerate(shots):
                shot_id = f"{sha[:12]}_{idx:03d}"
                kf_dir = settings.library_root / "shots" / sha / shot_id
                t_kf = time.perf_counter()
                keyframes = extract_keyframes(media_path, t_in, t_out, kf_dir)
                Profiler.record("keyframes", time.perf_counter() - t_kf,
                                items=len(keyframes))
                shot_keyframes_meta.append((idx, shot_id, keyframes, t_in, t_out))

        # --- Phase B: UMA chamada SigLIP com TODOS os keyframes ---
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
        shot_slices: list[tuple[int, str, list[Path], float, float, np.ndarray]] = []
        cursor = 0
        for idx, shot_id, kfs, t_in, t_out in shot_keyframes_meta:
            n = len(kfs)
            slot = all_vecs[cursor:cursor + n]
            if slot.shape[0] > 0:
                vec = mean_pool(slot)
            else:
                # Sem keyframes: deterministic placeholder (não zeros,
                # evita collision similarity LanceDB).
                _seed = int.from_bytes(hashlib.sha256(shot_id.encode()).digest()[:8], "big")
                _rng = np.random.default_rng(_seed)
                _placeholder = _rng.standard_normal((1, DIM), dtype=np.float32)
                _norms = np.linalg.norm(_placeholder, axis=-1, keepdims=True)
                _placeholder = _placeholder / np.clip(_norms, 1e-8, None)
                vec = mean_pool(_placeholder)
            shot_slices.append((idx, shot_id, kfs, t_in, t_out, vec))
            cursor += n

        # --- Phase B2: SigLIP triage (HOT path real §P5 2026-08-11) ---
        # Embeddings textuais cacheadas uma vez por run no reconcile.
        # §P4 (TEST 5C): cache key estruturada estável — caller passa
        # workflow_id+req_id+prompt_v+model_id para dedup cross-call.
        req_text_embeds: dict[str, np.ndarray] = {}
        if requirement_embeddings or visual_prompt_embeddings:
            # item G (closure pass): embeddings JÁ computadas 1× por
            # load_workset_context() (WorksetContext.requirement_embeddings /
            # visual_prompt_embeddings) — sem isto, cada ficheiro ingerido
            # refazia embed_text() por canonical (redundante: mesmo texto,
            # mesmo modelo, N vezes por workset). Bank multi-prompt tem
            # prioridade (mesma semântica de _triage_shots: max cosine).
            for canon in set(requirement_embeddings or {}) | set(
                    visual_prompt_embeddings or {}):
                bank = (visual_prompt_embeddings or {}).get(canon)
                if bank:
                    req_text_embeds[canon] = bank
                    continue
                single = (requirement_embeddings or {}).get(canon)
                if single is not None:
                    req_text_embeds[canon] = single
        elif requirement_prompts:
            t_triage = time.perf_counter()
            # Captura contexto uma vez por asset/call. Cached em SiglipEmbedder.
            _wf = (getattr(settings, "video_id", None) or "wf")
            # BUG CORRIGIDO (item 11): usava settings.whisper_model (nome do
            # modelo Whisper/ASR, ex.: "base") como model_id do cache SigLIP
            # — poluía a chave de cache com um valor sem relação ao modelo
            # de embedding real. model_id=None deixa embed_text() usar o seu
            # próprio default (embed.MODEL_ID, "google/siglip-base-...").
            _pv = "v1"
            for canon, text_en in requirement_prompts.items():
                if not text_en:
                    continue
                try:
                    req_text_embeds[canon] = embedder.embed_text(
                        text_en,
                        requirement_id=canon,
                        prompt_version=_pv,
                        workflow_id=_wf,
                    )
                except Exception as exc:
                    log.debug("ingest.embed_text('%s') falhou (%s) — skip prompt",
                              canon, exc.__class__.__name__)
            Profiler.record("triage_embed_text", time.perf_counter() - t_triage,
                            items=len(requirement_prompts))
        shot_tier: dict[str, str] = _triage_shots(
            {sid: vec for _, sid, _, _, _, vec in shot_slices},
            req_text_embeds, settings,
        )
        n_high = sum(1 for v in shot_tier.values() if v == TIER_HIGH)
        n_pos = sum(1 for v in shot_tier.values() if v == TIER_POSSIBLE)
        n_glb = sum(1 for v in shot_tier.values() if v == TIER_GLOBAL)
        shots_out["triage_high"] = n_high
        shots_out["triage_possible"] = n_pos
        shots_out["triage_global"] = n_glb
        log.info("ingest %s: triage HIGH=%d POSSIBLE=%d GLOBAL_ONLY=%d (reqs=%d)",
                 path.name, n_high, n_pos, n_glb, len(req_text_embeds))
        Profiler.record("triage", 0.0, items=len(shot_slices))

        # --- Phase C: Gemini batched (analyze_shots_batch em chunks) ou ---
        # GLOBAL_ONLY stub (sem HTTP). Shots ordenados por idx original para
        # preservar determinismo da inserção LanceDB.
        #
        # Construir metadata_map[shot_id] -> ShotMetadata antes do LanceDB write.
        metadata_map: dict[str, ShotMetadata | None] = {}

        # Caminho novo: trabalha com requirement_prompts e triage.
        if requirement_prompts and any(
                v in (TIER_HIGH, TIER_POSSIBLE) for v in shot_tier.values()):
            batch_size = max(1, int(getattr(settings, "library_gemini_batch_size", 4) or 4))
            # Recolher shots HIGH+POSSIBLE em ordem.
            hp_shots: list[tuple[int, str, list[Path]]] = []
            for idx, sid, kfs, _t_in, _t_out, _vec in shot_slices:
                if shot_tier.get(sid) in (TIER_HIGH, TIER_POSSIBLE):
                    hp_shots.append((idx, sid, kfs))

            # Slice em chunks of batch_size (preservando ordem — chunk 0..4, 4..8, ...)
            n_hp = len(hp_shots)
            n_batches = (n_hp + batch_size - 1) // batch_size
            shots_out["gemini_requests"] = n_batches
            shots_out["gemini_batches"] = n_batches
            log.info("ingest %s: %d HP shots → %d Gemini batches (size=%d)",
                     path.name, n_hp, n_batches, batch_size)
            t_meta = time.perf_counter()
            for b_start in range(0, n_hp, batch_size):
                chunk = hp_shots[b_start:b_start + batch_size]
                batch_input = [(sid, kfs) for _idx, sid, kfs in chunk]
                t_chunk = time.perf_counter()
                results = analyze_shots_batch(
                    batch_input, settings, source_hint=path.name,
                )
                Profiler.record("gemini_metadata",
                                time.perf_counter() - t_chunk,
                                items=1)
                log.debug("ingest %s: batch %d/%d devolveu %d entries",
                          path.name,
                          b_start // batch_size + 1, n_batches,
                          sum(1 for v in results.values() if v[0] is not None))
                for _idx, sid, _kfs in chunk:
                    meta, _cost = results.get(sid, (None, 0.0))
                    metadata_map[sid] = meta
                # (removido code-reviewer #2b — não-op duplicado;
                # n_batches já foi setado antes do loop.)
            Profiler.record("gemini_metadata", time.perf_counter() - t_meta,
                            items=n_batches)

            # shot Skips no batch (e.g. METADATA_INCOMPLETE) — log estruturado
            for _idx, sid, _kfs in hp_shots:
                if metadata_map.get(sid) is None:
                    _log_entry(settings, {
                        "file": str(path), "status": "shot_metadata_incomplete",
                        "shot_id": sid,
                    })

        elif requirement_prompts:
            # Triage correu mas ninguém passou → todos GLOBAL_ONLY abaixo.
            log.info("ingest %s: 0 HP shots — Gemini calls=0 (todos GLOBAL_ONLY)",
                     path.name)
        else:
            # Compat legacy — sem requirement_prompts, fallback per-shot analyze_shot.
            log.debug("ingest %s: legacy per-shot analyze_shot (requirement_prompts vazio)",
                      path.name)
            t_meta = time.perf_counter()
            for _idx, sid, kfs, _t_in, _t_out, _vec in shot_slices:
                try:
                    meta, _cost = analyze_shot(kfs, settings, source_hint=path.name)
                    metadata_map[sid] = meta
                    Profiler.record("gemini_metadata", 0.0, items=1)
                    shots_out["gemini_requests"] += 1
                except Exception as exc:
                    log.warning("shot %s saltado (legacy analyze_shot falhou): %s",
                                sid, exc)
                    metadata_map[sid] = None
            Profiler.record("gemini_metadata",
                            time.perf_counter() - t_meta,
                            items=len(shot_slices))

        # 5. GLOBAL_ONLY slots global → stub metadata status=NEEDS_ENRICHMENT.
        for _idx, sid, kfs, t_in, t_out, _vec in shot_slices:
            if shot_tier.get(sid) == TIER_GLOBAL:
                if sid not in metadata_map:
                    metadata_map[sid] = _stub_metadata_for_global()

        # 6. Construir rows para LanceDB em ordem shot_slices (determinismo).
        rows: list[dict] = []
        now = datetime.now(timezone.utc).isoformat()
        for idx, shot_id, keyframes, t_in, t_out, vec in shot_slices:
            meta = metadata_map.get(shot_id, None)
            if meta is None:
                # skip shot — meta não chegou; virar stub para escrever row.
                meta = _stub_metadata_for_global()
            # negative cache heuristic mantém-se do fluxo antigo (Vision_conf
            # baixa) — mas só quando meta tem evidence (não stub). O stub
            # GLOBAL_ONLY tem summary=NEEDS_ENRICHMENT como sentinel para
            # diferenciar de Vision realmente baixa-conf; este guard (is_stub)
            # protege contra falsos positives no negative_cache
            # (UPSTREAM-CHANGE 2026-08-11 §P5 + code-reviewer #4).
            try:
                min_conf = float(getattr(settings, "entity_confirm_min_confidence", 0.85) or 0.85)
                n_evidence = (
                    len(meta.places or []) + len(meta.landmarks or [])
                    + len(meta.food_items or [])
                )
                vision_conf = round(min(1.0, n_evidence / 8.0), 3)
                # stub GLOBAL_ONLY nunca mete no negative_cache (evidence=0 mas
                # marker explícito NEEDS_ENRICHMENT — distinguir de heurística real)
                is_stub = (meta.summary == NEEDS_ENRICHMENT_SUMMARY)
                if (not is_stub) and vision_conf < min_conf:
                    src_provider = (getattr(lic, "source", "") if lic else "") or "pexels"
                    src_url = (getattr(lic, "source_url", "") if lic else "") or ""
                    db.cache_mark_rejected(
                        src_provider, src_url,
                        f"vision_low_confidence={vision_conf:.2f} [heuristic]",
                    )
                    _log_entry(settings, {
                        "file": str(path), "status": "shot_low_confidence",
                        "shot_id": shot_id,
                        "confidence": vision_conf,
                        "is_heuristic": True,
                    })
            except Exception as exc:
                log.debug("cache_mark_rejected(vision) falhou (não fatal): %s",
                          exc.__class__.__name__)
            rows.append({
                "shot_id": shot_id, "media_sha": sha, "media_kind": media_kind,
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

        # 7. LanceDB writes (pode dominar tempo se shots > 50)
        t_db = time.perf_counter()
        db.add_shots(rows)
        Profiler.record("ingest_lancedb", time.perf_counter() - t_db,
                        items=len(rows))
        shots_out["n"] = len(rows)
        _log_entry(settings, {
            "file": str(path), "status": "ingested", "sha": sha,
            "shots": len(rows),
            "cost_usd": round(sum(
                1 for _ in shot_slices if shot_tier.get(_[1]) in (TIER_HIGH, TIER_POSSIBLE)
            ) * 0.001, 4),  # aproximação grossa para ledger
            "license": lic.license, "source": lic.source,
            "triage_high": n_high, "triage_possible": n_pos, "triage_global": n_glb,
            "gemini_requests": shots_out["gemini_requests"],
        })
        log.info("ingerido %s: %d shots (HIGH=%d POSS=%d GLOBAL=%d, Gemini=%d batches)",
                 path.name, len(rows), n_high, n_pos, n_glb,
                 shots_out["gemini_requests"])
        return IngestResult(
            status="ingested", media_sha=sha, shots_added=len(rows),
            cost_usd=round(sum(
                1 for _ in shot_slices if shot_tier.get(_[1]) in (TIER_HIGH, TIER_POSSIBLE)
            ) * 0.001, 4),
            triage_high=n_high, triage_possible=n_pos, triage_global=n_glb,
            gemini_requests=shots_out["gemini_requests"],
            gemini_batches=shots_out["gemini_batches"],
        )
    finally:
        # cobre TODOS os caminhos (happy / rejected / skipped_duplicate).
        try:
            Profiler.record("ingest_file",
                            time.perf_counter() - t_ingest,
                            items=shots_out["n"])
        except (AttributeError, RuntimeError, TypeError) as exc:
            log.debug("Profiler.record(ingest_file) falhou (%s)",
                      exc.__class__.__name__)
