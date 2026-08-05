"""Testes da biblioteca com FakeEmbedder (sem GPU/rede) e fixture ffmpeg.

Metadados em mock_mode derivam do nome do ficheiro (metadata._mock_metadata):
"food" no nome → has_food; "monument" → has_landmark. Isso permite testar
os filtros duros da busca sem APIs.
"""

import hashlib
import shutil
import subprocess

import numpy as np
import pytest

from studio.library.db import LibraryDB
from studio.library.embed import DIM
from studio.library.ingest import ingest_file
from studio.library.search import search_shots


class FakeEmbedder:
    """Determinístico: vetor pseudo-aleatório seeded pelo conteúdo/texto."""

    dim = DIM

    def _vec(self, seed_bytes: bytes) -> np.ndarray:
        seed = int.from_bytes(hashlib.sha256(seed_bytes).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        v = rng.standard_normal(DIM).astype(np.float32)
        return v / np.linalg.norm(v)

    def embed_images(self, paths):
        return np.stack([self._vec(p.read_bytes()) for p in paths])

    def embed_text(self, text_en: str):
        return self._vec(text_en.encode())


@pytest.fixture(scope="session")
def fixture_video(tmp_path_factory):
    """Vídeo 2 cenas (vermelho 2s + azul 2s), 320x240 — corte abrupto."""
    d = tmp_path_factory.mktemp("media")
    parts = []
    for name, color in [("a", "red"), ("b", "blue")]:
        p = d / f"{name}.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
             "-i", f"color=c={color}:s=320x240:d=2:r=24", "-pix_fmt", "yuv420p", str(p)],
            check=True,
        )
        parts.append(p)
    concat = d / "list.txt"
    concat.write_text("".join(f"file '{p}'\n" for p in parts))
    out = d / "two_scenes_food_test.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
         "-i", str(concat), "-c", "copy", str(out)],
        check=True,
    )
    return out


@pytest.fixture()
def db(settings):
    return LibraryDB(settings.library_root)


def test_ingest_e_dedup_noop(settings, db, fixture_video):
    emb = FakeEmbedder()
    r1 = ingest_file(fixture_video, {"source": "owned", "source_url": "", "license": "owned"},
                     db, settings, emb)
    assert r1.status == "ingested"
    assert r1.shots_added >= 2  # corte vermelho→azul detetado
    count_after_first = db.count()

    # re-ingerir o MESMO conteúdo (nome diferente) → no-op por SHA-256
    copy = fixture_video.parent / "renamed_copy.mp4"
    shutil.copy2(fixture_video, copy)
    r2 = ingest_file(copy, {"source": "owned", "source_url": "", "license": "owned"},
                     db, settings, emb)
    assert r2.status == "skipped_duplicate"
    assert db.count() == count_after_first

    # log de ingestão regista ambos
    log_text = (settings.library_root / "ingest_log.jsonl").read_text()
    assert '"ingested"' in log_text and '"skipped_duplicate"' in log_text


def test_ingest_sem_licenca_rejeitado(settings, db, fixture_video):
    r = ingest_file(fixture_video, {"source": "pexels", "source_url": "x"},  # sem license
                    db, settings, FakeEmbedder())
    assert r.status == "rejected"
    assert db.count() == 0  # nada entrou


def test_filtros_duros_na_busca(settings, db, fixture_video, tmp_path):
    emb = FakeEmbedder()
    # nome contém "food" → mock metadata marca has_food (ver metadata._mock_metadata)
    food = tmp_path / "street_food_lisbon.mp4"
    shutil.copy2(fixture_video, food)
    # conteúdo diferente para SHA distinto: re-encode rápido
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(fixture_video),
                    "-vf", "hue=s=0", str(food)], check=True)
    monument = tmp_path / "monument_tower.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(fixture_video),
                    "-vf", "negate", str(monument)], check=True)

    assert ingest_file(food, {"source": "owned", "source_url": "", "license": "owned"},
                       db, settings, emb).status == "ingested"
    assert ingest_file(monument, {"source": "owned", "source_url": "", "license": "owned"},
                       db, settings, emb).status == "ingested"

    # must_not=monument exclui TODOS os shots com has_landmark (filtro duro)
    res = search_shots(db, emb, "close-up of traditional portuguese dish",
                       must_have=["food"], must_not=["monument"], min_quality=0)
    assert res, "busca devia devolver os shots de comida"
    assert all(r["has_food"] for r in res)
    assert all(not r["has_landmark"] for r in res)

    # inverso: must_have=landmark só devolve o monumento
    res2 = search_shots(db, emb, "historic tower", must_have=["landmark"], min_quality=0)
    assert res2 and all(r["has_landmark"] for r in res2)


def test_usage_tracking(settings, db, fixture_video):
    emb = FakeEmbedder()
    ingest_file(fixture_video, {"source": "owned", "source_url": "", "license": "owned"},
                db, settings, emb)
    res = search_shots(db, emb, "anything", min_quality=0)
    shot_id = res[0]["shot_id"]
    db.register_usage(shot_id, "run-123")
    res2 = [r for r in search_shots(db, emb, "anything", min_quality=0)
            if r["shot_id"] == shot_id]
    assert res2[0]["usage_count"] == 1
    assert res2[0]["last_used_run"] == "run-123"
