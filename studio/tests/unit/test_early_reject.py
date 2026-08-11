"""Testes Pass 2 Fase 2 - early_reject.py + micro-batch no topup.py.

8 testes cobrindo exactamente a spec do user:
1. preflight corta duracao < 2s
2. preflight corta resolucao < 720p
3. preflight corta codec nao-h264 (hevc/vp9/av1)
4. postflight rejeita watermark detectado (getty/shutterstock/istock/watermark)
5. micro_batch_count formula (deficit=0/10/80/400 com hard_max=5)
6. topup pula ingest_file quando preflight rejeita
7. topup chama cache_mark_rejected para cada reject (URL + reason)
8. biblioteca existente inalterada por Pass 2 (smoke)

Estrategia monkeypatch:
- `studio.library.early_reject._probe` -> ffprobe mock JSON
- `studio.library.topup.preflight_check` -> reject stub
- `studio.library.sources.pexels.sweep` -> download stub (1 file dummy)
- `studio.library.ingest.ingest_file` -> tracker / never-called
"""

from __future__ import annotations

import pytest


# ----- helpers -----


def _fake_probe_result(*, duration: float = 5.0, height: int = 1080,
                        codec: str = "h264") -> dict:
    """Stub ffprobe JSON com os campos que preflight() le."""
    return {
        "format": {"duration": str(duration)},
        "streams": [{
            "codec_type": "video",
            "codec_name": codec,
            "height": height,
        }],
    }


def _tmp_video(tmp_path, size: int = 2048):
    """File dummy 2KB para tests preflight que precisam de .stat()."""
    f = tmp_path / "fake.mp4"
    f.write_bytes(b"\x00" * size)
    return f


def _make_test_settings(**overrides):
    """Settings reais com field overrides (Pydantic kwarg > .env)."""
    from studio.config import Settings
    base = dict(
        mock_mode=False,
        pexels_api_key="test_key",
        budget_usd_per_run=15.0,
        early_reject_min_duration_s=2.0,
        early_reject_min_resolution=720,
        topup_asset_useful_s_default=5.0,
    )
    base.update(overrides)
    return Settings(**base)


def _make_entity_coverage(deficit: float = 25.0):
    """EntityCoverage com todos os required fields (Pydantic 2)."""
    from studio.matching.coverage_plan import EntityCoverage
    return EntityCoverage(
        canonical_name="Francesinha",
        entity_type="food",
        priority_score=0.85,
        mention_count=1,
        required_seconds=20.0,
        target_seconds=deficit,
        min_distinct_shots=max(1, -(-int(deficit) // 8)),  # ceil(tgt/8)
        available_seconds=0.0,
        available_distinct_shots=0,
        available_files=0,
        deficit_seconds=deficit,
        strict=False,
        queries=["francesinha porto sandwich"],
        location="Porto",
    )


def _make_stub_embedder():
    """Embedder trivial sem GPU: devolve zeros de dim 768."""
    class _StubEmbedder:
        dim = 768

        def embed_images(self, paths):
            try:
                import numpy as np
                return np.zeros((len(paths), 768), dtype=np.float32)
            except ImportError:
                return [[0.0] * 768] * len(paths)

    return _StubEmbedder()


# ----- 1-3: preflight (file-level) -----


def test_1_preflight_corta_duracao_menor_2s(tmp_path, monkeypatch):
    """Duracao < 2.0s -> RejectReason 'low_duration'."""
    import studio.library.early_reject as er
    monkeypatch.setattr(er, "_probe",
                        lambda p: _fake_probe_result(duration=1.5))
    reject = er.preflight(_tmp_video(tmp_path), _make_test_settings())
    assert reject is not None and reject.code == "low_duration"
    assert "1.50s" in reject.message


def test_2_preflight_corta_resolucao_menor_720p(tmp_path, monkeypatch):
    """Altura < 720p -> RejectReason 'low_resolution'."""
    import studio.library.early_reject as er
    monkeypatch.setattr(er, "_probe",
                        lambda p: _fake_probe_result(height=480))
    reject = er.preflight(_tmp_video(tmp_path), _make_test_settings())
    assert reject is not None and reject.code == "low_resolution"
    assert "480p" in reject.message


def test_3_preflight_corta_codec_nao_h264(tmp_path, monkeypatch):
    """Codec fora de {h264, hevc, vp9, av1} -> RejectReason."""
    import studio.library.early_reject as er
    monkeypatch.setattr(er, "_probe",
                        lambda p: _fake_probe_result(codec="wmv2"))
    reject = er.preflight(_tmp_video(tmp_path), _make_test_settings())
    assert reject is not None and reject.code == "unsupported_codec"
    assert "wmv2" in reject.message


# ----- 4: postflight (Vision metadata-level) -----


def test_4_postflight_rejeita_watermark():
    """Keyword 'getty stock' no summary -> RejectReason 'watermark'."""
    import studio.library.early_reject as er
    metadata = {
        "summary": "Authored by getty stock photos for editorial use",
        "places": [], "objects": [],
    }
    reject = er.postflight(metadata, expected_location=None)
    assert reject is not None
    assert reject.code == "watermark"


# ----- 5: micro_batch_count formula -----


def test_5_micro_batch_count_formula():
    """deficit=0->0, 10->2, 80->5 (clamp), 400->5 (clamp)."""
    from studio.library.topup import micro_batch_count
    # deficit=0 -> 0 (caller skip search)
    assert micro_batch_count(0.0, useful_per_asset_s=5.0) == 0
    # deficit=10 -> ceil(10/5)=2
    assert micro_batch_count(10.0, useful_per_asset_s=5.0) == 2
    # deficit=80 -> 16, clamped a hard_max=5
    assert micro_batch_count(80.0, useful_per_asset_s=5.0) == 5
    # deficit=400 -> 80, clamped a hard_max=5
    assert micro_batch_count(400.0, useful_per_asset_s=5.0) == 5
    # boundary: deficit=25 -> ceil(25/5)=5 = hard_max
    assert micro_batch_count(25.0, useful_per_asset_s=5.0) == 5


# ----- 6: topup pula ingest_file quando preflight rejeita -----


def test_6_topup_pula_ingest_file_quando_preflight_rejeita(
    tmp_path, monkeypatch,
):
    """Quando preflight retorna reject -> ingest_file NAO e chamado."""
    from studio.library.db import LibraryDB
    from studio.library.topup import topup_for_plan
    from studio.matching.coverage_plan import CoveragePlan
    import studio.library.topup as topup_mod

    db = LibraryDB(tmp_path)
    plan = CoveragePlan(ranked_entities=[_make_entity_coverage(25.0)])
    s = _make_test_settings()

    dummy_file = _tmp_video(tmp_path, size=4096)
    lic_blob = {"source_url": "https://pexels.com/v/never-ingested/",
                "license": "pexels", "source": "pexels"}

    monkeypatch.setattr(
        "studio.library.sources.pexels.sweep",
        lambda q, count, settings, dest: [(dummy_file, lic_blob)],
    )

    import studio.library.early_reject as er
    reject = er.RejectReason("low_resolution", "test stub")
    monkeypatch.setattr(topup_mod, "preflight_check", lambda p, s: reject)

    ingest_calls = {"count": 0}

    def tracker_ingest(*args, **kwargs):
        ingest_calls["count"] += 1
        from studio.library.ingest import IngestResult
        return IngestResult(status="ingested", media_sha="x", shots_added=0)

    monkeypatch.setattr("studio.library.ingest.ingest_file", tracker_ingest)

    topup_for_plan(plan, db, s, _make_stub_embedder(), max_rounds=1)

    assert ingest_calls["count"] == 0, (
        f"ingest_file NAO devia ser chamado quando preflight rejeita; "
        f"chamado {ingest_calls['count']}x"
    )


# ----- 7: topup chama cache_mark_rejected para cada reject -----


def test_7_topup_chama_cache_mark_rejected_para_cada_preflight_reject(
    tmp_path, monkeypatch,
):
    """Para cada reject -> db.cache_mark_rejected(provider='pexels',
    source_url=lic.source_url, reason=str(reject)).
    """
    from studio.library.db import LibraryDB
    from studio.library.topup import topup_for_plan
    from studio.matching.coverage_plan import CoveragePlan
    import studio.library.topup as topup_mod

    db = LibraryDB(tmp_path)
    plan = CoveragePlan(ranked_entities=[_make_entity_coverage(25.0)])
    s = _make_test_settings()

    unique_url = "https://pexels.com/v/cache-mark-test-789/"
    dummy_file = _tmp_video(tmp_path, size=4096)
    lic_blob = {"source_url": unique_url, "license": "pexels",
                "source": "pexels"}

    monkeypatch.setattr(
        "studio.library.sources.pexels.sweep",
        lambda q, count, settings, dest: [(dummy_file, lic_blob)],
    )

    import studio.library.early_reject as er
    reject = er.RejectReason("low_resolution", "test stub reason 123")
    monkeypatch.setattr(topup_mod, "preflight_check", lambda p, s: reject)
    # ingest_file NUNCA chamado (preflight rejeita)
    monkeypatch.setattr(
        "studio.library.ingest.ingest_file",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError(
            "ingest_file should NOT be called when preflight rejects")),
    )

    topup_for_plan(plan, db, s, _make_stub_embedder(), max_rounds=1)

    cached = db.cache_get("pexels", unique_url)
    assert cached is not None, "cache_mark_rejected NAO foi chamado"
    assert cached["status"] == "rejected"
    assert "low_resolution" in cached["reason"]


# ----- 8: biblioteca existente intacta apos Pass 2 -----


def test_8_biblioteca_existente_inalterada_por_pass2(tmp_path, monkeypatch):
    """Pass 2 (preflight + micro-batch) NAO corrompe a library/cache.

    Pre-populate cache; corre preflight (com _probe mockado,
    code-reviewer nit substitui try/except swallow); verifica que cache
    count + entries permanecem inalterados (preflight le mas NAO escreve).
    """
    from studio.library.db import LibraryDB
    import studio.library.early_reject as er

    db = LibraryDB(tmp_path)

    # Pre-populated: mistura de hit + rejected (simula data existente)
    db.cache_mark("pexels", "https://existing.example/v/1",
                  media_sha="existing_sha_1")
    db.cache_mark_rejected("pixabay", "https://bad.example/v/2",
                            "old reject - watermark")
    initial_count = db._cache_tbl.count_rows()
    assert initial_count == 2

    # Mock ffprobe (code-reviewer nit substitui try/except swallow por
    # mock determ.) - evita dependencia da subprocess ffprobe em CI.
    monkeypatch.setattr(er, "_probe", lambda p: _fake_probe_result())
    fake_video = _tmp_video(tmp_path, size=4096)
    reject = er.preflight(fake_video, _make_test_settings())
    # Sanity: file valido -> preflight NAO rejeita
    assert reject is None

    # Cache count + entries intactas
    assert db._cache_tbl.count_rows() == 2, (
        "preflight NAO deve escrever na cache; count mudou"
    )
    e1 = db.cache_get("pexels", "https://existing.example/v/1")
    assert e1 is not None and e1["status"] == "hit"
    assert e1["media_sha"] == "existing_sha_1"
    e2 = db.cache_get("pixabay", "https://bad.example/v/2")
    assert e2 is not None and e2["status"] == "rejected"
    assert "watermark" in e2["reason"]
