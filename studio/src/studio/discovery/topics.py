"""Descoberta de temas — shortlist semanal com o sinal diferenciador:
cobertura da PRÓPRIA biblioteca (nunca aprovar tema sem footage).

v1: brainstorm Flash + calendário sazonal + cobertura LanceDB.
TODO(Fase 8+): YouTube Data API (outliers de concorrentes) e pytrends —
adiados; ambos frágeis/quota e o sinal de cobertura é o que muda decisões.
"""

from __future__ import annotations

import json
import re
from datetime import datetime

from pydantic import BaseModel

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.library.search import search_shots
from studio.llm.gemini import generate


class TopicIdea(BaseModel):
    title_pt: str
    angle: str = ""
    query_en: str  # para medir cobertura na biblioteca
    demand_score: int = 5   # 0-10 (LLM)
    evergreen: int = 5      # 0-10 (LLM)
    coverage_pct: float = 0.0
    total_score: float = 0.0


def _seasonal_hooks(settings: Settings) -> list[str]:
    path = settings.prompts_root.parent / "seed" / "seasonal_pt.yaml"
    if not path.exists():
        return []
    month = datetime.now().month
    for line in path.read_text("utf-8").splitlines():
        m = re.match(rf"^{month}:\s*\[(.*)\]", line.strip())
        if m:
            return [h.strip() for h in m.group(1).split(",")]
    return []


def _coverage(idea: TopicIdea, db: LibraryDB, embedder, settings: Settings) -> float:
    """% de um alvo de 30 shots relevantes (quality≥4) que a biblioteca cobre."""
    hits = search_shots(db, embedder, idea.query_en, min_quality=4, k=30)
    return round(100.0 * len(hits) / 30.0, 1)


def discover_topics(settings: Settings, embedder, count: int = 8) -> tuple[list[TopicIdea], float]:
    hooks = _seasonal_hooks(settings)
    if settings.mock_mode:
        ideas = [TopicIdea(title_pt=f"Tema mock {i}", query_en="portuguese food street",
                           demand_score=7, evergreen=6) for i in range(count)]
        cost = 0.0
    else:
        prompt = (
            f"És estratega de canal YouTube PT-BR (viagens/gastronomia/cultura, "
            f"long-form 10-15min). Mês atual: {datetime.now().month}. Ganchos "
            f"sazonais: {hooks}. Gera {count} temas de vídeo com potencial. "
            'JSON array: [{"title_pt": "...", "angle": "por que retém", '
            '"query_en": "stock footage query in english", '
            '"demand_score": 0-10, "evergreen": 0-10}]. JSON puro.'
        )
        text, cost = generate(prompt, settings, model=settings.model_flash,
                              json_mode=True, temperature=0.8, tag="discovery")
        m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
        ideas = [TopicIdea.model_validate(t)
                 for t in json.loads((m.group(1) if m else text).strip())]

    db = LibraryDB(settings.library_root)
    for idea in ideas:
        idea.coverage_pct = _coverage(idea, db, embedder, settings)
        # cobertura pesa 40%: nunca propor o que não se consegue mostrar
        idea.total_score = round(0.3 * idea.demand_score * 10
                                 + 0.3 * idea.evergreen * 10
                                 + 0.4 * idea.coverage_pct, 1)
    ideas.sort(key=lambda i: i.total_score, reverse=True)
    return ideas, cost
