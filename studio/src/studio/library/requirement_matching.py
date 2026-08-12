"""requirement_matching.py — geração de `RequirementMatch` semanticamente
justificados (itens F/E/G/U do closure pass).

Substitui o anti-padrão "all shots × all requirements, similarity=0.0"
(encontrado em `reconcile.py`) por um match real: cosine do vector do shot
contra `WorksetContext.requirement_embeddings`/`visual_prompt_embeddings`
(banco multi-prompt, score = max), só persistido se exceder um floor de
similaridade. Sem re-embed — os vectores dos shots já estão armazenados em
LanceDB; os embeddings dos requirements já estão pré-computados no
`WorksetContext` (uma vez, no load).

Usado por:
- `reconcile.py` (P6/P7 — persistência pós-ingest do fluxo offline).
- `stages/produce.py` S08Matching (itens E/G/U — mesmo mecanismo para o
  pipeline vivo, tanto para shots já existentes na biblioteca global como
  para shots recém-adquiridos).
"""
from __future__ import annotations

import numpy as np

from studio.library.requirement_index import (
    CS_NOT_REQUIRED,
    CS_PENDING,
    RequirementMatch,
)

DEFAULT_MIN_SIMILARITY = 0.18  # mesmo floor do SigLIP triage (POSSIBLE tier)


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na < 1e-8 or nb < 1e-8:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def matches_for_shot(
    *,
    shot_id: str,
    media_sha: str,
    t_in: float,
    t_out: float,
    shot_vec,
    workset_ctx,
    min_similarity: float = DEFAULT_MIN_SIMILARITY,
) -> list[RequirementMatch]:
    """1 shot -> lista de `RequirementMatch` semanticamente justificados.

    Só requirements cuja similaridade (max cosine contra o banco
    multi-prompt, ou o single embedding se não houver banco) exceda
    `min_similarity` recebem um match. Requirements sem embedding
    disponível são ignorados (nunca criam match cego).

    strict -> `CS_PENDING` (aguarda confirmação Vision).
    non-strict -> `CS_NOT_REQUIRED` (candidato semântico aceite; Vision
    não é necessária para este match, per doutrina item F).
    """
    if shot_vec is None or workset_ctx is None:
        return []
    vec = np.asarray(shot_vec, dtype=np.float32)
    out: list[RequirementMatch] = []
    for canon in workset_ctx.canonicals():
        spec = workset_ctx.req_by_canonical(canon)
        if spec is None:
            continue
        bank = workset_ctx.visual_prompt_embeddings.get(canon)
        if not bank:
            rv = workset_ctx.requirement_embeddings.get(canon)
            bank = [rv] if rv is not None else []
        if not bank:
            continue
        sim = max(_cosine(vec, rv) for rv in bank)
        if sim < min_similarity:
            continue
        status = CS_PENDING if spec.strict else CS_NOT_REQUIRED
        out.append(RequirementMatch(
            workset_id=workset_ctx.workset_id,
            requirement_id=spec.requirement_id,
            shot_id=shot_id,
            media_sha=media_sha,
            similarity=round(sim, 4),
            duration=max(0.0, t_out - t_in),
            confirmation_status=status,
            confirmation_confidence=0.0,
            strict_eligible=bool(spec.strict),
            evidence=("semantic_triage",),
        ))
    return out


def index_existing_shots_against_workset(
    workset_ctx,
    db,
    ri,
    *,
    limit: int = 5000,
    min_quality: int = 4,
    min_similarity: float = DEFAULT_MIN_SIMILARITY,
) -> dict:
    """item E/G: biblioteca global EXISTENTE primeiro, sem re-embed.

    Scan directo de `db.iter_rows` (os vectores SigLIP já estão
    armazenados por shot — nunca se re-embed aqui), aplica
    `matches_for_shot` por linha e persiste os matches semanticamente
    justificados via `ri.upsert_match`. Chamado ANTES de qualquer decisão
    de aquisição — a RequirementIndex fica populada com o que a biblioteca
    JÁ tem antes de decidir o que falta comprar (evita repetir sweeps para
    entities que a biblioteca global já cobre).

    Devolve stats {"shots_scanned": N, "matches_written": M} para log/
    telemetria do caller.
    """
    stats = {"shots_scanned": 0, "matches_written": 0}
    if workset_ctx is None:
        return stats
    rows = db.iter_rows(
        f"quality >= {int(min_quality)} AND revoked = false", limit=limit)
    stats["shots_scanned"] = len(rows)
    for row in rows:
        shot_id = row.get("shot_id") or ""
        if not shot_id:
            continue
        matches = matches_for_shot(
            shot_id=shot_id,
            media_sha=row.get("media_sha", ""),
            t_in=float(row.get("t_in", 0.0)),
            t_out=float(row.get("t_out", 0.0)),
            shot_vec=row.get("vec"),
            workset_ctx=workset_ctx,
            min_similarity=min_similarity,
        )
        for m in matches:
            if ri.upsert_match(m):
                stats["matches_written"] += 1
    return stats
