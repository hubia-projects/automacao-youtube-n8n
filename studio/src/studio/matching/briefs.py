"""Briefs visuais por cena — SEMPRE em inglês (ADR-0003).

O brief é a query da busca cross-modal + os filtros duros must_have/must_not.
Mock: heurística determinística por palavras PT (comida/monumento).
"""

from __future__ import annotations

import json
import logging
import re

from pydantic import BaseModel, Field

from studio.config import Settings
from studio.llm.gemini import generate
from studio.script.scenes import Scene

log = logging.getLogger("studio.briefs")

_FOOD_PT = re.compile(r"\b(pastel|pastéis|receita|doce|comida|prato|sabor|comer|"
                      r"bacalhau|nata|restaurante|gastronomia|café)\b", re.I)
_MONUMENT_PT = re.compile(r"\b(mosteiro|monumento|torre|igreja|castelo|palácio|"
                          r"catedral|muralha)\b", re.I)


class VisualBrief(BaseModel):
    scene_id: str
    visual_subject_en: str
    must_have: list[str] = Field(default_factory=list)
    must_not: list[str] = Field(default_factory=list)
    shot_type_pref: str = "medium"
    mood: str = ""
    # entidade própria que a narração NOMEIA (monumento/prato exato, EN quando
    # existir nome EN) — o matching filtra os metadados por ela; "" = nenhuma
    required_entity: str = ""


def _mock_brief(scene: Scene) -> VisualBrief:
    food = bool(_FOOD_PT.search(scene.text))
    monument = bool(_MONUMENT_PT.search(scene.text))
    if food and not monument:
        return VisualBrief(scene_id=scene.scene_id,
                           visual_subject_en="close-up of traditional portuguese food dish",
                           must_have=["food"], must_not=["landmark"],
                           shot_type_pref="close-up")
    if monument and not food:
        return VisualBrief(scene_id=scene.scene_id,
                           visual_subject_en="wide shot of historic portuguese monument",
                           must_have=["landmark"], must_not=["food"],
                           shot_type_pref="wide")
    return VisualBrief(scene_id=scene.scene_id,
                       visual_subject_en="cinematic street scene in lisbon portugal")


def build_briefs(scenes: list[Scene], settings: Settings) -> tuple[list[VisualBrief], float]:
    if settings.mock_mode:
        return [_mock_brief(s) for s in scenes], 0.0

    scenes_txt = "\n".join(f'- {s.scene_id} [{s.beat}]: "{s.text}"' for s in scenes)
    raw = (settings.prompts_root / "vision" / "visual_brief.v1.md").read_text("utf-8")
    prompt = raw.replace("{scenes}", scenes_txt)

    data, cost, last_err = None, 0.0, None
    for temperature in (0.3, 0.0):  # retry único a temp 0 se o JSON vier partido
        text, step_cost = generate(prompt, settings, model=settings.model_flash,
                                   json_mode=True, temperature=temperature,
                                   tag="matching_briefs")
        cost += step_cost
        m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
        try:
            data = json.loads((m.group(1) if m else text).strip())
            break
        except json.JSONDecodeError as exc:
            last_err = exc
            log.warning("briefs JSON inválido (temp=%s): %s", temperature, exc)
    if data is None:
        # fail-closed: sem briefs válidos, todas as cenas caem na heurística mock
        log.warning("briefs JSON inválido após retry (%s) — a usar heurística mock", last_err)
        return [_mock_brief(s) for s in scenes], cost

    briefs = {b["scene_id"]: VisualBrief.model_validate(b) for b in data}
    # fail-closed: cena sem brief → heurística mock como rede de segurança nomeada
    out = [briefs.get(s.scene_id) or _mock_brief(s) for s in scenes]
    return out, cost
