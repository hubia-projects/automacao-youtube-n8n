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
from studio.library.sources.pexels import CandidateMetadata


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


# ---------------------------------------------------------------------------
# T9/item 34 (idempotência) — coverage já pronta -> ZERO chamadas ao
# provider. Simula "RUN B" contra o mesmo workset de uma "RUN A" anterior:
# remeasure_coverage() devolve True imediatamente (biblioteca já cobre
# tudo), então o loop nunca deve chamar provider_resolver.
# ---------------------------------------------------------------------------
def test_coverage_ja_pronta_zero_chamadas_ao_provider():
    spec = _ReqSpec("Livraria Lello")
    ctx = _workset_ctx_stub([spec])
    # deficit_seconds=0 -> is_covered=True; mesmo assim confirmamos que o
    # provider_resolver nunca é invocado quando remeasure já diz "ready".
    deficit = DeficitItem(
        canonical_entity="Livraria Lello", requirement_id=spec.requirement_id,
        target_seconds=100.0, deficit_seconds=0.0, min_distinct_shots=5,
    )
    provider_calls = {"n": 0}

    def resolver(query, level):
        provider_calls["n"] += 1
        return []

    acq = acquire_for_deficits(
        workset_ctx=ctx, db=MagicMock(), embedder=MagicMock(),
        settings=MagicMock(mock_mode=True),
        deficit_items=[deficit],
        provider_resolver=resolver,
        remeasure_coverage=lambda: True,  # RUN B: já 100% coberto
        max_iterations=8,
    )
    assert provider_calls["n"] == 0, (
        "provider_resolver foi chamado apesar de remeasure_coverage=True "
        "no início — RUN B deveria ser zero-download"
    )
    assert acq.coverage_ready is True
    assert acq.downloads_attempted == 0
    assert acq.queries_run == 0


# ---------------------------------------------------------------------------
# Item Q (closure pass) — deficits nunca podem ficar congelados. A com
# deficit=30 fecha na 1ª wave (via refresh_deficit); a wave seguinte tem de
# escolher B (deficit=20), NUNCA voltar a pedir A.
# ---------------------------------------------------------------------------
def test_stale_deficit_corrigido_proxima_wave_escolhe_b_depois_de_a_fechar():
    spec_a = _ReqSpec("A")
    spec_b = _ReqSpec("B")
    ctx = _workset_ctx_stub([spec_a, spec_b])
    deficit_a = DeficitItem(
        canonical_entity="A", requirement_id=spec_a.requirement_id,
        target_seconds=30.0, deficit_seconds=30.0, min_distinct_shots=1,
        priority_score=1.0,
    )
    deficit_b = DeficitItem(
        canonical_entity="B", requirement_id=spec_b.requirement_id,
        target_seconds=20.0, deficit_seconds=20.0, min_distinct_shots=1,
        priority_score=1.0,
    )
    queries_for = {"A": 0, "B": 0}

    def resolver(query, level):
        if query.startswith("A"):
            queries_for["A"] += 1
            return [(Path(f"/tmp/fakeA_{queries_for['A']}.mp4"),
                     {"provider": "pexels", "source_url": f"uA{queries_for['A']}"})]
        queries_for["B"] += 1
        return []  # B nunca resolve — força o loop a continuar a tentar B

    def refresh(item):
        # simula remeasure real: a wave que ingeriu algo para A fecha-o.
        return 0.0 if item.canonical_entity == "A" else item.deficit_seconds

    db = MagicMock()
    db.cache_get.return_value = None

    with patch("studio.library.acquisition.preflight_media",
              return_value=(True, "")):
        with patch("studio.library.ingest_asset.ingest_asset") as mock_ingest:
            mock_ingest.return_value = (
                MagicMock(status="ingested", media_sha="shaA", shots_added=1),
                MagicMock(),
            )
            acq = acquire_for_deficits(
                workset_ctx=ctx, db=db, embedder=MagicMock(),
                settings=MagicMock(mock_mode=True),
                deficit_items=[deficit_a, deficit_b],
                provider_resolver=resolver,
                remeasure_coverage=lambda: False,
                refresh_deficit=refresh,
                max_iterations=5,
                # 1 nível por wave (doutrina item R: uma wave = uma
                # decisão) — evita que o mesmo canonical de 1 palavra
                # produza 2 níveis idênticos ("A","A") dentro da MESMA
                # wave, o que confundiria a asserção de "nunca mais
                # pedido depois de fechado" com "pedido 2x na wave que o
                # fechou".
                n_levels=1,
            )
    assert deficit_a.deficit_seconds == 0.0, (
        "refresh_deficit devia ter actualizado deficit_a in-place"
    )
    assert queries_for["A"] == 1, (
        f"A devia ser pedido exactamente 1x (fecha na wave que o resolve); "
        f"pedido {queries_for['A']}x — deficit congelado voltaria a pedir A"
    )
    assert queries_for["B"] >= 1, "B devia continuar a ser tentado após A fechar"
    assert acq.coverage_status["A"]["deficit_seconds"] == 0.0
    assert acq.coverage_status["A"]["is_covered"] is True


# ---------------------------------------------------------------------------
# Item P (closure pass) — pre-download dedup REAL: candidato já conhecido
# (cache_get hit) nunca deve chegar a `download()` — zero GET de vídeo.
# ---------------------------------------------------------------------------
def test_make_provider_resolver_pre_download_dedup_skip_conhecidos(tmp_path):
    known = CandidateMetadata(
        provider="pexels", provider_id="111",
        source_url="https://www.pexels.com/video/111/",
        download_url="http://x/111.mp4", license={"source": "pexels"},
    )
    fresh = CandidateMetadata(
        provider="pexels", provider_id="222",
        source_url="https://www.pexels.com/video/222/",
        download_url="http://x/222.mp4", license={"source": "pexels"},
    )
    download_calls = []

    def fake_search(query, count, settings):
        return [known, fresh]

    def fake_download(candidate, settings, dest):
        download_calls.append(candidate.provider_id)
        return tmp_path / f"pexels_{candidate.provider_id}.mp4"

    def fake_cache_get(provider, source_url):
        if source_url == known.source_url:
            return {"status": "HIT"}
        return None

    db = MagicMock()
    db.cache_get.side_effect = fake_cache_get

    with patch("studio.library.sources.pexels.search", side_effect=fake_search), \
         patch("studio.library.sources.pexels.download", side_effect=fake_download):
        resolver = make_provider_resolver(
            MagicMock(), tmp_path / "dest", providers=("pexels",), db=db)
        results = resolver("Livraria Lello Porto", 0)

    assert download_calls == ["222"], (
        "candidato já conhecido (cache HIT) não devia chegar a download() — "
        "pre-download dedup falhou"
    )
    assert len(results) == 1
    assert results[0][1]["source_url"] == fresh.source_url


def test_make_provider_resolver_sem_db_cai_no_sweep_legacy(tmp_path):
    """Sem `db`, o resolver não tem como verificar dedup pré-download —
    deve continuar a usar o `sweep()` legacy (comportamento anterior),
    nunca chamar `search()`/`download()` directamente."""
    calls = []

    def fake_sweep(query, count, settings, dest):
        calls.append(query)
        return [(tmp_path / "clip.mp4", {"source_url": "http://x/clip.mp4"})]

    (tmp_path / "clip.mp4").write_bytes(b"fake")

    with patch("studio.library.sources.pexels.sweep", side_effect=fake_sweep):
        resolver = make_provider_resolver(
            MagicMock(), tmp_path / "dest", providers=("pexels",))
        results = resolver("Sé do Porto", 0)

    assert calls == ["Sé do Porto"]
    assert len(results) == 1
