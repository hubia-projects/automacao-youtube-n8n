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
    _call_resolver,
    acquire_for_deficits,
    make_provider_resolver,
    query_hierarchy,
    run_acquisition_for_workset,
)
from studio.library.sources.pexels import CandidateMetadata


def test_call_resolver_com_resolver_que_aceita_hints():
    calls = []

    def resolver(query, level, canonical_hints=()):
        calls.append((query, level, canonical_hints))
        return []

    _call_resolver(resolver, "q", 1, ("Alias A",))
    assert calls == [("q", 1, ("Alias A",))]


def test_call_resolver_com_resolver_legacy_2_args_nao_quebra():
    calls = []

    def resolver(query, level):
        calls.append((query, level))
        return []

    _call_resolver(resolver, "q", 1, ("Alias A",))
    assert calls == [("q", 1)]


def test_make_provider_resolver_passa_canonical_hints_so_para_wikimedia(
    tmp_path,
):
    """item PORTO (search+confirmation calibration): resolver aceita
    `canonical_hints` opcional; só é reencaminhado para `wikimedia.search()`
    (entity-aware) — outros providers (pexels/pixabay) nunca recebem esse
    kwarg (as suas `search()` não o aceitam)."""
    search_calls = []

    def fake_wikimedia_search(query, count, settings, **kw):
        search_calls.append((query, count, kw))
        return []

    with patch("studio.library.sources.wikimedia.search",
              side_effect=fake_wikimedia_search):
        resolver = make_provider_resolver(
            MagicMock(), tmp_path / "dest", providers=("wikimedia",),
            db=MagicMock(), count_per_query=3)
        resolver("Livraria Lello", 0,
                 canonical_hints=("Livraria Lello", "Lello Bookstore"))

    assert len(search_calls) == 1
    _query, _count, kw = search_calls[0]
    assert kw.get("canonical_hints") == ("Livraria Lello", "Lello Bookstore")


def test_make_provider_resolver_sem_canonical_hints_nao_quebra(tmp_path):
    """Chamada legacy `resolver(query, level)` (sem canonical_hints)
    continua a funcionar — nunca obrigatório."""
    def fake_wikimedia_search(query, count, settings, **kw):
        assert "canonical_hints" not in kw
        return []

    with patch("studio.library.sources.wikimedia.search",
              side_effect=fake_wikimedia_search):
        resolver = make_provider_resolver(
            MagicMock(), tmp_path / "dest", providers=("wikimedia",),
            db=MagicMock(), count_per_query=3)
        resolver("Sé do Porto", 0)


def test_query_hierarchy_extra_queries_anexadas_no_fim():
    levels = query_hierarchy(
        "gothic cathedral facade Porto", ("Catedral da Sé",), "Porto",
        n_levels=4,
        extra_queries=("Porto Cathedral exterior", "Se Cathedral interior"),
    )
    assert levels[-2:] == ["Porto Cathedral exterior", "Se Cathedral interior"]
    assert len(levels) == 6


def test_query_hierarchy_extra_queries_dedup_contra_niveis_existentes():
    levels = query_hierarchy(
        "Livraria Lello", (), "",
        n_levels=4,
        extra_queries=("Livraria Lello", "Lello Bookstore"),
    )
    # "Livraria Lello" já é o nível canonical (L1) — não deve duplicar.
    assert levels.count("Livraria Lello") == 1
    assert "Lello Bookstore" in levels


def test_query_hierarchy_sem_extra_queries_comportamento_legacy_intocado():
    levels = query_hierarchy("Francesinha", ("comida do Porto",), "Porto",
                             n_levels=4)
    assert levels == [
        "Francesinha Porto",
        "Francesinha Porto comida do Porto",
        "Francesinha",
        "Francesinha",
    ]


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
def test_provider_rate_limited_termina_a_chamada_sem_hang(monkeypatch):
    """item PORTO FINAL ASSET TEST (secções 7-10): quando o
    provider_resolver levanta ProviderRateLimitedError, acquire_for_deficits
    tem de terminar IMEDIATAMENTE (nunca continuar a martelar o mesmo
    provider através dos restantes níveis de query/entidades) — o waterfall
    (fora desta função, em run_acquisition_for_workset) avança para o
    próximo provider na iteração seguinte."""
    from studio.library.provider_errors import ProviderRateLimitedError

    spec = _ReqSpec("Sé do Porto")
    ctx = _workset_ctx_stub([spec])
    deficit = DeficitItem(
        canonical_entity="Sé do Porto", requirement_id=spec.requirement_id,
        target_seconds=100.0, deficit_seconds=100.0, min_distinct_shots=5,
    )
    calls = {"n": 0}

    def resolver(query, level):
        calls["n"] += 1
        raise ProviderRateLimitedError("wikimedia", "rate-limited")

    qh = MagicMock()
    qh.was_tried.return_value = None
    acq = acquire_for_deficits(
        workset_ctx=ctx, db=MagicMock(), embedder=MagicMock(),
        settings=MagicMock(mock_mode=True),
        deficit_items=[deficit], provider_resolver=resolver,
        query_history_db=qh,
        remeasure_coverage=lambda: False,
        max_iterations=8, provider_name_for_history="wikimedia",
    )
    assert calls["n"] == 1, (
        "devia ter parado ao 1º rate-limit, nunca continuar a tentar mais "
        "níveis/queries contra o mesmo provider"
    )
    assert acq.provider_rate_limited == "wikimedia"
    recorded = qh.record.call_args_list[0].args[0]
    assert recorded.status == "rate_limited"


def test_query_history_rate_limited_nunca_bloqueia_retry_futuro():
    """status="rate_limited" é distinto de "empty"/"error" — was_tried()
    nunca deve fazer skip por causa dele (secção 9: nunca vira EMPTY
    permanente)."""
    qh = MagicMock()
    qh.was_tried.return_value = "rate_limited"
    spec = _ReqSpec("Sé do Porto")
    ctx = _workset_ctx_stub([spec])
    deficit = DeficitItem(
        canonical_entity="Sé do Porto", requirement_id=spec.requirement_id,
        target_seconds=100.0, deficit_seconds=100.0, min_distinct_shots=5,
    )
    calls = {"n": 0}

    def resolver(query, level):
        calls["n"] += 1
        return []

    acquire_for_deficits(
        workset_ctx=ctx, db=MagicMock(), embedder=MagicMock(),
        settings=MagicMock(mock_mode=True),
        deficit_items=[deficit], provider_resolver=resolver,
        query_history_db=qh,
        remeasure_coverage=lambda: False,
        max_iterations=1,
    )
    assert calls["n"] > 0, (
        "query com status anterior 'rate_limited' devia continuar "
        "elegível para retry — nunca tratada como 'empty'/'error'"
    )


def test_waterfall_avanca_para_proximo_provider_apos_rate_limit():
    """secção 15: Wikimedia rate-limited -> Pexels devolve candidato ->
    Pixabay nem chega a ser tentado. Sem hang, sem esperar."""
    from studio.library.provider_errors import ProviderRateLimitedError
    from studio.library.requirement_index import RequirementMatch

    spec = _ReqSpec("Sé do Porto")
    ctx = _workset_ctx_stub([spec])
    plan = MagicMock()
    ent = MagicMock(canonical_name="Sé do Porto", entity_type="landmark",
                    strict=True, deficit_seconds=100.0, target_seconds=100.0,
                    min_distinct_shots=2, priority_score=1.0)
    plan.ranked_entities = [ent]

    call_log: list[str] = []

    def fake_make_provider_resolver(settings, dest, *, providers, **kw):
        provider = providers[0]

        def _resolver(query, level, canonical_hints=()):
            call_log.append(provider)
            if provider == "wikimedia":
                raise ProviderRateLimitedError("wikimedia", "rate-limited")
            if provider == "pexels":
                p = Path(f"/tmp/fake_pexels.mp4")
                return [(p, {"provider": "pexels", "source_url": "http://x/1"})]
            return []
        return _resolver

    ri = MagicMock()
    ri.list_for_requirement.return_value = [
        RequirementMatch(workset_id="wf-test", requirement_id=spec.requirement_id,
                         shot_id="s1", media_sha="sha1", similarity=0.9,
                         duration=5.0, confirmation_status="NOT_REQUIRED",
                         confirmation_confidence=0.0, strict_eligible=False),
    ]

    with patch("studio.library.acquisition.make_provider_resolver",
              side_effect=fake_make_provider_resolver), \
         patch("studio.library.provider_policy.provider_policy",
              return_value=["wikimedia", "pexels", "pixabay"]), \
         patch("studio.library.acquisition.preflight_media",
              return_value=(True, "")), \
         patch("studio.library.ingest_asset.ingest_asset") as mock_ingest:
        mock_ingest.return_value = (
            MagicMock(status="ingested", media_sha="sha1", shots_added=1),
            MagicMock(),
        )
        rep = run_acquisition_for_workset(
            plan, ctx, MagicMock(), MagicMock(), MagicMock(mock_mode=False),
            requirement_index=ri, query_history=MagicMock(
                was_tried=MagicMock(return_value=None)),
        )
    assert call_log.count("wikimedia") == 1, (
        "rate-limit deve parar a chamada ao 1º hit — nunca martelar o "
        "mesmo provider repetidamente"
    )
    assert "pexels" in call_log, (
        "waterfall deve avançar para o próximo provider após rate-limit, "
        "nunca ficar preso no Wikimedia"
    )
    assert rep.downloads_succeeded >= 1


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
