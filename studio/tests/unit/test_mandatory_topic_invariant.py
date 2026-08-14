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


def test_mandatory_topic_ja_coberto_por_alias_nao_duplica(settings, tmp_path):
    """BUG REAL confirmado em produção (Porto, porto-24h-001): o extractor
    já reconhecia "Galerias de Paris" como alias de "Rua Galeria de
    Paris" (EntityMention.aliases), mas `_ensure_mandatory_topics` só
    comparava canonical_name exacto — cego a aliases — criando um 2º
    requirement sintético duplicado (mesma janela temporal, mesma
    entidade real). Deve ficar 1 SÓ requirement, com "Galerias de Paris"
    fundido como alias."""
    db = LibraryDB(tmp_path / "lib_alias_dup")
    theme_spec = ThemeSpec(theme="Porto em 24h",
                           mandatory_topics=["Galerias de Paris"])
    scenes = [_scene("s01", 0.0, 5.9, "Uma rua icónica: Galerias de Paris.",
                     primary_entity="Rua Galeria de Paris")]
    span = EntitySpan(
        entity_id="rua_galeria_de_paris:0001",
        canonical_name="Rua Galeria de Paris",
        aliases=["Galerias de Paris"],
        entity_type="place", t_in=0.0, t_out=5.9,
        text="Galerias de Paris", importance=0.8, strict_visual=True,
    )

    result = build_workset(theme_spec, "script", scenes, [span], db, settings)
    canons = [e.canonical_name for e in result.plan.ranked_entities]
    assert canons.count("Rua Galeria de Paris") == 1
    assert "Galerias de Paris" not in canons, (
        "não pode criar um 2º requirement sintético para um alias já "
        "coberto pela entity real"
    )
    ent = next(e for e in result.plan.ranked_entities
              if e.canonical_name == "Rua Galeria de Paris")
    assert "Galerias de Paris" in ent.aliases
    vr = (result.workset_dir / "visual_requirements.json").read_text("utf-8")
    assert vr.count("Rua Galeria de Paris") == 1 or vr.count(
        '"canonical_entity": "Rua Galeria de Paris"') == 1
