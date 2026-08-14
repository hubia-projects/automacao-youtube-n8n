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
