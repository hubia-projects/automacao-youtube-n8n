"""pixabay.py rewrite two-phase (item 29 do fecho de cobertura
multi-provider): search()/download() mesmo contrato de pexels.py, em vez
do sweep() legacy acoplado. HTTP mockado, sem rede real."""
from __future__ import annotations

import httpx
import pytest

from studio.library.sources import pixabay


def _settings():
    from studio.config import Settings
    return Settings(mock_mode=True, pixabay_api_key="fake-key")


_HITS_RESPONSE = {
    "hits": [
        {"id": 111, "pageURL": "https://pixabay.com/videos/111/",
         "user": "alice",
         "videos": {"large": {"url": "https://cdn.pixabay.com/111_large.mp4"}}},
        {"id": 222, "pageURL": "https://pixabay.com/videos/222/",
         "user": "bob",
         "videos": {"medium": {"url": "https://cdn.pixabay.com/222_medium.mp4"}}},
    ]
}


def test_search_devolve_candidatemetadata_sem_baixar_bytes(monkeypatch):
    def _fake_get(self, url, params=None, **kw):
        return httpx.Response(200, json=_HITS_RESPONSE,
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = pixabay.search("Porto bridge", 5, _settings())
    assert len(out) == 2
    assert out[0].provider == "pixabay"
    assert out[0].provider_id == "111"
    assert out[0].download_url == "https://cdn.pixabay.com/111_large.mp4"
    assert out[0].license["license"] == "pixabay"
    assert out[0].license["author"] == "alice"


def test_search_sem_api_key_levanta(monkeypatch):
    from studio.config import Settings
    settings = Settings(mock_mode=True, pixabay_api_key="")
    with pytest.raises(RuntimeError):
        pixabay.search("qualquer", 5, settings)


def test_download_escreve_ficheiro_atomico(tmp_path, monkeypatch):
    content = b"fake video bytes" * 100

    class _FakeStream:
        def __init__(self):
            self.status_code = 200
            self.request = httpx.Request("GET", "https://cdn.pixabay.com/x.mp4")

        def raise_for_status(self):
            pass

        def iter_bytes(self, chunk_size):
            yield content

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(httpx.Client, "stream",
                        lambda self, method, url, **kw: _FakeStream())

    cand = pixabay.CandidateMetadata(
        provider="pixabay", provider_id="333",
        source_url="https://pixabay.com/videos/333/",
        download_url="https://cdn.pixabay.com/333_large.mp4",
        license={"source": "pixabay", "license": "pixabay"},
    )
    dest = tmp_path / "downloads"
    path = pixabay.download(cand, _settings(), dest)
    assert path.exists()
    assert path.read_bytes() == content
    assert path.name == "pixabay_333.mp4"
    assert not path.with_suffix(".mp4.tmp").exists()


def test_sweep_compat_legacy_search_e_download(tmp_path, monkeypatch):
    def _fake_get(self, url, params=None, **kw):
        return httpx.Response(200, json=_HITS_RESPONSE,
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    downloaded = []

    def _fake_download(cand, settings, dest):
        p = dest / f"pixabay_{cand.provider_id}.mp4"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")
        downloaded.append(cand.provider_id)
        return p
    monkeypatch.setattr(pixabay, "download", _fake_download)

    out = pixabay.sweep("Porto", 5, _settings(), tmp_path)
    assert len(out) == 2
    assert downloaded == ["111", "222"]


# === PORTO FINAL RETRIEVAL FIX (secção 9) ====================================

def test_search_preserva_tags_duration_dimensoes(monkeypatch):
    hit = {
        "id": 555, "pageURL": "https://pixabay.com/videos/555/",
        "user": "carol", "tags": "cathedral, porto, gothic",
        "duration": 15.0,
        "videos": {"large": {"url": "https://cdn.pixabay.com/555.mp4",
                            "width": 1920, "height": 1080}},
    }
    monkeypatch.setattr(httpx.Client, "get", lambda self, url, params=None, **kw:
                        httpx.Response(200, json={"hits": [hit]},
                                      request=httpx.Request("GET", url)))
    out = pixabay.search("Porto cathedral", 5, _settings())
    assert out[0].tags == "cathedral, porto, gothic"
    assert out[0].duration == 15.0
    assert out[0].width == 1920 and out[0].height == 1080


def test_search_com_hints_pagina_ate_pool_limit(monkeypatch):
    settings = _settings()
    object.__setattr__(settings, "pixabay_search_pool", 5)
    object.__setattr__(settings, "pixabay_search_max_pages", 3)

    pages_requested = []

    def _fake_get(self, url, params=None, **kw):
        pages_requested.append(params["page"])
        page = params["page"]
        hits = [
            {"id": page * 10 + i, "pageURL": f"https://pixabay.com/videos/{page}{i}/",
             "user": "u", "tags": "porto video",
             "videos": {"large": {"url": f"https://cdn.pixabay.com/{page}{i}.mp4"}}}
            for i in range(2)
        ]
        return httpx.Response(200, json={"hits": hits},
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = pixabay.search("Porto Cathedral", 3, settings,
                         canonical_hints=("Sé do Porto",))
    assert len(pages_requested) >= 2
    assert len(out) == 3


def test_search_com_hints_rankeia_tags_certas_primeiro(monkeypatch):
    def _fake_get(self, url, params=None, **kw):
        hits = [
            {"id": 1, "pageURL": "https://pixabay.com/videos/1/", "user": "u",
             "tags": "old bookstore generic",
             "videos": {"large": {"url": "https://cdn.pixabay.com/1.mp4"}}},
            {"id": 2, "pageURL": "https://pixabay.com/videos/2/", "user": "u",
             "tags": "livraria lello porto bookstore",
             "videos": {"large": {"url": "https://cdn.pixabay.com/2.mp4"}}},
        ]
        return httpx.Response(200, json={"hits": hits},
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = pixabay.search("historic bookstore", 2, _settings(),
                         canonical_hints=("Livraria Lello",))
    assert out[0].provider_id == "2", (
        "candidato com tags 'livraria lello' devia vir primeiro"
    )
