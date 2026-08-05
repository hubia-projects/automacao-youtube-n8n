import pytest

from studio.llm.router import estimate_cost_usd, resolve


def test_tarefas_registadas_resolvem(settings):
    spec = resolve("script.draft", settings)
    assert spec.provider == "gemini"
    assert spec.model_id == settings.model_pro

    spec_h = resolve("script.humanize", settings)
    assert spec_h.provider == "openai"


def test_tarefa_desconhecida_falha_fechado(settings):
    with pytest.raises(KeyError):
        resolve("tarefa.inventada", settings)


def test_estimativa_de_custo(settings):
    spec = resolve("script.draft", settings)  # gemini-2.5-pro: 1.25 / 10.0
    cost = estimate_cost_usd(spec, input_tokens=1_000_000, output_tokens=100_000)
    assert cost == pytest.approx(1.25 + 1.0)
