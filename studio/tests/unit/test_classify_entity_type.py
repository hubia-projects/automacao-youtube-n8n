"""PORTO FINAL ASSET TEST — bug B1: `_ensure_mandatory_topics` hardcodava
entity_type="place" para QUALQUER tópico mandatório sem EntitySpan. Testa
`classify_entity_type` (classificação real, sem keyword de tópico
específico — funciona para qualquer vídeo)."""
from __future__ import annotations

from studio.library import query_translation as qt


def setup_function(_):
    qt._TYPE_MEM_CACHE.clear()


def test_settings_none_devolve_fallback_place():
    assert qt.classify_entity_type("Bacalhau com natas", "Porto em 24h",
                                   "Porto", None) == "place"


def test_mock_mode_devolve_fallback_sem_chamar_gemini(tmp_path, monkeypatch):
    from studio.config import Settings
    settings = Settings(mock_mode=True, data_root=tmp_path / "data")

    def _boom(*a, **kw):
        raise AssertionError("Gemini não devia ser chamado em mock_mode")
    monkeypatch.setattr("studio.llm.gemini.generate", _boom)

    out = qt.classify_entity_type("Bacalhau com natas", "Porto em 24h",
                                  "Porto", settings)
    assert out == "place"


def test_classifica_comida_como_food(tmp_path, monkeypatch):
    from studio.config import Settings
    settings = Settings(mock_mode=False, data_root=tmp_path / "data",
                       gemini_api_key="fake-key-nao-usada")

    def _fake_generate(prompt, settings, **kw):
        return "food", 0.001
    monkeypatch.setattr("studio.llm.gemini.generate", _fake_generate)

    out = qt.classify_entity_type("Bacalhau com natas", "Porto em 24h",
                                  "Porto", settings)
    assert out == "food"


def test_classifica_landmark(tmp_path, monkeypatch):
    from studio.config import Settings
    settings = Settings(mock_mode=False, data_root=tmp_path / "data",
                       gemini_api_key="fake-key-nao-usada")

    def _fake_generate(prompt, settings, **kw):
        return "landmark", 0.001
    monkeypatch.setattr("studio.llm.gemini.generate", _fake_generate)

    out = qt.classify_entity_type("Sé do Porto", "Porto em 24h",
                                  "Porto", settings)
    assert out == "landmark"


def test_resposta_invalida_cai_no_fallback(tmp_path, monkeypatch):
    from studio.config import Settings
    settings = Settings(mock_mode=False, data_root=tmp_path / "data",
                       gemini_api_key="fake-key-nao-usada")

    def _fake_generate(prompt, settings, **kw):
        return "not-a-real-category", 0.001
    monkeypatch.setattr("studio.llm.gemini.generate", _fake_generate)

    out = qt.classify_entity_type("Algo estranho", "Porto em 24h",
                                  "Porto", settings)
    assert out == "place"


def test_gemini_falha_cai_no_fallback_sem_lancar(tmp_path, monkeypatch):
    from studio.config import Settings
    settings = Settings(mock_mode=False, data_root=tmp_path / "data",
                       gemini_api_key="fake-key-nao-usada")

    def _raise(*a, **kw):
        raise RuntimeError("network down")
    monkeypatch.setattr("studio.llm.gemini.generate", _raise)

    out = qt.classify_entity_type("Torre dos Clérigos", "Porto em 24h",
                                  "Porto", settings)
    assert out == "place"


def test_cache_evita_segunda_chamada_gemini(tmp_path, monkeypatch):
    from studio.config import Settings
    settings = Settings(mock_mode=False, data_root=tmp_path / "data",
                       gemini_api_key="fake-key-nao-usada")

    calls = {"n": 0}

    def _fake_generate(prompt, settings, **kw):
        calls["n"] += 1
        return "food", 0.001
    monkeypatch.setattr("studio.llm.gemini.generate", _fake_generate)

    out1 = qt.classify_entity_type("Pastel de nata", "Porto em 24h", "Porto",
                                   settings)
    out2 = qt.classify_entity_type("Pastel de nata", "Porto em 24h", "Porto",
                                   settings)
    assert out1 == out2 == "food"
    assert calls["n"] == 1
