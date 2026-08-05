from studio.discovery.topics import discover_topics


def test_discovery_mock_com_cobertura(settings, fake_embedder, seeded_library):
    ideas, cost = discover_topics(settings, fake_embedder, count=6)
    assert len(ideas) == 6 and cost == 0.0
    # cobertura calculada contra a biblioteca fixture (22 shots quality 7)
    assert all(i.coverage_pct > 0 for i in ideas)
    # ordenado por score composto
    scores = [i.total_score for i in ideas]
    assert scores == sorted(scores, reverse=True)


def test_discovery_biblioteca_vazia_da_cobertura_zero(settings, fake_embedder):
    ideas, _ = discover_topics(settings, fake_embedder, count=3)
    assert all(i.coverage_pct == 0.0 for i in ideas)
