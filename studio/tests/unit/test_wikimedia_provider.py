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


@pytest.fixture(autouse=True)
def _reset_rate_limit_state():
    wikimedia._rate_limited_until = 0.0
    yield
    wikimedia._rate_limited_until = 0.0


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


_LOOKALIKE_PAGE = {
    "1": {
        "pageid": 1, "ns": 6, "title": "File:Generic old bookstore.jpg",
        "index": 1,
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/x/Generic_old_bookstore.jpg",
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Generic_old_bookstore.jpg",
            "width": 1920, "height": 1080, "mime": "image/jpeg",
            "extmetadata": {
                "LicenseShortName": {"value": "CC0 1.0"},
                "Categories": {"value": "Bookstores"},
            },
        }],
    },
}

_LELLO_PAGE = {
    "2": {
        "pageid": 2, "ns": 6, "title": "File:Exterior view of Livraria Lello 01.jpg",
        "index": 2,
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/x/Lello_02.jpg",
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Lello_02.jpg",
            "width": 1920, "height": 1080, "mime": "image/jpeg",
            "extmetadata": {
                "LicenseShortName": {"value": "CC0 1.0"},
                "Categories": {"value": "Livraria Lello|Bookstores in Porto"},
            },
        }],
    },
}


def test_search_com_canonical_hints_rankeia_match_exacto_primeiro(monkeypatch):
    """Pool tem 1 candidato genérico (sem match) + 1 candidato real da
    Lello (título + categoria batem) — com canonical_hints, o real deve
    vir PRIMEIRO mesmo chegando depois na resposta textual genérica."""
    def _fake_get(self, url, params=None, **kw):
        params = params or {}
        if "gcmtitle" in params and "Lello" in params["gcmtitle"]:
            return httpx.Response(200, json=_fake_search_response(_LELLO_PAGE),
                                  request=httpx.Request("GET", url))
        if "gsrsearch" in params:
            return httpx.Response(200, json=_fake_search_response(_LOOKALIKE_PAGE),
                                  request=httpx.Request("GET", url))
        return httpx.Response(200, json=_fake_search_response({}),
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = wikimedia.search("old bookstore Porto", 2, _settings(),
                           canonical_hints=("Livraria Lello",))
    assert len(out) == 2
    assert "Lello" in out[0].title
    assert out[0].categories == ("Livraria Lello", "Bookstores in Porto")


_PORTO_CATHEDRAL_PAGE = {
    "3": {
        "pageid": 3, "ns": 6, "title": "File:Porto Cathedral aerial.jpg",
        "index": 1,
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/x/PortoCathedral.jpg",
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:PortoCathedral.jpg",
            "width": 1920, "height": 1080, "mime": "image/jpeg",
            "extmetadata": {
                "LicenseShortName": {"value": "CC0 1.0"},
                "Categories": {"value": "Sé do Porto"},
            },
        }],
    },
}

_VISEU_CATHEDRAL_PAGE = {
    "4": {
        "pageid": 4, "ns": 6, "title": "File:Viseu Cathedral facade.jpg",
        "index": 1,
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/x/ViseuCathedral.jpg",
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:ViseuCathedral.jpg",
            "width": 1920, "height": 1080, "mime": "image/jpeg",
            "extmetadata": {
                "LicenseShortName": {"value": "CC0 1.0"},
                "Categories": {"value": "Sé de Viseu"},
            },
        }],
    },
}


def test_ranking_se_do_porto_nao_e_no_op_apesar_de_palavras_genericas(
    monkeypatch,
):
    """secção 16-17 (PORTO FINAL RETRIEVAL FIX): "Sé do Porto"/"Porto
    Cathedral" são compostas inteiramente por palavras GENÉRICAS (sé,
    catedral/cathedral, porto) — um ranking por overlap de palavras
    distintivas fica sem sinal nenhum (bug real introduzido pelo próprio
    fix de B2). Ranking por FRASE COMPLETA continua a funcionar: "Porto
    Cathedral" bate no candidato certo, "Viseu Cathedral" fica atrás."""
    def _fake_get(self, url, params=None, **kw):
        params = params or {}
        if "gcmtitle" in params and "Porto" in params.get("gcmtitle", ""):
            return httpx.Response(200, json=_fake_search_response(_PORTO_CATHEDRAL_PAGE),
                                  request=httpx.Request("GET", url))
        if "gsrsearch" in params:
            return httpx.Response(200, json=_fake_search_response(_VISEU_CATHEDRAL_PAGE),
                                  request=httpx.Request("GET", url))
        return httpx.Response(200, json=_fake_search_response({}),
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = wikimedia.search("gothic cathedral facade Porto", 2, _settings(),
                           canonical_hints=("Sé do Porto", "Porto Cathedral"))
    assert len(out) == 2
    assert "Porto Cathedral" in out[0].title, (
        "candidato correcto (Porto Cathedral) devia vir primeiro, mesmo "
        "com palavras 100% genéricas no canonical/alias"
    )
    assert out[0].categories == ("Sé do Porto",)


_LELLO_VIDEO_PAGE = {
    "5": {
        "pageid": 5, "ns": 6, "title": "File:Livraria Lello walkthrough.webm",
        "index": 1,
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/x/LelloWalkthrough.webm",
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:LelloWalkthrough.webm",
            "width": 1920, "height": 1080, "mime": "video/webm", "duration": 30.0,
            "extmetadata": {
                "LicenseShortName": {"value": "CC BY-SA 4.0"},
                "Categories": {"value": "Livraria Lello"},
            },
        }],
    },
}


def test_search_com_hints_faz_busca_explicita_filetype_video(monkeypatch):
    """secções 11-13 (PORTO FINAL RETRIEVAL FIX): busca dedicada por
    vídeo (`filetype:video`) corre ANTES do resto — vídeo não fica à
    mercê de competir/perder contra um pool cheio de imagens."""
    seen_queries = []

    def _fake_get(self, url, params=None, **kw):
        params = params or {}
        if "gsrsearch" in params:
            seen_queries.append(params["gsrsearch"])
        if params.get("gsrsearch", "").endswith("filetype:video"):
            return httpx.Response(200, json=_fake_search_response(_LELLO_VIDEO_PAGE),
                                  request=httpx.Request("GET", url))
        return httpx.Response(200, json=_fake_search_response({}),
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = wikimedia.search("Lello bookstore Porto", 3, _settings(),
                           canonical_hints=("Livraria Lello",))
    assert any(q.endswith("filetype:video") for q in seen_queries), (
        "devia ter feito pelo menos 1 busca explícita filetype:video"
    )
    assert len(out) == 1
    assert out[0].media_kind == "video"


def test_ranking_bonus_video_desempata_mas_nunca_bate_match_de_frase_mais_forte(
    monkeypatch,
):
    """secção 27: vídeo ganha desempate leve, mas um match de FRASE mais
    forte (imagem com nome exacto) continua a vencer um vídeo genérico
    sem nenhum match."""
    def _fake_get(self, url, params=None, **kw):
        params = params or {}
        if "gcmtitle" in params and "Lello" in params.get("gcmtitle", ""):
            return httpx.Response(200, json=_fake_search_response(_LELLO_PAGE),
                                  request=httpx.Request("GET", url))
        if params.get("gsrsearch", "").endswith("filetype:video"):
            return httpx.Response(200, json=_fake_search_response(_VIDEO_PAGE),
                                  request=httpx.Request("GET", url))
        return httpx.Response(200, json=_fake_search_response({}),
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = wikimedia.search("Livraria Lello", 2, _settings(),
                           canonical_hints=("Livraria Lello",))
    assert len(out) == 2
    # _LELLO_PAGE bate a frase completa "Livraria Lello" no título/categoria
    # (score alto); _VIDEO_PAGE (Bridge.webm, genérico) não bate nada — o
    # bónus de vídeo NUNCA deve inverter essa ordem.
    assert "Livraria Lello" in out[0].title, (
        "match de frase forte (imagem) devia vencer vídeo sem nenhum match"
    )


def test_search_sem_canonical_hints_nao_faz_probe_por_hint(monkeypatch):
    """Sem hints, `search()` só usa o fallback legacy `Category:{query_en}`
    (se necessário) — nunca um probe extra por-hint (esse só existe
    quando `canonical_hints` é passado)."""
    calls = []

    def _fake_get(self, url, params=None, **kw):
        calls.append(dict(params or {}))
        if "gsrsearch" in (params or {}):
            return httpx.Response(200, json=_fake_search_response({}),
                                  request=httpx.Request("GET", url))
        return httpx.Response(200, json=_fake_search_response(_IMAGE_PAGE),
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    out = wikimedia.search("Livraria Lello", 5, _settings())
    assert len(out) == 1
    gcmtitles = [c["gcmtitle"] for c in calls if "gcmtitle" in c]
    # único probe de categoria é o fallback legacy da própria query, nunca
    # um probe adicional (que só existiria por-hint, quando há hints).
    assert gcmtitles == ["Category:Livraria Lello"]


def test_normalize_license_mapping():
    assert wikimedia._normalize_license("CC BY-SA 4.0") == "cc-by-sa"
    assert wikimedia._normalize_license("CC BY 2.0") == "cc-by"
    assert wikimedia._normalize_license("CC0 1.0") == "cc0"
    assert wikimedia._normalize_license("Public domain") == "pd"
    assert wikimedia._normalize_license("All rights reserved") == ""


def test_download_extrai_extensao_correcta_com_querystring_tracking(
    tmp_path, monkeypatch,
):
    """BUG REAL (microvalidação real, 2026-08-14): download_url do Commons
    vem sempre com querystring de tracking
    ("...jpg?utm_source=commons.wikimedia.org&utm_campaign=..."). Sem
    urlparse, Path(url).suffix pegava o resto da querystring como
    "extensão" — ficheiro final ficava
    "wikimedia_121506761.org&utm_campaign=..." em vez de ".jpg"."""
    cand = wikimedia.CandidateMetadata(
        provider="wikimedia", provider_id="121506761",
        source_url="https://commons.wikimedia.org/wiki/File:X.jpg",
        download_url=("https://upload.wikimedia.org/wikipedia/commons/6/6e/"
                      "Exterior_view_of_Livraria_Lello_01.jpg"
                      "?utm_source=commons.wikimedia.org"
                      "&utm_campaign=imageinfo&utm_content=original"),
        media_kind="image",
    )

    class _FakeStream:
        status_code = 200
        request = httpx.Request("GET", cand.download_url)

        def raise_for_status(self): pass
        def iter_bytes(self, chunk_size): yield b"jpeg bytes"
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(httpx.Client, "stream",
                        lambda self, method, url, **kw: _FakeStream())
    path = wikimedia.download(cand, _settings(), tmp_path)
    assert path.name == "wikimedia_121506761.jpg"
    assert path.suffix == ".jpg"


# === PORTO FINAL ASSET TEST (secções 7-10): failover 429 ====================

def _cand_for_download(provider_id="1"):
    return wikimedia.CandidateMetadata(
        provider="wikimedia", provider_id=provider_id,
        source_url=f"https://commons.wikimedia.org/wiki/File:X{provider_id}.jpg",
        download_url=f"https://upload.wikimedia.org/x/X{provider_id}.jpg",
        media_kind="image",
    )


def test_download_429_sustentado_levanta_provider_rate_limited(
    tmp_path, monkeypatch,
):
    """Depois de esgotar as tentativas, TODAS 429, levanta
    ProviderRateLimitedError (não a HTTPStatusError genérica) — o caller
    (acquisition.py) distingue isto de uma falha pontual."""
    from studio.library.provider_errors import ProviderRateLimitedError
    monkeypatch.setattr(wikimedia, "_sleep_backoff", lambda *a, **kw: None)

    class _FakeStream:
        status_code = 429
        request = httpx.Request("GET", "https://x")
        headers = {}

        def raise_for_status(self): pass
        def iter_bytes(self, chunk_size): yield b""
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(httpx.Client, "stream",
                        lambda self, method, url, **kw: _FakeStream())

    with pytest.raises(ProviderRateLimitedError):
        wikimedia.download(_cand_for_download(), _settings(), tmp_path)
    assert wikimedia._rate_limited_until > 0.0


def test_download_apos_rate_limited_nao_toca_rede(tmp_path, monkeypatch):
    """Uma vez em cooldown, chamadas seguintes falham IMEDIATAMENTE (sem
    HTTP) — nunca esperar 2h a repetir o mesmo provider."""
    from studio.library.provider_errors import ProviderRateLimitedError
    wikimedia._rate_limited_until = wikimedia.time.time() + 300

    calls = {"n": 0}

    def _boom(self, method, url, **kw):
        calls["n"] += 1
        raise AssertionError("não devia tocar a rede em cooldown")
    monkeypatch.setattr(httpx.Client, "stream", _boom)

    with pytest.raises(ProviderRateLimitedError):
        wikimedia.download(_cand_for_download(), _settings(), tmp_path)
    assert calls["n"] == 0


def test_download_erro_generico_nao_entra_em_cooldown(tmp_path, monkeypatch):
    """500/timeout continuam a comportar-se como antes (retry normal,
    excepção genérica) — só 429 SUSTENTADO activa o cooldown de
    provider."""
    monkeypatch.setattr(wikimedia, "_sleep_backoff", lambda *a, **kw: None)

    class _FakeStream:
        status_code = 500
        request = httpx.Request("GET", "https://x")
        headers = {}

        def raise_for_status(self): pass
        def iter_bytes(self, chunk_size): yield b""
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(httpx.Client, "stream",
                        lambda self, method, url, **kw: _FakeStream())

    with pytest.raises(httpx.HTTPStatusError):
        wikimedia.download(_cand_for_download(), _settings(), tmp_path)
    assert wikimedia._rate_limited_until == 0.0


def test_search_429_sustentado_levanta_provider_rate_limited(monkeypatch):
    from studio.library.provider_errors import ProviderRateLimitedError
    monkeypatch.setattr(wikimedia, "_sleep_backoff", lambda *a, **kw: None)

    def _fake_get(self, url, params=None, **kw):
        return httpx.Response(429, headers={"Retry-After": "1"},
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    with pytest.raises(ProviderRateLimitedError):
        wikimedia.search("Livraria Lello", 5, _settings())
    assert wikimedia._rate_limited_until > 0.0


def test_retry_after_header_respeitado_e_capado(monkeypatch):
    sleeps = []
    monkeypatch.setattr(wikimedia.time, "sleep", lambda s: sleeps.append(s))

    def _fake_get(self, url, params=None, **kw):
        return httpx.Response(429, headers={"Retry-After": "9999"},
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.Client, "get", _fake_get)

    from studio.library.provider_errors import ProviderRateLimitedError
    with pytest.raises(ProviderRateLimitedError):
        wikimedia.search("Livraria Lello", 5, _settings())
    assert all(s <= wikimedia._RATE_LIMIT_MAX_RETRY_AFTER_S for s in sleeps)
    assert sleeps, "devia ter esperado pelo menos 1x antes de desistir"
