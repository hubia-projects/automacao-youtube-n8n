"""Testes acquisition.py (item 9 — provider_resolver real + safety caps).

Cobre:
- make_provider_resolver adapta sweep(query, count, settings, dest) real
  para a assinatura provider_resolver(query, level) esperada por
  acquire_for_deficits.
- max_downloads é um safety cap honesto (STOP antes de esgotar
  max_iterations quando o cap é atingido).
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from studio.library.acquisition import (
    DeficitItem,
    acquire_for_deficits,
    make_provider_resolver,
)


def test_make_provider_resolver_chama_sweep_real_com_assinatura_certa(tmp_path):
    calls = []

    def fake_sweep(query, count, settings, dest):
        calls.append((query, count, dest))
        return [(tmp_path / "clip.mp4", {"source_url": "http://x/clip.mp4"})]

    (tmp_path / "clip.mp4").write_bytes(b"fake")

    with patch("studio.library.sources.pexels.sweep", side_effect=fake_sweep):
        resolver = make_provider_resolver(
            MagicMock(), tmp_path / "dest", providers=("pexels",),
            count_per_query=2)
        results = resolver("Livraria Lello Porto", 0)

    assert len(calls) == 1
    query, count, dest = calls[0]
    assert query == "Livraria Lello Porto"
    assert count == 2
    assert len(results) == 1
    path, meta = results[0]
    assert meta["provider"] == "pexels"


def test_make_provider_resolver_provider_desconhecido_nao_rebenta(tmp_path):
    resolver = make_provider_resolver(
        MagicMock(), tmp_path, providers=("provider_inexistente",))
    assert resolver("qualquer", 0) == []


def test_make_provider_resolver_sweep_falha_nao_rebenta(tmp_path):
    with patch("studio.library.sources.pexels.sweep",
              side_effect=RuntimeError("network down")):
        resolver = make_provider_resolver(
            MagicMock(), tmp_path, providers=("pexels",))
        assert resolver("qualquer", 0) == []


def _workset_ctx_stub(requirements):
    ctx = MagicMock()
    ctx.requirements = requirements
    ctx.workflow_id = "wf-test"
    ctx.requirement_prompts = {}

    def req_by_canonical(canon):
        for r in requirements:
            if r.canonical_entity == canon:
                return r
        return None
    ctx.req_by_canonical.side_effect = req_by_canonical
    return ctx


class _ReqSpec:
    def __init__(self, canonical_entity, aliases=(), location=""):
        self.canonical_entity = canonical_entity
        self.aliases = aliases
        self.location = location
        self.requirement_id = f"R-{canonical_entity}"


def test_max_downloads_safety_cap_para_o_loop_honestamente():
    """Com um provider_resolver que devolve sempre 1 resultado novo e
    coverage nunca fica ready, max_downloads deve parar o loop antes de
    max_iterations esgotar — STOP HONESTO, não loop infinito."""
    spec = _ReqSpec("Livraria Lello")
    ctx = _workset_ctx_stub([spec])
    deficit = DeficitItem(
        canonical_entity="Livraria Lello", requirement_id=spec.requirement_id,
        target_seconds=100.0, deficit_seconds=100.0, min_distinct_shots=5,
    )

    call_count = {"n": 0}

    def resolver(query, level):
        call_count["n"] += 1
        p = Path(f"/tmp/fake_{call_count['n']}.mp4")
        return [(p, {"provider": "pexels", "source_url": f"http://x/{call_count['n']}"})]

    db = MagicMock()
    db.cache_get.return_value = None  # nunca já visto

    with patch("studio.library.acquisition.preflight_media",
              return_value=(True, "")), \
         patch("studio.library.acquisition.ingest_asset",
              create=True) as _unused:
        with patch("studio.library.ingest_asset.ingest_asset") as mock_ingest:
            mock_ingest.return_value = (
                MagicMock(status="ingested", media_sha="sha1", shots_added=1),
                MagicMock(),
            )
            acq = acquire_for_deficits(
                workset_ctx=ctx, db=db, embedder=MagicMock(),
                settings=MagicMock(mock_mode=True),
                deficit_items=[deficit],
                provider_resolver=resolver,
                remeasure_coverage=lambda: False,  # nunca fica ready
                max_iterations=1000,
                max_downloads=3,
            )
    assert acq.downloads_succeeded <= 3 + 8  # cap + slack de 1 iteração
    assert acq.iterations < 1000, "devia ter parado bem antes de max_iterations"
