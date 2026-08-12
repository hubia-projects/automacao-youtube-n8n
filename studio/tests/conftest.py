"""conftest.py — bootstrap sys.path para imports de scripts/.

O pyproject.toml define hatch `packages = ["src/studio"]` apenas, então
`studio.scripts` NÃO é resolvido pela package "studio" (scripts/ fica em
studio/scripts/, NÃO em studio/src/studio/scripts/).

Fix: adicionar studio/ (root do projeto) + studio/scripts/ a sys.path,
para que `from benchmark_library_pipeline import ...` funcione nos testes
e o ficheiro seja executável como `python scripts/benchmark_library_pipeline.py`.
"""
import hashlib
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[1]   # studio/
sys.path.insert(0, str(_PROJECT_ROOT))
sys.path.insert(0, str(_PROJECT_ROOT / "scripts"))

import numpy as np
import pytest


# ---------------------------------------------------------------------------
# Fixtures partilhadas (item 18 do master task — baseline: várias suites
# unit/e2e pré-existentes pediam `settings`/`fake_embedder`/`ctx`/
# `seeded_library` como fixtures mas nenhuma foi alguma vez definida aqui
# (ver comentário em tests/e2e/test_porto_e2e.py:853 que já assumia isto
# viver em tests/conftest.py) — resultava em `fixture 'X' not found` em
# ~18 testes de 5 ficheiros unit + 8 e2e.
# ---------------------------------------------------------------------------
@pytest.fixture()
def settings(tmp_path):
    """Settings isolada por teste: mock_mode + auto_approve_gates (sem
    Telegram/APIs reais), data_root num tmp_path dedicado (nunca escreve
    em studio/data/ real)."""
    from studio.config import Settings

    return Settings(
        mock_mode=True,
        auto_approve_gates=True,
        data_root=tmp_path / "data",
    )


class FakeEmbedder:
    """Determinístico: vetor pseudo-aleatório seeded pelo conteúdo/texto —
    sem GPU/rede, mesma semântica do FakeEmbedder local de test_library.py."""

    dim = 768  # ver studio.library.embed.DIM

    def _vec(self, seed_bytes: bytes) -> np.ndarray:
        from studio.library.embed import DIM

        seed = int.from_bytes(hashlib.sha256(seed_bytes).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        v = rng.standard_normal(DIM).astype(np.float32)
        return v / np.linalg.norm(v)

    def embed_images(self, paths):
        return np.stack([self._vec(p.read_bytes()) for p in paths])

    def embed_text(self, text_en: str, **kwargs):
        return self._vec(text_en.encode())


@pytest.fixture()
def fake_embedder():
    return FakeEmbedder()


@pytest.fixture()
def ctx(settings, tmp_path):
    """RunContext mínimo para testes de orchestrator/stages — video_id fixo,
    run_dir isolado em tmp_path."""
    from studio.orchestrator.stage import RunContext

    return RunContext(video_id="test-video", run_dir=tmp_path / "run",
                      settings=settings, params={})


@pytest.fixture(scope="session")
def _seeded_media_file(tmp_path_factory):
    """1 vídeo real (30s, 320x240) partilhado por todos os 22 shots
    sintéticos de `seeded_library` — permite que stages de render
    (ffmpeg cut real) funcionem sem gerar 22 ficheiros."""
    d = tmp_path_factory.mktemp("seeded_media")
    out = d / "seed_source.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", "testsrc=size=320x240:rate=24:duration=30",
         "-pix_fmt", "yuv420p", str(out)],
        check=True,
    )
    return out


@pytest.fixture()
def seeded_library(settings, fake_embedder, _seeded_media_file):
    """22 shots sintéticos quality=7 (1s cada, cortados do mesmo vídeo real
    partilhado) — biblioteca 'com cobertura' para testes de discovery/
    coverage/render sem custo de I/O de 22 ficheiros reais.
    """
    from studio.library.db import LibraryDB

    db = LibraryDB(settings.library_root)
    now = datetime.now(timezone.utc).isoformat()
    rows = []
    # Diversidade cíclica (4 categorias) — cobre must_have=food/landmark
    # e entity_terms LIKE genéricos ("Lisboa"/"Porto") que os stages de
    # matching/briefs exigem, sem depender de tagging manual por teste.
    _CATEGORIES = [
        {"has_food": True, "food_csv": "comida tipica portuguesa",
         "places_csv": "", "landmarks_csv": ""},
        {"has_landmark": True, "landmarks_csv": "monumento historico",
         "places_csv": "", "food_csv": ""},
        {"places_csv": "Lisboa, Porto", "food_csv": "", "landmarks_csv": ""},
        {"places_csv": "", "food_csv": "", "landmarks_csv": ""},
    ]
    for i in range(22):
        vec = fake_embedder.embed_text(f"seeded fixture shot {i}")
        cat = _CATEGORIES[i % len(_CATEGORIES)]
        rows.append({
            "shot_id": f"seed_{i:03d}",
            "media_sha": "seedsha_shared",
            "t_in": float(i),
            "t_out": float(i) + 1.0,
            "vec": vec.tolist(),
            "summary": "seeded fixture shot",
            "places_csv": cat["places_csv"],
            "landmarks_csv": cat["landmarks_csv"],
            "food_csv": cat["food_csv"],
            "objects_csv": "",
            "shot_type": "medium",
            "camera_motion": "static",
            "time_of_day": "day",
            "indoor_outdoor": "outdoor",
            "people_present": False,
            "quality": 7,
            "has_food": cat.get("has_food", False),
            "has_landmark": cat.get("has_landmark", False),
            "restricted": False,
            "revoked": False,
            "license_source": "owned",
            "license": "owned",
            "attribution_required": False,
            "attribution_text": "",
            "source_url": "",
            "author": "",
            "usage_count": 0,
            "last_used_run": "",
            "ingested_at": now,
            "keyframes_csv": "",
            "media_path": str(_seeded_media_file),
            "meta_json": "{}",
        })
    db.add_shots(rows)
    return db
