"""Item H (closure pass): filler contextual geo-correcto.

Antes: `measure_filler_coverage` aceitava QUALQUER shot não-revogado
(clause = "quality >= N AND revoked = false", sem filtro geográfico) e
`build_filler_requirement` nunca recebia `location=` de `build_coverage_plan`
— o banco de prompts caía sempre no genérico "Portugal b-roll...".
"""
from __future__ import annotations

from unittest.mock import MagicMock

from studio.config import Settings
from studio.matching.coverage_plan import (
    EntityCoverage,
    build_coverage_plan,
    build_filler_requirement,
    measure_filler_coverage,
)
from studio.script.entities import EntitySpan


def _span(canonical, etype, t_in, t_out, strict=True):
    return EntitySpan(entity_id=f"{canonical}:0001", canonical_name=canonical,
                      entity_type=etype, t_in=t_in, t_out=t_out,
                      text=canonical, importance=0.8, strict_visual=strict)


def _fake_db_with_geo(rows):
    db = MagicMock()

    def iter_rows(clause, limit=20_000):
        # extrai o(s) padrão(ões) LIKE do clause real (produção) e filtra
        # linha a linha — evita depender do parser simplista doutro ficheiro.
        import re
        likes = re.findall(r"(\w+)\s+LIKE\s+'%([^']+)%'", clause)
        out = []
        for r in rows:
            if likes:
                if not any(pat.lower() in (r.get(col) or "").lower()
                           for col, pat in likes):
                    continue
            out.append(r)
        return out[:limit]

    db.iter_rows = MagicMock(side_effect=iter_rows)
    return db


def test_measure_filler_coverage_sem_location_aceita_qualquer_shot():
    rows = [
        {"shot_id": "s1", "media_sha": "sha1", "t_in": 0.0, "t_out": 5.0,
         "places_csv": "Lisboa", "landmarks_csv": ""},
        {"shot_id": "s2", "media_sha": "sha2", "t_in": 0.0, "t_out": 5.0,
         "places_csv": "Porto", "landmarks_csv": ""},
    ]
    db = _fake_db_with_geo(rows)
    ent = EntityCoverage(canonical_name="filler", entity_type="filler",
                         priority_score=-1.0, mention_count=0,
                         required_seconds=10.0, target_seconds=10.0,
                         min_distinct_shots=1, strict=False)
    measure_filler_coverage(ent, db)
    assert ent.available_distinct_shots == 2


def test_measure_filler_coverage_com_location_filtra_geografia():
    rows = [
        {"shot_id": "s1", "media_sha": "sha1", "t_in": 0.0, "t_out": 5.0,
         "places_csv": "Lisboa", "landmarks_csv": ""},
        {"shot_id": "s2", "media_sha": "sha2", "t_in": 0.0, "t_out": 5.0,
         "places_csv": "Porto", "landmarks_csv": ""},
    ]
    db = _fake_db_with_geo(rows)
    ent = EntityCoverage(canonical_name="filler", entity_type="filler",
                         priority_score=-1.0, mention_count=0,
                         required_seconds=10.0, target_seconds=10.0,
                         min_distinct_shots=1, strict=False)
    measure_filler_coverage(ent, db, location="Porto")
    assert ent.available_distinct_shots == 1
    assert ent.available_shot_ids == {"s2"}


def test_build_filler_requirement_usa_location_real_no_prompt_bank():
    ranked = [EntityCoverage(canonical_name="Livraria Lello",
                             entity_type="landmark", priority_score=1.0,
                             mention_count=1, required_seconds=10.0,
                             target_seconds=12.0, min_distinct_shots=1,
                             strict=True)]
    ent = build_filler_requirement(ranked, 60.0, Settings(), topic="Porto",
                                   location="Porto")
    assert ent is not None
    assert any("Porto" in q for q in ent.queries)
    assert not any("Portugal b-roll" in q for q in ent.queries)


def test_build_coverage_plan_thread_location_para_filler():
    s = Settings()
    span = _span("Livraria Lello", "landmark", t_in=0, t_out=20)
    db = _fake_db_with_geo([])
    plan = build_coverage_plan(
        [span], db, s, topic="Porto", total_script_seconds=180.0,
        include_filler=True, location="Porto")
    filler = next(e for e in plan.ranked_entities if e.entity_type == "filler")
    assert filler.location == "Porto"
    assert any("Porto" in q for q in filler.queries)
