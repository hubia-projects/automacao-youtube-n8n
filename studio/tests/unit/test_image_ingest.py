"""item MediaKind (closure de cobertura multi-provider): imagem exacta
licenciada como fonte visual de 1ª classe. Testa o fast-path de ingest
(salta detect_shots/extract_keyframes, produz 1 shot sintético) e o
preflight_image (resolução/formato, sem exigir duration/codec de vídeo)."""
from __future__ import annotations

from pathlib import Path

import pytest


def _make_jpeg(path: Path, width: int, height: int) -> Path:
    from PIL import Image
    img = Image.new("RGB", (width, height), color=(120, 60, 30))
    img.save(path, format="JPEG")
    return path


class _FakeEmbedder:
    dim = 768

    def embed_images(self, paths):
        import numpy as np
        return np.ones((len(paths), self.dim), dtype=np.float32) / (self.dim ** 0.5)

    def embed_text(self, text_en, **kwargs):
        import numpy as np
        return np.ones(self.dim, dtype=np.float32) / (self.dim ** 0.5)


@pytest.fixture()
def settings(tmp_path):
    from studio.config import Settings
    return Settings(mock_mode=True, data_root=tmp_path / "data")


def test_preflight_image_aceita_jpeg_resolucao_ok(tmp_path, settings):
    from studio.library.early_reject import preflight_image
    p = _make_jpeg(tmp_path / "ok.jpg", 1920, 1080)
    assert preflight_image(p, settings) is None


def test_preflight_image_rejeita_resolucao_baixa(tmp_path, settings):
    from studio.library.early_reject import preflight_image
    p = _make_jpeg(tmp_path / "small.jpg", 320, 240)
    reason = preflight_image(p, settings)
    assert reason is not None
    assert reason.code == "low_resolution"


def test_preflight_image_rejeita_formato_nao_suportado(tmp_path, settings):
    from PIL import Image
    from studio.library.early_reject import preflight_image
    p = tmp_path / "vector.bmp"
    Image.new("RGB", (1920, 1080)).save(p, format="BMP")
    reason = preflight_image(p, settings)
    assert reason is not None
    assert reason.code == "unsupported_format"


def test_preflight_image_missing_file(tmp_path, settings):
    from studio.library.early_reject import preflight_image
    reason = preflight_image(tmp_path / "nope.jpg", settings)
    assert reason is not None
    assert reason.code == "missing_file"


def test_ingest_file_imagem_salta_detect_shots_e_extract_keyframes(
    tmp_path, settings, monkeypatch,
):
    """media_kind='image' nunca chama detect_shots/extract_keyframes
    (video-only) — produz exactamente 1 shot sintético."""
    import studio.library.ingest as ingest_mod
    from studio.library.db import LibraryDB
    from studio.library.licenses import LicenseRecord

    def _boom(*a, **kw):
        raise AssertionError("detect_shots/extract_keyframes não devem "
                             "ser chamados para media_kind=image")
    monkeypatch.setattr(ingest_mod, "detect_shots", _boom)
    monkeypatch.setattr(ingest_mod, "extract_keyframes", _boom)

    img_path = _make_jpeg(tmp_path / "lello.jpg", 1920, 1080)
    db = LibraryDB(settings.library_root)
    lic = LicenseRecord(source="wikimedia", source_url="https://commons...",
                        license="cc-by-sa", author="John Samuel",
                        attribution_text="John Samuel, CC BY-SA 4.0")

    result = ingest_mod.ingest_file(
        img_path, lic, db, settings, _FakeEmbedder(), media_kind="image",
    )
    assert result.status == "ingested"

    rows = db.iter_rows("1=1", limit=20, include_restricted=True)
    assert len(rows) == 1
    row = rows[0]
    assert row["media_kind"] == "image"
    assert row["t_in"] == 0.0
    assert row["t_out"] == pytest.approx(
        settings.image_virtual_duration_default_s)


def test_video_default_media_kind_continua_video(tmp_path, settings):
    """Sem media_kind explícito, o valor por defeito continua 'video'
    (retro-compat com todo o código/testes existente)."""
    import inspect
    from studio.library.ingest import ingest_file
    sig = inspect.signature(ingest_file)
    assert sig.parameters["media_kind"].default == "video"
