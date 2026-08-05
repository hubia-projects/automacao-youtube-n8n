"""Router de modelos — tarefa → modelo (ARCHITECTURE.md §10).

IDs de modelo vivem em Settings (config/env), nunca hardcoded nos stages.
Fase 1: só resolução e estimativa de custo. Clientes reais (Gemini/OpenAI)
entram na Fase 3; em mock_mode devolve respostas canned.
"""

from __future__ import annotations

from dataclasses import dataclass

from studio.config import Settings


@dataclass(frozen=True)
class ModelSpec:
    provider: str  # "gemini" | "openai" | "local"
    model_id: str
    usd_per_1m_input: float
    usd_per_1m_output: float


# Preços aproximados para o ledger (afinados quando os clientes reais entrarem).
_PRICES = {
    "gemini-pro-latest": (1.25, 10.0),
    "gemini-flash-latest": (0.15, 0.60),
    "gpt-4o": (2.50, 10.0),
}


def resolve(task: str, settings: Settings) -> ModelSpec:
    """Mapa tarefa→modelo. Tarefas novas têm de ser adicionadas aqui
    explicitamente — não há default silencioso (fail-closed)."""
    routing: dict[str, str] = {
        # script
        "script.outline": settings.model_pro,
        "script.draft": settings.model_pro,
        "script.critique": settings.model_pro,
        "script.humanize": settings.model_humanize,
        "script.research": settings.model_flash,
        # visão / biblioteca
        "vision.shot_metadata": settings.model_flash,
        "matching.visual_brief": settings.model_flash,
        # revisão
        "review.rough_cut": settings.model_pro,
        # publicação / descoberta
        "publish.metadata": settings.model_flash,
        "discovery.topic_scoring": settings.model_flash,
    }
    if task not in routing:
        raise KeyError(f"tarefa LLM não registada no router: {task!r}")

    model_id = routing[task]
    provider = "openai" if model_id.startswith("gpt") else "gemini"
    prices = _PRICES.get(model_id, (1.0, 5.0))
    return ModelSpec(provider, model_id, *prices)


def estimate_cost_usd(spec: ModelSpec, input_tokens: int, output_tokens: int) -> float:
    return (
        input_tokens * spec.usd_per_1m_input / 1_000_000
        + output_tokens * spec.usd_per_1m_output / 1_000_000
    )
