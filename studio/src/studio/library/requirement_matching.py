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
