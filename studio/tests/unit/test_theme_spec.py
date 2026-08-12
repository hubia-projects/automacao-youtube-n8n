"""Testes ThemeSpec (item 2 — contrato tema/tópicos obrigatórios).

Cobre: from_cli, from_brief_file, round-trip via params (retrocompat com
runs antigos que só tinham topic/duration_minutes soltos), e a CLI `run`
que popula `theme_spec` em ctx.params.
"""
from __future__ import annotations

import json

import pytest

from studio.theme import ThemeSpec


def test_from_cli_preserva_mandatory_topics_na_ordem():
    spec = ThemeSpec.from_cli(
        topic="O que fazer em 24 horas no Porto",
        duration_minutes=3.0,
        required_topics=["Sé do Porto", "Ponte Dom Luís I", "Livraria Lello"],
        optional_topics=["Ribeira", "Rio Douro"],
    )
    assert spec.theme == "O que fazer em 24 horas no Porto"
    assert spec.target_duration_minutes == 3.0
    assert spec.mandatory_topics == ["Sé do Porto", "Ponte Dom Luís I", "Livraria Lello"]
    assert spec.optional_topics == ["Ribeira", "Rio Douro"]
    assert spec.language == "pt-PT"


def test_from_cli_sem_topicos_obrigatorios_da_listas_vazias():
    spec = ThemeSpec.from_cli(topic="Lisboa em 1 dia", duration_minutes=5.0)
    assert spec.mandatory_topics == []
    assert spec.optional_topics == []


def test_from_brief_file_aceita_schema_theme_e_topic(tmp_path):
    brief = tmp_path / "brief.json"
    brief.write_text(json.dumps({
        "theme": "Porto essencial",
        "target_duration_minutes": 3.0,
        "mandatory_topics": ["Francesinha", "Livraria Lello"],
        "location": "Porto, Portugal",
    }), encoding="utf-8")
    spec = ThemeSpec.from_brief_file(brief)
    assert spec.theme == "Porto essencial"
    assert spec.mandatory_topics == ["Francesinha", "Livraria Lello"]
    assert spec.location == "Porto, Portugal"

    brief_alias = tmp_path / "brief_alias.json"
    brief_alias.write_text(json.dumps({
        "topic": "Porto essencial",
        "duration_minutes": 3.0,
    }), encoding="utf-8")
    spec2 = ThemeSpec.from_brief_file(brief_alias)
    assert spec2.theme == "Porto essencial"
    assert spec2.target_duration_minutes == 3.0


def test_to_params_from_params_roundtrip():
    spec = ThemeSpec.from_cli(topic="X", duration_minutes=4.0,
                              required_topics=["A", "B"])
    params = {"theme_spec": spec.to_params()}
    restored = ThemeSpec.from_params(params)
    assert restored == spec


def test_from_params_retrocompativel_sem_theme_spec():
    """Runs antigos só tinham topic/duration_minutes soltos em params."""
    params = {"topic": "Vídeo antigo", "duration_minutes": 8.0}
    spec = ThemeSpec.from_params(params)
    assert spec.theme == "Vídeo antigo"
    assert spec.target_duration_minutes == 8.0
    assert spec.mandatory_topics == []


def test_from_params_vazio_da_theme_vazio():
    spec = ThemeSpec.from_params({})
    assert spec.theme == ""
    assert spec.target_duration_minutes == 12.0


def test_from_brief_file_ficheiro_invalido_levanta(tmp_path):
    brief = tmp_path / "nope.json"
    brief.write_text("{not json", encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        ThemeSpec.from_brief_file(brief)
