"""Sprint B Fase 1 — testes de pexels.py paralelo.

Cobertura:
1. Ordem preservada (executor.map vs asyncio.gather) — output NA ORDEM do rank.
2. Atomic write — ficheiros .tmp são limpos em caso de erro.
3. Retry exp manual — 503 na 1ª tentativa + 200 na 2ª = sucesso final.
"""

from __future__ import annotations

import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from studio.library.sources.pexels import sweep, search, _download_one


# ---------- fixtures ----------

class _FakeStreamResp:
    """httpx.stream context manager que simula download + status opcional."""
    request: object = MagicMock()   # partilhado entre instâncias (apenas testes)

    def __init__(self, status: int, chunks: list[bytes] | None = None):
        self.status_code = status
        self._chunks = chunks or [b"video-mp4-fake-bytes"]
        self.headers = {"content-length": str(sum(len(c) for c in self._chunks))}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"{self.status_code}", request=MagicMock(), response=self)

    def iter_bytes(self, chunk_size: int):
        for c in self._chunks:
            yield c


class _FakeSearchResp:
    """httpx.get() não-stream da SEARCH_URL — devolve lista de vídeos fake."""
    def __init__(self, videos: list[dict]):
        self.status_code = 200
        self._videos = videos

    def raise_for_status(self):
        return None

    def json(self):
        return {"videos": self._videos}


def _fake_video(vid_id: int, link: str | None = None) -> dict:
    if link is None:
        # URL com id determinístico na path: .../video_{id}.mp4
        link = f"https://videos.pexels.com/video-files/{vid_id}/{vid_id}_hd_1920_1080.mp4"
    return {
        "id": vid_id,
        "url": f"https://www.pexels.com/video/{vid_id}/",
        "user": {"name": f"author_{vid_id}"},
        "video_files": [{"id": 1, "link": link, "width": 1920, "height": 1080}],
    }


def _settings(tmp_path: Path) -> MagicMock:
    s = MagicMock()
    s.pexels_api_key = "fake-key-123"
    s.library_root = tmp_path
    return s


# ---------- testes ----------

def test_sweep_preserve_input_order(tmp_path: Path):
    """executor.map deve devolver resultados NA ORDEM do ranking Pexels
    (id 1 primeiro, id 100 último) — mesmo que os downloads terminem fora
    de ordem no relógio."""
    videos = [_fake_video(i) for i in [1, 50, 100, 2, 75]]

    def _fake_stream(url: str, *args, **kw):
        # Extrai id do path (URL = .../video-files/{id}/...) — formato
        # estável da _fake_video(). Inverte artificialmente a chegada
        # com base no id (100 termina primeiro, 1 por último).
        try:
            path_part = url.rsplit("/", 2)[-2]
            last = int(path_part)
        except (ValueError, IndexError):
            last = 0
        delay_map = {100: 0.05, 75: 0.04, 50: 0.03, 2: 0.02, 1: 0.01}
        import time
        time.sleep(delay_map.get(last, 0))
        return _FakeStreamResp(200, chunks=[f"v{last}".encode()])

    # Patch unificado — `httpx.Client` (search dentro de sweep) E `_client`
    # (downloads via _download_one) partilham o mesmo MagicMock.
    fake_client = MagicMock()
    fake_client.__enter__ = lambda *a: fake_client
    fake_client.__exit__ = lambda *a: False
    fake_client.get.return_value = _FakeSearchResp(videos)
    fake_client.stream.side_effect = _fake_stream

    with patch("httpx.Client", return_value=fake_client), \
         patch("studio.library.sources.pexels._client", return_value=fake_client):
        out = sweep("Lisbon", 5, _settings(tmp_path), tmp_path)

    names = [p.name for p, _lic in out]
    # Ordem esperada: id 1, 50, 100, 2, 75 (ordem do input, preservada por map)
    assert names == ["pexels_1.mp4", "pexels_50.mp4", "pexels_100.mp4",
                     "pexels_2.mp4", "pexels_75.mp4"], (
        f"Ordem não preservada: {names}")
    # Ficheiros todos criados
    for p, lic in out:
        assert p.exists() and p.stat().st_size > 0
        assert lic["source"] == "pexels"
        assert lic["author"].startswith("author_")


def test_download_one_atomic_write_cleanup(tmp_path: Path, monkeypatch):
    """Se o download falha no meio, o ficheiro .tmp tem de ser limpo
    (não pode ficar lixo no filesystem a ser apanhado por ingest_file)."""
    target = tmp_path / "pexels_999.mp4"
    tmp = target.with_suffix(target.suffix + ".tmp")

    # 1ª tentativa: HTTPError → tmp é limpo + retry.
    # 2ª tentativa idem → retry.
    # 3ª tentativa idem → exceção propagada + tmp limpo.
    err_responses = [_FakeStreamResp(503),
                     _FakeStreamResp(503),
                     _FakeStreamResp(503)]
    err_responses_iter = iter(err_responses)

    with patch.object(__import__("studio.library.sources.pexels", fromlist=["_client"]),
                      "_client") as fake_client:
        fake_client.return_value.stream.side_effect = lambda *a, **kw: next(err_responses_iter)

        # Encurta o sleep para o teste correr rápido
        monkeypatch.setattr("time.sleep", lambda s: None)

        with pytest.raises(httpx.HTTPStatusError):
            _download_one("https://x/y.mp4", target)

    # tmp foi limpo em cada tentativa
    assert not tmp.exists(), f"tmp leftover: {tmp}"
    # target NÃO foi criado (rename nunca aconteceu)
    assert not target.exists(), f"target criado por engano: {target}"


def test_download_one_retry_then_success(tmp_path: Path, monkeypatch):
    """503 na 1ª tentativa → 200 na 2ª → download concluído com sucesso."""
    target = tmp_path / "pexels_42.mp4"
    tmp = target.with_suffix(target.suffix + ".tmp")

    responses = [_FakeStreamResp(503),
                 _FakeStreamResp(200, chunks=[b"OK-bytes"])]
    iter_responses = iter(responses)

    with patch.object(__import__("studio.library.sources.pexels", fromlist=["_client"]),
                      "_client") as fake_client:
        fake_client.return_value.stream.side_effect = lambda *a, **kw: next(iter_responses)

        monkeypatch.setattr("time.sleep", lambda s: None)  # sem delay em testes

        result = _download_one("https://x/y.mp4", target)

    assert result == target
    assert tmp.exists() is False, "tmp não foi limpo após replace"
    assert target.exists() and target.read_bytes() == b"OK-bytes"


def test_sweep_zero_videos_returns_empty(tmp_path: Path):
    """Search com 0 resultados: retorno imediato, sem Exception."""
    with patch("httpx.Client") as ClientClass:
        ClientClass.return_value.__enter__ = lambda s: s
        ClientClass.return_value.__exit__ = lambda s, *a: False
        ClientClass.return_value.get.return_value = _FakeSearchResp([])
        out = sweep("Nada-aqui", 3, _settings(tmp_path), tmp_path)
    assert out == []


# === PORTO FINAL RETRIEVAL FIX (secções 4, 5, 8, 24) ========================

def _fake_video_with_url(vid_id: int, slug: str) -> dict:
    return {
        "id": vid_id,
        "url": f"https://www.pexels.com/video/{slug}-{vid_id}/",
        "image": f"https://images.pexels.com/videos/{vid_id}/preview.jpg",
        "duration": 12.0, "width": 1920, "height": 1080,
        "user": {"name": f"author_{vid_id}"},
        "video_files": [{"id": 1, "link": f"https://videos.pexels.com/{vid_id}.mp4",
                        "width": 1920, "height": 1080}],
    }


def test_search_sem_hints_nunca_envia_orientation(tmp_path):
    """secção 5: orientation NUNCA é enviado como filtro de discovery —
    um vídeo vertical certo é melhor que um landscape errado."""
    captured_params = {}

    def _fake_get(url, headers=None, params=None):
        captured_params.update(params or {})
        return _FakeSearchResp([_fake_video_with_url(1, "generic-city")])

    with patch("httpx.Client") as ClientClass:
        ClientClass.return_value.__enter__ = lambda s: s
        ClientClass.return_value.__exit__ = lambda s, *a: False
        ClientClass.return_value.get.side_effect = _fake_get
        search("Porto", 5, _settings(tmp_path))
    assert "orientation" not in captured_params


def test_search_com_hints_pagina_ate_pool_limit(tmp_path):
    """secção 4, 24: com canonical_hints, search() pagina até
    `pexels_search_pool` (não fica preso a 1 página de per_page pequeno)."""
    settings = _settings(tmp_path)
    settings.pexels_search_pool = 5
    settings.pexels_search_max_pages = 3

    pages_requested = []

    def _fake_get(url, headers=None, params=None):
        pages_requested.append(params["page"])
        page = params["page"]
        # 2 vídeos por página, até esgotar 5 (pool_limit)
        videos = [_fake_video_with_url(page * 10 + i, "porto video")
                 for i in range(2)]
        return _FakeSearchResp(videos)

    with patch("httpx.Client") as ClientClass:
        ClientClass.return_value.__enter__ = lambda s: s
        ClientClass.return_value.__exit__ = lambda s, *a: False
        ClientClass.return_value.get.side_effect = _fake_get
        out = search("Porto Cathedral", 3, settings,
                     canonical_hints=("Sé do Porto",))
    assert len(pages_requested) >= 2, "devia ter paginado para atingir o pool"
    assert len(out) == 3  # devolve só count=3, mesmo com pool maior


def test_search_com_hints_para_cedo_se_pagina_vazia(tmp_path):
    settings = _settings(tmp_path)
    settings.pexels_search_pool = 60
    settings.pexels_search_max_pages = 5

    call_count = {"n": 0}

    def _fake_get(url, headers=None, params=None):
        call_count["n"] += 1
        if params["page"] == 1:
            return _FakeSearchResp([_fake_video_with_url(1, "porto")])
        return _FakeSearchResp([])  # página 2 vazia — deve parar aqui
    with patch("httpx.Client") as ClientClass:
        ClientClass.return_value.__enter__ = lambda s: s
        ClientClass.return_value.__exit__ = lambda s, *a: False
        ClientClass.return_value.get.side_effect = _fake_get
        search("Porto Cathedral", 10, settings,
              canonical_hints=("Sé do Porto",))
    assert call_count["n"] == 2, "devia parar na 1ª página vazia, não continuar até max_pages"


def test_search_com_hints_rankeia_candidato_com_titulo_certo_primeiro(tmp_path):
    settings = _settings(tmp_path)
    settings.pexels_search_pool = 60
    settings.pexels_search_max_pages = 1

    def _fake_get(url, headers=None, params=None):
        return _FakeSearchResp([
            _fake_video_with_url(1, "generic-old-bookstore"),
            _fake_video_with_url(2, "livraria-lello-exterior"),
        ])
    with patch("httpx.Client") as ClientClass:
        ClientClass.return_value.__enter__ = lambda s: s
        ClientClass.return_value.__exit__ = lambda s, *a: False
        ClientClass.return_value.get.side_effect = _fake_get
        out = search("historic bookstore Porto", 2, settings,
                     canonical_hints=("Livraria Lello",))
    assert out[0].provider_id == "2", (
        "candidato com 'livraria lello' no título (via slug da URL) devia "
        "vir primeiro"
    )


def test_search_preserva_title_e_preview_url(tmp_path):
    def _fake_get(url, headers=None, params=None):
        return _FakeSearchResp([_fake_video_with_url(7, "porto-cathedral-aerial")])
    with patch("httpx.Client") as ClientClass:
        ClientClass.return_value.__enter__ = lambda s: s
        ClientClass.return_value.__exit__ = lambda s, *a: False
        ClientClass.return_value.get.side_effect = _fake_get
        out = search("Porto Cathedral", 5, _settings(tmp_path))
    assert len(out) == 1
    assert "porto cathedral aerial" in out[0].title
    assert out[0].preview_url.startswith("https://images.pexels.com")
    assert out[0].duration == 12.0
