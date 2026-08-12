"""Item U (closure pass): media nova adquirida via acquire_for_deficits
entra no workset com RequirementMatch reais (matches_for_shot), nunca com
o anti-padrão cego "all shots x all requirements, similarity=0".
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

from studio.library.acquisition import DeficitItem, acquire_for_deficits


def _vec_cos(cos_theta: float) -> np.ndarray:
    theta = np.arccos(np.clip(cos_theta, -1.0, 1.0))
    return np.array([np.cos(theta), np.sin(theta)], dtype=np.float32)


class _ReqSpec:
    def __init__(self, canonical_entity, requirement_id="R01"):
        self.canonical_entity = canonical_entity
        self.aliases = ()
        self.location = ""
        self.requirement_id = requirement_id
        self.strict = True


def _workset_ctx_stub(spec, embedding):
    ctx = MagicMock()
    ctx.requirements = [spec]
    ctx.workflow_id = "wf-test"
    ctx.workset_id = "wf-test"
    ctx.requirement_prompts = {}
    ctx.canonicals.return_value = [spec.canonical_entity]
    ctx.req_by_canonical.side_effect = lambda c: (
        spec if c == spec.canonical_entity else None)
    ctx.requirement_embeddings = {spec.canonical_entity: embedding}
    ctx.visual_prompt_embeddings = {}
    return ctx


def test_ingest_bem_sucedido_persiste_matches_reais_via_requirement_index():
    spec = _ReqSpec("Livraria Lello")
    ctx = _workset_ctx_stub(spec, _vec_cos(1.0))
    deficit = DeficitItem(
        canonical_entity="Livraria Lello", requirement_id=spec.requirement_id,
        target_seconds=100.0, deficit_seconds=100.0, min_distinct_shots=1,
    )

    def resolver(query, level):
        return [(Path("/tmp/fake_new.mp4"),
                 {"provider": "pexels", "source_url": "http://x/new"})]

    db = MagicMock()
    db.cache_get.return_value = None
    db.iter_rows.return_value = [
        {"shot_id": "new_shot_1", "media_sha": "shaNEW", "t_in": 0.0,
         "t_out": 5.0, "vec": _vec_cos(0.95)},
    ]
    ri = MagicMock()

    with patch("studio.library.acquisition.preflight_media",
              return_value=(True, "")):
        with patch("studio.library.ingest_asset.ingest_asset") as mock_ingest:
            mock_ingest.return_value = (
                MagicMock(status="ingested", media_sha="shaNEW", shots_added=1),
                MagicMock(),
            )
            acquire_for_deficits(
                workset_ctx=ctx, db=db, embedder=MagicMock(),
                settings=MagicMock(mock_mode=True),
                deficit_items=[deficit],
                provider_resolver=resolver,
                remeasure_coverage=lambda: False,
                max_iterations=2,
                requirement_index=ri,
            )
    assert ri.upsert_match.called, (
        "media nova ingerida devia ter gerado >=1 RequirementMatch via "
        "requirement_index.upsert_match"
    )
    written = ri.upsert_match.call_args[0][0]
    assert written.shot_id == "new_shot_1"
    assert written.requirement_id == "R01"


def test_sem_requirement_index_nao_rebenta_comportamento_antigo():
    spec = _ReqSpec("Livraria Lello")
    ctx = _workset_ctx_stub(spec, _vec_cos(1.0))
    deficit = DeficitItem(
        canonical_entity="Livraria Lello", requirement_id=spec.requirement_id,
        target_seconds=100.0, deficit_seconds=100.0, min_distinct_shots=1,
    )

    def resolver(query, level):
        return [(Path("/tmp/fake_new2.mp4"),
                 {"provider": "pexels", "source_url": "http://x/new2"})]

    db = MagicMock()
    db.cache_get.return_value = None

    with patch("studio.library.acquisition.preflight_media",
              return_value=(True, "")):
        with patch("studio.library.ingest_asset.ingest_asset") as mock_ingest:
            mock_ingest.return_value = (
                MagicMock(status="ingested", media_sha="shaNEW2", shots_added=1),
                MagicMock(),
            )
            acq = acquire_for_deficits(
                workset_ctx=ctx, db=db, embedder=MagicMock(),
                settings=MagicMock(mock_mode=True),
                deficit_items=[deficit],
                provider_resolver=resolver,
                remeasure_coverage=lambda: False,
                max_iterations=2,
            )
    assert acq.downloads_succeeded >= 1
