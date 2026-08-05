import hashlib
import subprocess

import numpy as np
import pytest

from studio.config import Settings
from studio.orchestrator.stage import RunContext


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return Settings(
        mock_mode=True,
        data_root=tmp_path / "data",
        budget_usd_per_run=15.0,
        output_width=640, output_height=360,   # render de teste rápido
        render_preset="ultrafast",
        _env_file=None,  # testes nunca leem o .env real
    )


@pytest.fixture()
def ctx(settings) -> RunContext:
    video_id = "test-video"
    return RunContext(
        video_id=video_id,
        run_dir=settings.runs_root / video_id,
        settings=settings,
    )


class FakeEmbedder:
    """Determinístico: vetor pseudo-aleatório seeded pelo conteúdo/texto."""

    dim = 768

    def _vec(self, seed_bytes: bytes) -> np.ndarray:
        seed = int.from_bytes(hashlib.sha256(seed_bytes).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        v = rng.standard_normal(self.dim).astype(np.float32)
        return v / np.linalg.norm(v)

    def embed_images(self, paths):
        return np.stack([self._vec(p.read_bytes()) for p in paths])

    def embed_text(self, text_en: str):
        return self._vec(text_en.encode())


@pytest.fixture()
def fake_embedder():
    return FakeEmbedder()


def make_clip(path, seconds: float = 4.0, hue: int = 0):
    """Clip de cor única (1 shot). hue distinto → SHA distinto."""
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", f"color=c=red:s=320x240:d={seconds}:r=24",
         "-vf", f"hue=h={hue}", "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )
    return path


@pytest.fixture()
def seeded_library(settings, fake_embedder, tmp_path):
    return _seed_library(settings, fake_embedder, tmp_path)


def _seed_library(settings, embedder, tmp_path, n_food: int = 16, n_monument: int = 6):
    """Biblioteca fixture: nomes controlam o mock de metadados
    ('food'→has_food, 'monument'→has_landmark)."""
    from studio.library.db import LibraryDB
    from studio.library.ingest import ingest_file

    db = LibraryDB(settings.library_root)
    lic = {"source": "owned", "source_url": "", "license": "owned"}
    d = tmp_path / "clips"
    d.mkdir(exist_ok=True)
    for i in range(n_food):
        p = make_clip(d / f"street_food_{i}.mp4", hue=i * 7 + 1)
        assert ingest_file(p, lic, db, settings, embedder).status == "ingested"
    for i in range(n_monument):
        p = make_clip(d / f"monument_tower_{i}.mp4", hue=180 + i * 9)
        assert ingest_file(p, lic, db, settings, embedder).status == "ingested"
    return db
