"""Item I/J (closure pass): allocate_shots — selecção real de shots por
requirement + selection feasibility (não mais `selected_shots.json` vazio).
"""
from __future__ import annotations

from unittest.mock import MagicMock

from studio.library.requirement_index import (
    CS_CONFIRMED,
    CS_NOT_REQUIRED,
    CS_PENDING,
    RequirementMatch,
)
from studio.library.selection import allocate_shots
from studio.matching.coverage_plan import EntityCoverage, FILLER_ENTITY_TYPE


class _Spec:
    def __init__(self, canonical, requirement_id):
        self.canonical_entity = canonical
        self.requirement_id = requirement_id


def _ctx(specs):
    ctx = MagicMock()
    ctx.workset_id = "wid-1"
    by_canon = {s.canonical_entity: s for s in specs}
    ctx.req_by_canonical.side_effect = lambda c: by_canon.get(c)
    return ctx


def _plan(entities):
    plan = MagicMock()
    plan.ranked_entities = entities
    return plan


def _match(req_id, shot_id, media_sha, similarity, duration, status,
           media_kind="video"):
    return RequirementMatch(
        workset_id="wid-1", requirement_id=req_id, shot_id=shot_id,
        media_sha=media_sha, similarity=similarity, duration=duration,
        confirmation_status=status, confirmation_confidence=0.0,
        strict_eligible=(status == CS_CONFIRMED), media_kind=media_kind,
    )


def test_strict_so_aloca_confirmados_ate_atingir_target():
    ent = EntityCoverage(canonical_name="Livraria Lello", entity_type="landmark",
                         priority_score=1.0, mention_count=1,
                         required_seconds=8.0, target_seconds=8.0,
                         min_distinct_shots=2, strict=True)
    ctx = _ctx([_Spec("Livraria Lello", "R01")])
    ri = MagicMock()
    ri.list_for_requirement.return_value = [
        _match("R01", "s1", "sha1", 0.9, 5.0, CS_CONFIRMED),
        _match("R01", "s2", "sha2", 0.5, 4.0, CS_PENDING),
        _match("R01", "s3", "sha3", 0.8, 4.0, CS_CONFIRMED),
    ]
    result = allocate_shots(_plan([ent]), ctx, ri)
    assert result.by_requirement["R01"] == ["s1", "s3"]  # PENDING nunca entra
    assert result.feasible_by_requirement["R01"] is True
    assert result.selection_feasible is True


def test_strict_insuficiente_nao_e_feasible():
    ent = EntityCoverage(canonical_name="Livraria Lello", entity_type="landmark",
                         priority_score=1.0, mention_count=1,
                         required_seconds=8.0, target_seconds=20.0,
                         min_distinct_shots=5, strict=True)
    ctx = _ctx([_Spec("Livraria Lello", "R01")])
    ri = MagicMock()
    ri.list_for_requirement.return_value = [
        _match("R01", "s1", "sha1", 0.9, 5.0, CS_CONFIRMED),
    ]
    result = allocate_shots(_plan([ent]), ctx, ri)
    assert result.feasible_by_requirement["R01"] is False
    assert result.selection_feasible is False


def test_shot_nao_e_reutilizado_entre_requirements():
    ent_a = EntityCoverage(canonical_name="A", entity_type="place",
                           priority_score=1.0, mention_count=1,
                           required_seconds=4.0, target_seconds=4.0,
                           min_distinct_shots=1, strict=True)
    ent_b = EntityCoverage(canonical_name="B", entity_type="place",
                           priority_score=0.5, mention_count=1,
                           required_seconds=4.0, target_seconds=4.0,
                           min_distinct_shots=1, strict=True)
    ctx = _ctx([_Spec("A", "RA"), _Spec("B", "RB")])
    ri = MagicMock()

    def list_for(_wid, req_id):
        # o MESMO shot "shared" é candidato de A e B.
        if req_id == "RA":
            return [_match("RA", "shared", "shaS", 0.9, 5.0, CS_CONFIRMED)]
        return [_match("RB", "shared", "shaS", 0.9, 5.0, CS_CONFIRMED)]
    ri.list_for_requirement.side_effect = list_for

    result = allocate_shots(_plan([ent_a, ent_b]), ctx, ri)
    assert result.by_requirement["RA"] == ["shared"]
    assert result.by_requirement["RB"] == [], (
        "shot já alocado a RA não pode ser reutilizado por RB"
    )
    assert result.feasible_by_requirement["RB"] is False


def test_cap_por_media_sha_respeitado():
    ent = EntityCoverage(canonical_name="A", entity_type="place",
                         priority_score=1.0, mention_count=1,
                         required_seconds=20.0, target_seconds=20.0,
                         min_distinct_shots=3, strict=True)
    ctx = _ctx([_Spec("A", "RA")])
    ri = MagicMock()
    # 3 shots, mas TODOS do mesmo media_sha — cap=1 só deixa 1 passar.
    ri.list_for_requirement.return_value = [
        _match("RA", "s1", "sha_same", 0.9, 10.0, CS_CONFIRMED),
        _match("RA", "s2", "sha_same", 0.8, 10.0, CS_CONFIRMED),
        _match("RA", "s3", "sha_same", 0.7, 10.0, CS_CONFIRMED),
    ]
    result = allocate_shots(_plan([ent]), ctx, ri, max_uses_per_media=1)
    assert result.by_requirement["RA"] == ["s1"]


def test_filler_alocado_por_ultimo_non_strict_aceita_not_required():
    filler = EntityCoverage(canonical_name="filler:porto",
                            entity_type=FILLER_ENTITY_TYPE,
                            priority_score=-1.0, mention_count=0,
                            required_seconds=5.0, target_seconds=5.0,
                            min_distinct_shots=1, strict=False)
    ctx = _ctx([_Spec("filler:porto", "RF")])
    ri = MagicMock()
    ri.list_for_requirement.return_value = [
        _match("RF", "f1", "shaF", 0.3, 5.0, CS_NOT_REQUIRED),
    ]
    result = allocate_shots(_plan([filler]), ctx, ri)
    assert result.by_requirement["RF"] == ["f1"]
    assert result.selection_feasible is True


def test_imagem_conta_para_cobertura_via_duration_sintetica():
    """item MediaKind: RequirementMatch.duration de uma imagem já vem
    preenchida com a virtual duration (por construção no ingest, Fase 1)
    — allocate_shots não precisa de tratamento especial de duração."""
    ent = EntityCoverage(canonical_name="Livraria Lello", entity_type="landmark",
                         priority_score=1.0, mention_count=1,
                         required_seconds=5.0, target_seconds=5.0,
                         min_distinct_shots=1, strict=True)
    ctx = _ctx([_Spec("Livraria Lello", "R01")])
    ri = MagicMock()
    ri.list_for_requirement.return_value = [
        _match("R01", "img1", "sha_img1", 0.9, 5.0, CS_CONFIRMED,
              media_kind="image"),
    ]
    result = allocate_shots(_plan([ent]), ctx, ri)
    assert result.by_requirement["R01"] == ["img1"]
    assert result.selection_feasible is True
    assert result.image_seconds_allocated == 5.0
    assert result.total_seconds_allocated == 5.0
    assert result.image_share_overall == 1.0


def test_max_images_per_requirement_limita_diversidade():
    """item 27: mesmo com imagens de sobra, no máx.
    max_images_per_requirement por requirement — nunca 1 requirement toda
    coberta por N imagens sem variedade (ex.: 10 fotos do mesmo ângulo)."""
    ent = EntityCoverage(canonical_name="Livraria Lello", entity_type="landmark",
                         priority_score=1.0, mention_count=1,
                         required_seconds=30.0, target_seconds=30.0,
                         min_distinct_shots=1, strict=True)
    ctx = _ctx([_Spec("Livraria Lello", "R01")])
    ri = MagicMock()
    ri.list_for_requirement.return_value = [
        _match("R01", f"img{i}", f"sha_img{i}", 0.9 - i * 0.01, 5.0,
              CS_CONFIRMED, media_kind="image")
        for i in range(10)
    ]
    result = allocate_shots(_plan([ent]), ctx, ri, max_images_per_requirement=2)
    assert len(result.by_requirement["R01"]) == 2
    assert result.by_requirement["R01"] == ["img0", "img1"]
    # não atingiu target_seconds (só 10s de 30s) -> infeasible, correcto:
    # a diversidade cap é real, não finge cobertura que não existe.
    assert result.selection_feasible is False


def test_video_e_imagem_misturados_computam_share_correcto():
    ent = EntityCoverage(canonical_name="A", entity_type="landmark",
                         priority_score=1.0, mention_count=1,
                         required_seconds=10.0, target_seconds=10.0,
                         min_distinct_shots=2, strict=True)
    ctx = _ctx([_Spec("A", "R01")])
    ri = MagicMock()
    ri.list_for_requirement.return_value = [
        _match("R01", "vid1", "sha_v1", 0.9, 6.0, CS_CONFIRMED,
              media_kind="video"),
        _match("R01", "img1", "sha_i1", 0.8, 4.0, CS_CONFIRMED,
              media_kind="image"),
    ]
    result = allocate_shots(_plan([ent]), ctx, ri)
    assert set(result.by_requirement["R01"]) == {"vid1", "img1"}
    assert result.total_seconds_allocated == 10.0
    assert result.image_seconds_allocated == 4.0
    assert result.image_share_overall == 0.4
