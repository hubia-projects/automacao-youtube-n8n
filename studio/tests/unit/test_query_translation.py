"""query_translation.py — bug real (porto-24h-001, 2026-08-13): Pexels/
Pixabay indexam em inglês, canonical_entity em PT nunca batia. Testa o
fallback determinístico (mock_mode/sem key/settings=None) e o cache
(memória + disco) sem exercer rede real."""
from __future__ import annotations

import json

from studio.library import query_translation as qt


def _settings(tmp_path, **kw):
    from studio.config import Settings
    return Settings(mock_mode=True, data_root=tmp_path / "data", **kw)


def setup_function(_):
    qt._MEM_CACHE.clear()


def test_settings_none_devolve_fallback_determinístico():
    out = qt.translate_query_en("Sé do Porto", "landmark", "Porto", None)
    assert out == "Sé do Porto landmark Porto"


def test_mock_mode_devolve_fallback_sem_chamar_gemini(tmp_path, monkeypatch):
    settings = _settings(tmp_path)

    def _boom(*a, **kw):
        raise AssertionError("Gemini não devia ser chamado em mock_mode")
    monkeypatch.setattr("studio.llm.gemini.generate", _boom)

    out = qt.translate_query_en("Ponte Dom Luís I", "landmark", "Porto",
                                settings)
    assert out == "Ponte Dom Luís I landmark Porto"


def test_sem_gemini_api_key_devolve_fallback(tmp_path, monkeypatch):
    from studio.config import Settings
    settings = Settings(mock_mode=False, data_root=tmp_path / "data",
                       gemini_api_key="")

    def _boom(*a, **kw):
        raise AssertionError("Gemini não devia ser chamado sem API key")
    monkeypatch.setattr("studio.llm.gemini.generate", _boom)

    out = qt.translate_query_en("Livraria Lello", "landmark", "Porto",
                                settings)
    assert out == "Livraria Lello landmark Porto"


def test_gemini_falha_cai_no_fallback_sem_lançar(tmp_path, monkeypatch):
    from studio.config import Settings
    settings = Settings(mock_mode=False, data_root=tmp_path / "data",
                       gemini_api_key="fake-key-nao-usada")

    def _raise(*a, **kw):
        raise RuntimeError("network down")
    monkeypatch.setattr("studio.llm.gemini.generate", _raise)

    out = qt.translate_query_en("Torre dos Clérigos", "landmark", "Porto",
                                settings)
    assert out == "Torre dos Clérigos landmark Porto"


def test_cache_evita_segunda_chamada_gemini(tmp_path, monkeypatch):
    from studio.config import Settings
    settings = Settings(mock_mode=False, data_root=tmp_path / "data",
                       gemini_api_key="fake-key-nao-usada")

    calls = {"n": 0}

    def _fake_generate(prompt, settings, **kw):
        calls["n"] += 1
        return "gothic cathedral facade Porto", 0.001
    monkeypatch.setattr("studio.llm.gemini.generate", _fake_generate)

    out1 = qt.translate_query_en("Sé do Porto", "landmark", "Porto", settings)
    out2 = qt.translate_query_en("Sé do Porto", "landmark", "Porto", settings)
    assert out1 == "gothic cathedral facade Porto"
    assert out2 == "gothic cathedral facade Porto"
    assert calls["n"] == 1, "2ª chamada devia vir do cache (memória), não Gemini outra vez"

    cache_file = settings.library_root / "query_translations_en.json"
    assert cache_file.exists()
    on_disk = json.loads(cache_file.read_text("utf-8"))
    assert any(v == "gothic cathedral facade Porto" for v in on_disk.values())


def test_cache_em_disco_persiste_entre_instâncias_mem_cache_vazia(
    tmp_path, monkeypatch,
):
    from studio.config import Settings
    settings = Settings(mock_mode=False, data_root=tmp_path / "data",
                       gemini_api_key="fake-key-nao-usada")

    def _fake_generate(prompt, settings, **kw):
        return "iron arch bridge Porto", 0.001
    monkeypatch.setattr("studio.llm.gemini.generate", _fake_generate)
    qt.translate_query_en("Ponte Dom Luís I", "landmark", "Porto", settings)

    qt._MEM_CACHE.clear()  # simula novo processo (resume)

    def _boom(*a, **kw):
        raise AssertionError("cache em disco devia evitar nova chamada")
    monkeypatch.setattr("studio.llm.gemini.generate", _boom)

    out = qt.translate_query_en("Ponte Dom Luís I", "landmark", "Porto",
                                settings)
    assert out == "iron arch bridge Porto"
