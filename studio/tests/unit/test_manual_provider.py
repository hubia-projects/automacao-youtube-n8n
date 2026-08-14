"""manual_provider.py (itens 34/35/36 do fecho de cobertura multi-
provider): scan do inbox manual — fallback final quando providers
automáticos esgotam. Detect -> ingest_asset canónico -> (indexação/
confirmação ficam a cargo do caller, já existentes)."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from studio.library.manual_provider import (
    manual_inbox_dir,
    scan_manual_inbox,
)


def _settings(tmp_path):
    from studio.config import Settings
    return Settings(mock_mode=True, data_root=tmp_path / "data")


def test_manual_inbox_dir_path_pattern(tmp_path):
    settings = _settings(tmp_path)
    p = manual_inbox_dir(settings, "porto-24h-001")
    assert p == settings.library_root / "manual" / "inbox" / "porto-24h-001"


def test_scan_sem_pasta_devolve_zero(tmp_path):
    settings = _settings(tmp_path)
    db = MagicMock()
    n = scan_manual_inbox("wid", db, MagicMock(), settings)
    assert n == 0


def test_scan_ingere_imagem_e_video_detecta_media_kind(tmp_path, monkeypatch):
    settings = _settings(tmp_path)
    inbox = manual_inbox_dir(settings, "wid")
    inbox.mkdir(parents=True)
    (inbox / "lello.jpg").write_bytes(b"\xff\xd8\xff" + b"0" * 100)
    (inbox / "bridge.mp4").write_bytes(b"0" * 100)
    (inbox / "notes.txt").write_text("ignorar — extensão desconhecida")

    calls = []

    def _fake_ingest_asset(path, lic, db, settings, embedder, **kwargs):
        calls.append((path.name, kwargs.get("media_kind"), lic.source))
        from studio.library.ingest_asset import IngestResult
        return IngestResult(status="ingested", media_sha="sha_" + path.name), None
    monkeypatch.setattr(
        "studio.library.ingest_asset.ingest_asset", _fake_ingest_asset)

    n = scan_manual_inbox("wid", MagicMock(), MagicMock(), settings)
    assert n == 2, "só jpg+mp4 contam; .txt é ignorado (extensão desconhecida)"
    kinds = {name: kind for name, kind, _src in calls}
    assert kinds["lello.jpg"] == "image"
    assert kinds["bridge.mp4"] == "video"
    assert all(src == "orphan" for _n, _k, src in calls), (
        "sem proveniência verificável -> source=orphan (regime restrito "
        "até revisão, nunca licença inventada)")


def test_scan_e_idempotente_dedup_sha_via_ingest_file_real(tmp_path):
    """Re-scan não duplica — dedup real por SHA-256 (mesmo mecanismo de
    qualquer provider automático, sem caminho especial para manual)."""
    from studio.library.db import LibraryDB
    from studio.library.embed import Embedder

    settings = _settings(tmp_path)
    inbox = manual_inbox_dir(settings, "wid")
    inbox.mkdir(parents=True)
    from PIL import Image
    # cor aleatória: AssetStateStore usa um path GLOBAL (data/library/
    # states/, não scoped a tmp_path) chaveado por SHA-256 do conteúdo —
    # conteúdo determinístico colidiria entre execuções deste teste
    # (2ª execução veria SHA já "DONE" de uma execução anterior real).
    import random
    color = (random.randint(0, 255), random.randint(0, 255),
             random.randint(0, 255))
    Image.new("RGB", (1920, 1080), color=color).save(
        inbox / "photo.jpg", format="JPEG")

    class _FakeEmbedder:
        dim = 768
        def embed_images(self, paths):
            import numpy as np
            return np.ones((len(paths), self.dim), dtype=np.float32)
        def embed_text(self, text_en, **kw):
            import numpy as np
            return np.ones(self.dim, dtype=np.float32)

    db = LibraryDB(settings.library_root)
    embedder = _FakeEmbedder()
    n1 = scan_manual_inbox("wid", db, embedder, settings)
    n2 = scan_manual_inbox("wid", db, embedder, settings)
    assert n1 == 1
    assert n2 == 0, "2ª scan do MESMO ficheiro não deve reingerir (dedup SHA)"
    rows = db.iter_rows("1=1", limit=10)
    assert len(rows) == 1
    assert rows[0]["media_kind"] == "image"
