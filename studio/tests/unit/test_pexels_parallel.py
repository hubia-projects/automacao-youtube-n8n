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

from studio.library.sources.pexels import sweep, _download_one


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
