"""Testes workset_builder.py (item 4 — workset genérico).

Cobre: materialização dos 9 ficheiros canónicos, identidade estável
(mesmo ThemeSpec+script -> mesmo workset_id, reuse sem sobrescrever
theme.json/script.md), scripts diferentes -> worksets diferentes.
"""
from __future__ import annotations

import json

from studio.library.db import LibraryDB
from studio.library.workset_builder import build_workset, compute_workset_id
from studio.script.entities import EntitySpan
from studio.script.scenes import Scene
from studio.theme import ThemeSpec


def _theme() -> ThemeSpec:
    return ThemeSpec.from_cli(
        topic="O que fazer em 24 horas no Porto",
        duration_minutes=3.0,
        required_topics=["Livraria Lello", "Francesinha"],
    )


def _scenes_and_spans():
    scenes = [
        Scene(scene_id="s001", t_in=0.0, t_out=15.0, text="cena Lello",
             primary_entity="Livraria Lello", primary_entity_type="landmark"),
        Scene(scene_id="s002", t_in=15.0, t_out=30.0, text="cena Francesinha",
             primary_entity="Francesinha", primary_entity_type="food"),
    ]
    spans = [
        EntitySpan(entity_id="lello", canonical_name="Livraria Lello",
                  entity_type="landmark", t_in=5.0, t_out=6.5,
                  text="Livraria Lello", aliases=["Lello"], importance=0.9,
                  strict_visual=True, location_context="Porto"),
        EntitySpan(entity_id="francesinha", canonical_name="Francesinha",
                  entity_type="food", t_in=20.0, t_out=21.0,
                  text="Francesinha", aliases=[], importance=0.9,
                  strict_visual=True, location_context="Porto"),
    ]
    return scenes, spans


def test_build_workset_materializa_ficheiros_canonicos(settings):
    db = LibraryDB(settings.library_root)
    scenes, spans = _scenes_and_spans()
    result = build_workset(_theme(), "script de teste", scenes, spans, db, settings)

    wdir = result.workset_dir
    expected = [
        "theme.json", "script.md", "topics.json", "visual_requirements.json",
        "coverage.json", "selected_shots.json", "search_history.json",
        "acquisition_report.json", "performance.json",
    ]
    for name in expected:
        assert (wdir / name).exists(), f"falta {name}"

    theme_doc = json.loads((wdir / "theme.json").read_text("utf-8"))
    assert theme_doc["mandatory_topics"] == ["Livraria Lello", "Francesinha"]

    vr = json.loads((wdir / "visual_requirements.json").read_text("utf-8"))
    canonicals = {r["canonical_entity"] for r in vr["requirements"]}
    assert "Livraria Lello" in canonicals
    assert "Francesinha" in canonicals
    # required_seconds da Scene (15s), não da frase EntitySpan (1.5s) — item 6
    lello_req = next(r for r in vr["requirements"]
                     if r["canonical_entity"] == "Livraria Lello")
    assert lello_req["required_seconds"] == 15.0

    coverage_doc = json.loads((wdir / "coverage.json").read_text("utf-8"))
    assert "is_workset_ready" in coverage_doc


def test_reuse_mesmo_theme_e_script_mesmo_workset_id(settings):
    db = LibraryDB(settings.library_root)
    scenes, spans = _scenes_and_spans()
    theme = _theme()
    r1 = build_workset(theme, "script fixo", scenes, spans, db, settings)
    r2 = build_workset(theme, "script fixo", scenes, spans, db, settings)
    assert r1.workset_id == r2.workset_id
    assert r1.reused is False
    assert r2.reused is True


def test_script_diferente_workset_id_diferente():
    theme = _theme()
    id1 = compute_workset_id(theme, "script A")
    id2 = compute_workset_id(theme, "script B")
    assert id1 != id2


def test_reuse_nao_sobrescreve_theme_json(settings, tmp_path):
    db = LibraryDB(settings.library_root)
    scenes, spans = _scenes_and_spans()
    theme = _theme()
    r1 = build_workset(theme, "script fixo", scenes, spans, db, settings)
    original = (r1.workset_dir / "theme.json").read_text("utf-8")

    # segunda chamada com scenes/spans DIFERENTES não deve alterar theme.json
    # (identidade já existe — só topics/coverage remedem)
    r2 = build_workset(theme, "script fixo", [], [], db, settings)
    assert (r2.workset_dir / "theme.json").read_text("utf-8") == original
