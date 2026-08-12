"""Item D (closure pass): mandatory_topics do ThemeSpec nunca podem
desaparecer do workset, mesmo quando o extractor de entidades os perde.

Fail-closed: se nenhum Scene menciona o tópico textualmente, não há nada
para ancorar duração/queries — build_workset() levanta
MandatoryTopicUnresolvedError em vez de perder o tópico silenciosamente.
"""
from __future__ import annotations

import pytest

from studio.library.db import LibraryDB
from studio.library.workset_builder import (
    MandatoryTopicUnresolvedError,
    build_workset,
)
from studio.script.entities import EntitySpan
from studio.script.scenes import Scene
from studio.theme import ThemeSpec


def _scene(sid, t_in, t_out, text, primary_entity="") -> Scene:
    return Scene(scene_id=sid, t_in=t_in, t_out=t_out, text=text,
                beat="detail", primary_entity=primary_entity)


def test_mandatory_topic_ausente_do_extractor_mas_presente_na_scene_e_recuperado(
    settings, tmp_path,
):
    db = LibraryDB(tmp_path / "lib_ok")
    theme_spec = ThemeSpec(theme="Porto em 24h",
                           mandatory_topics=["Capela das Almas"])
    scenes = [
        _scene("s01", 0.0, 6.0, "Hoje vamos visitar a Capela das Almas."),
    ]
    # entity_spans NÃO tem "Capela das Almas" — simula miss do extractor.
    spans: list[EntitySpan] = []

    result = build_workset(theme_spec, "script sem menção literal",
                           scenes, spans, db, settings)
    canons = {e.canonical_name for e in result.plan.ranked_entities}
    assert "Capela das Almas" in canons
    vr = (result.workset_dir / "visual_requirements.json").read_text("utf-8")
    assert "Capela das Almas" in vr


def test_mandatory_topic_sem_qualquer_scene_falha_fechado(settings, tmp_path):
    db = LibraryDB(tmp_path / "lib_fail")
    theme_spec = ThemeSpec(theme="Porto em 24h",
                           mandatory_topics=["Torre dos Clérigos"])
    scenes = [_scene("s01", 0.0, 5.0, "Vamos comer uma francesinha.")]

    with pytest.raises(MandatoryTopicUnresolvedError) as exc_info:
        build_workset(theme_spec, "script", scenes, [], db, settings)
    assert "Torre dos Clérigos" in exc_info.value.topics


def test_mandatory_topic_ja_coberto_por_entity_span_nao_duplica(settings, tmp_path):
    db = LibraryDB(tmp_path / "lib_dup")
    theme_spec = ThemeSpec(theme="Porto em 24h",
                           mandatory_topics=["Francesinha"])
    scenes = [_scene("s01", 0.0, 5.0, "Francesinha deliciosa.",
                     primary_entity="Francesinha")]
    span = EntitySpan(entity_id="francesinha:0001", canonical_name="Francesinha",
                      entity_type="food", t_in=0.0, t_out=5.0,
                      text="Francesinha", importance=0.9, strict_visual=True)

    result = build_workset(theme_spec, "script", scenes, [span], db, settings)
    canons = [e.canonical_name for e in result.plan.ranked_entities]
    assert canons.count("Francesinha") == 1
