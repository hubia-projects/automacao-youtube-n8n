"""item 42/43 (fecho de cobertura multi-provider): event_sink opcional em
make_provider_resolver/run_acquisition_for_workset — observabilidade fina
(search/dedup/download/escalation) sem acoplar acquisition.py a events.py/
run_dir. Nunca lança (fail-soft) mesmo que o callback do caller rebente."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

from studio.library.acquisition import make_provider_resolver


def test_event_sink_recebe_search_e_download(tmp_path, monkeypatch):
    events = []

    class _FakeCandidate:
        provider = "pexels"
        provider_id = "123"
        source_url = "https://pexels.com/v/123"
        download_url = "https://cdn/123.mp4"
        license = {"source": "pexels", "license": "pexels"}

    fake_mod = MagicMock()
    fake_mod.search.return_value = [_FakeCandidate()]
    fake_mod.download.return_value = tmp_path / "pexels_123.mp4"
    (tmp_path / "pexels_123.mp4").write_bytes(b"x")

    monkeypatch.setattr(
        "studio.library.acquisition._load_provider_module",
        lambda provider: fake_mod)
    monkeypatch.setattr(
        "studio.library.acquisition.is_provider_already_taken",
        lambda *a, **kw: False)

    db = MagicMock()
    settings = MagicMock(mock_mode=False)
    resolver = make_provider_resolver(
        settings, tmp_path, providers=("pexels",), db=db,
        event_sink=lambda et, msg, payload: events.append((et, msg, payload)))
    out = resolver("Livraria Lello", 0)

    assert len(out) == 1
    event_types = [e[0] for e in events]
    assert "provider_search_started" in event_types
    assert "provider_search_completed" in event_types
    assert "media_download_started" in event_types
    assert "media_download_completed" in event_types


def test_event_sink_dedup_skipped(tmp_path, monkeypatch):
    events = []

    class _FakeCandidate:
        provider = "pexels"
        provider_id = "999"
        source_url = "https://pexels.com/v/999"
        download_url = "https://cdn/999.mp4"
        license = {}

    fake_mod = MagicMock()
    fake_mod.search.return_value = [_FakeCandidate()]

    monkeypatch.setattr(
        "studio.library.acquisition._load_provider_module",
        lambda provider: fake_mod)
    monkeypatch.setattr(
        "studio.library.acquisition.is_provider_already_taken",
        lambda *a, **kw: True)

    resolver = make_provider_resolver(
        MagicMock(mock_mode=False), tmp_path, providers=("pexels",),
        db=MagicMock(),
        event_sink=lambda et, msg, payload: events.append((et, msg, payload)))
    out = resolver("q", 0)

    assert out == []
    assert any(e[0] == "candidate_dedup_skipped" for e in events)
    fake_mod.download.assert_not_called()


def test_event_sink_nunca_quebra_resolver_se_lancar(tmp_path, monkeypatch):
    class _FakeCandidate:
        provider = "pexels"
        provider_id = "1"
        source_url = "https://x"
        download_url = "https://cdn/1.mp4"
        license = {}

    fake_mod = MagicMock()
    fake_mod.search.return_value = [_FakeCandidate()]
    fake_mod.download.return_value = tmp_path / "pexels_1.mp4"
    (tmp_path / "pexels_1.mp4").write_bytes(b"x")

    monkeypatch.setattr(
        "studio.library.acquisition._load_provider_module",
        lambda provider: fake_mod)
    monkeypatch.setattr(
        "studio.library.acquisition.is_provider_already_taken",
        lambda *a, **kw: False)

    def _boom(*a, **kw):
        raise RuntimeError("frontend caiu")

    resolver = make_provider_resolver(
        MagicMock(mock_mode=False), tmp_path, providers=("pexels",),
        db=MagicMock(), event_sink=_boom)
    out = resolver("q", 0)
    assert len(out) == 1, "event_sink a rebentar não pode impedir a aquisição real"
