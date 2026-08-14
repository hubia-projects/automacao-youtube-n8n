"""wikimedia.py — provider real via API oficial MediaWiki (item 7 do fecho
de cobertura multi-provider). HTTP mockado (sem rede real) — a forma real
da resposta foi confirmada ao vivo via curl durante o planeamento (busca
por "Livraria Lello" devolve foto real CC BY-SA 4.0 com Artist/LicenseUrl/
AttributionRequired preenchidos)."""
from __future__ import annotations

import httpx
import pytest

from studio.library.sources import wikimedia


def _settings():
    from studio.config import Settings
    return Settings(mock_mode=True)


def _fake_search_response(pages: dict) -> dict:
    return {"batchcomplete": "", "query": {"pages": pages}}


_IMAGE_PAGE = {
    "121506761": {
        "pageid": 121506761, "ns": 6, "title": "File:Lello exterior.jpg",
        "index": 1,
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/x/Lello_exterior.jpg",
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Lello_exterior.jpg",
            "width": 4272, "height": 2848, "mime": "image/jpeg",
            "extmetadata": {
                "LicenseShortName": {"value": "CC BY-SA 4.0"},
                "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0"},
                "Artist": {"value": '<a href="//x">John Samuel</a>'},
                "AttributionRequired": {"value": "true"},
            },
        }],
    },
}

_VIDEO_PAGE = {
    "999": {
        "pageid": 999, "ns": 6, "title": "File:Bridge.webm", "index": 1,
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/x/Bridge.webm",
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Bridge.webm",
            "width": 1920, "height": 1080, "mime": "video/webm",
            "duration": 12.5,
            "extmetadata": {
                "LicenseShortName": {"value": "CC0 1.0"},
                "Artist": {"value": "Jane Doe"},
                "AttributionRequired": {"value": "false"},
            },
        }],
    },
}

_UNRECOGNIZED_LICENSE_PAGE = {
    "1": {
        "pageid": 1, "ns": 6, "title": "File:Bad.jpg", "index": 1,
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/x/Bad.jpg",
            "width": 1920, "height": 1080, "mime": "image/jpeg",
            "extmetadata": {"LicenseShortName": {"value": "All rights reserved"}},
        }],
    },
}


def test_search_devolve_candidato_imagem_com_licenca_normalizada(monkeypatch):
    def _fake_get(self, url, params=None, **kw):
        return httpx.Response(200, json=_fake_search_response(_IMAGE_PAGE),
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = wikimedia.search("Livraria Lello", 5, _settings())
    assert len(out) == 1
    cand = out[0]
    assert cand.provider == "wikimedia"
    assert cand.media_kind == "image"
    assert cand.width == 4272 and cand.height == 2848
    assert cand.license["license"] == "cc-by-sa"
    assert cand.license["attribution_required"] is True
    assert "John Samuel" in cand.license["attribution_text"]
    assert "<a" not in cand.license["author"]  # HTML stripped


def test_search_devolve_candidato_video_media_kind_correcto(monkeypatch):
    def _fake_get(self, url, params=None, **kw):
        return httpx.Response(200, json=_fake_search_response(_VIDEO_PAGE),
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = wikimedia.search("Ponte Dom Luis bridge", 5, _settings())
    assert len(out) == 1
    assert out[0].media_kind == "video"
    assert out[0].license["license"] == "cc0"
    assert out[0].duration == 12.5


def test_search_descarta_licenca_nao_reconhecida(monkeypatch):
    def _fake_get(self, url, params=None, **kw):
        return httpx.Response(200, json=_fake_search_response(_UNRECOGNIZED_LICENSE_PAGE),
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = wikimedia.search("qualquer coisa", 5, _settings())
    assert out == [], "licença não reconhecida nunca deve ser inventada/aceite"


def test_search_tenta_categoria_quando_keyword_insuficiente(monkeypatch):
    calls = []

    def _fake_get(self, url, params=None, **kw):
        calls.append(dict(params or {}))
        if "gsrsearch" in (params or {}):
            return httpx.Response(200, json=_fake_search_response({}),
                                  request=httpx.Request("GET", url))
        return httpx.Response(200, json=_fake_search_response(_IMAGE_PAGE),
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = wikimedia.search("Livraria Lello", 3, _settings())
    assert len(out) == 1
    assert any("gcmtitle" in c for c in calls), (
        "0 resultados de keyword search devia tentar categorymembers")


def test_normalize_license_mapping():
    assert wikimedia._normalize_license("CC BY-SA 4.0") == "cc-by-sa"
    assert wikimedia._normalize_license("CC BY 2.0") == "cc-by"
    assert wikimedia._normalize_license("CC0 1.0") == "cc0"
    assert wikimedia._normalize_license("Public domain") == "pd"
    assert wikimedia._normalize_license("All rights reserved") == ""
