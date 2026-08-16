"""Item E/F/G (closure pass): biblioteca global existente primeiro (sem
re-embed) + RequirementIndex como fonte primária de coverage.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np

from studio.library.requirement_index import (
    CS_CONFIRMED,
    CS_NOT_REQUIRED,
    CS_PENDING,
    RequirementIndex,
    RequirementMatch,
)
from studio.library.requirement_matching import index_existing_shots_against_workset
from studio.matching.coverage_plan import EntityCoverage, measure_coverage_from_index


def _vec_cos(cos_theta: float) -> np.ndarray:
    theta = np.arccos(np.clip(cos_theta, -1.0, 1.0))
    return np.array([np.cos(theta), np.sin(theta)], dtype=np.float32)


class _Spec:
    def __init__(self, canonical, requirement_id, strict=True):
        self.canonical_entity = canonical
        self.requirement_id = requirement_id
        self.strict = strict


def _ctx(specs, embeddings):
    ctx = MagicMock()
    ctx.workset_id = "wid-1"
    ctx.canonicals.return_value = [s.canonical_entity for s in specs]
    by_canon = {s.canonical_entity: s for s in specs}
    ctx.req_by_canonical.side_effect = lambda c: by_canon.get(c)
    ctx.requirement_embeddings = embeddings
    ctx.visual_prompt_embeddings = {}
    return ctx


def test_compact_chama_optimize_com_cleanup_imediato():
    """BUG REAL (PORTO FINAL RETRIEVAL FIX, 2026-08-16): upsert_match() é
    2 escritas versionadas (delete+add) sem vacuum nenhum — em produção a
    tabela requirement_matches acumulou 246805 versões para 8610 linhas
    reais (163G, disco raiz a 0 bytes livres). compact() tem de chamar
    optimize(cleanup_older_than=timedelta(0)) para remover versões
    supersedidas imediatamente (sem janela de time-travel — este projecto
    não depende de rollback histórico da RequirementIndex)."""
    from datetime import timedelta

    ri = RequirementIndex(db=MagicMock(library_root=None))
    fake_tab = MagicMock()
    ri._table = lambda: fake_tab

    assert ri.compact() is True
    fake_tab.optimize.assert_called_once_with(
        cleanup_older_than=timedelta(0), delete_unverified=True)


def test_compact_sem_tabela_lancedb_devolve_false_sem_rebentar():
    ri = RequirementIndex(db=MagicMock(library_root=None))
    ri._table = lambda: None

    assert ri.compact() is False


def test_compact_optimize_falha_nao_propaga_excepcao():
    ri = RequirementIndex(db=MagicMock(library_root=None))
    fake_tab = MagicMock()
    fake_tab.optimize.side_effect = RuntimeError("boom")
    ri._table = lambda: fake_tab

    assert ri.compact() is False


def test_index_existing_shots_against_workset_persiste_apenas_matches_relevantes():
    spec = _Spec("Livraria Lello", "R01")
    ctx = _ctx([spec], {"Livraria Lello": _vec_cos(1.0)})
    db = MagicMock()
    db.iter_rows.return_value = [
        {"shot_id": "shot_a", "media_sha": "shaA", "t_in": 0.0, "t_out": 3.0,
         "vec": _vec_cos(0.95)},
        {"shot_id": "shot_b", "media_sha": "shaB", "t_in": 0.0, "t_out": 2.0,
         "vec": _vec_cos(-0.9)},
    ]
    ri = RequirementIndex(db=MagicMock(library_root=None))
    written = []
    ri.upsert_match = lambda m: (written.append(m) or True)

    stats = index_existing_shots_against_workset(ctx, db, ri)
    assert stats["shots_scanned"] == 2
    assert stats["matches_written"] == 1
    assert written[0].shot_id == "shot_a"
    assert written[0].requirement_id == "R01"


def test_measure_coverage_from_index_usa_matches_confirmados_strict(tmp_path):
    from studio.library.db import LibraryDB
    db = LibraryDB(tmp_path / "lib")
    spec = _Spec("Livraria Lello", "R01", strict=True)
    ctx = _ctx([spec], {})
    ent = EntityCoverage(
        canonical_name="Livraria Lello", entity_type="landmark",
        priority_score=1.0, mention_count=1, required_seconds=10.0,
        target_seconds=12.0, min_distinct_shots=2, strict=True,
    )
    ri = MagicMock()
    ri.list_for_requirement.return_value = [
        RequirementMatch(workset_id="wid-1", requirement_id="R01",
                         shot_id="s1", media_sha="sha1", similarity=0.9,
                         duration=5.0, confirmation_status=CS_CONFIRMED,
                         confirmation_confidence=0.9, strict_eligible=True),
        RequirementMatch(workset_id="wid-1", requirement_id="R01",
                         shot_id="s2", media_sha="sha2", similarity=0.5,
                         duration=5.0, confirmation_status=CS_PENDING,
                         confirmation_confidence=0.0, strict_eligible=True),
    ]
    db.add_shots([
        {"shot_id": "s1", "media_sha": "sha1", "t_in": 0.0, "t_out": 5.0,
         "media_path": "/x/s1.mp4", "vec": [0.0] * 768, "quality": 5,
         "revoked": False, "places_csv": "", "landmarks_csv": "",
         "food_csv": "", "usage_count": 0, "last_used_run": "",
         "meta_json": "{}", "restricted": False},
        {"shot_id": "s2", "media_sha": "sha2", "t_in": 0.0, "t_out": 5.0,
         "media_path": "/x/s2.mp4", "vec": [0.0] * 768, "quality": 5,
         "revoked": False, "places_csv": "", "landmarks_csv": "",
         "food_csv": "", "usage_count": 0, "last_used_run": "",
         "meta_json": "{}", "restricted": False},
    ])

    applied = measure_coverage_from_index(ent, ctx, ri, db)
    assert applied is True
    # só s1 (CONFIRMED) conta — s2 é PENDING, não elegível para strict.
    assert ent.available_distinct_shots == 1
    assert ent.available_seconds == 5.0
    assert ent.available_shot_ids == {"s1"}


def test_measure_coverage_from_index_sem_matches_devolve_false_para_fallback():
    spec = _Spec("Livraria Lello", "R01")
    ctx = _ctx([spec], {})
    ent = EntityCoverage(
        canonical_name="Livraria Lello", entity_type="landmark",
        priority_score=1.0, mention_count=1, required_seconds=10.0,
        target_seconds=12.0, min_distinct_shots=2, strict=True,
    )
    ri = MagicMock()
    ri.list_for_requirement.return_value = []
    applied = measure_coverage_from_index(ent, ctx, ri, MagicMock())
    assert applied is False


def test_measure_coverage_from_index_non_strict_aceita_not_required():
    spec = _Spec("filler:porto", "R02", strict=False)
    ctx = _ctx([spec], {})
    ent = EntityCoverage(
        canonical_name="filler:porto", entity_type="other_visual",
        priority_score=-1.0, mention_count=0, required_seconds=10.0,
        target_seconds=12.0, min_distinct_shots=2, strict=False,
    )
    ri = MagicMock()
    ri.list_for_requirement.return_value = [
        RequirementMatch(workset_id="wid-1", requirement_id="R02",
                         shot_id="s3", media_sha="sha3", similarity=0.3,
                         duration=4.0, confirmation_status=CS_NOT_REQUIRED,
                         confirmation_confidence=0.0, strict_eligible=False),
    ]
    db = MagicMock()
    db.get_shot.return_value = {"shot_id": "s3", "media_sha": "sha3",
                                "t_in": 0.0, "t_out": 4.0}
    applied = measure_coverage_from_index(ent, ctx, ri, db)
    assert applied is True
    assert ent.available_distinct_shots == 1
    assert ent.available_seconds == 4.0
