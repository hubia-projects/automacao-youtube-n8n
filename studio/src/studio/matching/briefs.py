"""Briefs visuais por cena — SEMPRE em inglês (ADR-0003).

Fase B: o `required_entity` deixa de ser decidido pelo Gemini. Vem
DETERMINÍSTICAMENTE de Scene.primary_entity (calculado pelo segment_scenes
entity-aware). Gemini só preenche os campos auxiliares (visual_subject_en,
mood, shot_type_pref, must_have, must_not).

O brief continua sendo a query da busca cross-modal + filtros duros.
Mock: heurística determinística por palavras PT, mas ANCORADA em
Scene.primary_entity quando disponível (uma cena mencionando "Francesinha"
NÃO pode virar fallback para "comida tradicional portuguesa").
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
                          r"catedral|muralha|livraria|ponte)\b", re.I)


class VisualBrief(BaseModel):
    scene_id: str
    visual_subject_en: str
    must_have: list[str] = Field(default_factory=list)
    must_not: list[str] = Field(default_factory=list)
    shot_type_pref: str = "medium"
    mood: str = ""
    # entidade própria que a narração NOMEIA — anchor determinístico.
    # "" = nenhuma. Preenchido a partir de Scene.primary_entity.
    required_entity: str = ""
    # Fase B — campos novos do anchor (defaults preservam wiring legacy)
    required_entity_type: str = ""             # food|landmark|place|building|...
    required_entity_aliases: list[str] = Field(default_factory=list)
    strict_entity: bool = False                 # True ⇒ matching é fail-closed
    entity_importance: float = 0.0
    location_context: str = ""                  # cidade/região (Porto/Lisboa/...)
    # search_queries (Fase D) — baseline obrigatório + variantes opcionais.
    # Preenchido pelo matching a partir do query_builder; aqui fica [] por default
    # (Gemini pode adicionar variantes em visual_subject_en como `extra`,
    # mas o anchor determinístico é responsável pelas queries principais).
    search_queries: list[str] = Field(default_factory=list)


def _scene_anchor(scene: Scene) -> dict:
    """Extrai os campos de anchor da Scene. Inalterado se scene.primary_entity
    for vazio (cena sem entity explícita → campo AS anchor procedia)."""
    return {
        "required_entity": scene.primary_entity,
        "required_entity_type": scene.primary_entity_type,
        "required_entity_aliases": list(scene.entity_aliases),
        "strict_entity": scene.strict_entity,
        "entity_importance": scene.entity_importance,
        "location_context": scene.location_context,
    }


def _mock_brief(scene: Scene) -> VisualBrief:
    """Mock determinístico: âncora PRIMEIRO (Scene.primary_entity), depois
    campos auxiliares por regras PT-PT.

    IMPORTANTE Fase B: cenas com primary_entity têm aquele nome instalado
    no anchor, NÃO um genérico compatível com SigLIP. Isso quebra a causa
    nº1 do score baixo (run 20260714-102323)."""
    anchor = _scene_anchor(scene)

    # Cena com entity explícita: anchor determinístico + auxiliares coerentes
    if anchor["required_entity"]:
        et = anchor["required_entity_type"] or "other_visual"
        mood = "referência cultural" if et == "landmark" else \
               "gastronomia local" if et == "food" else "ambiente local"
        # must_have inclui o TIPO (food|landmark) para SigLIP rerank, mas
        # O FILTRO entity-aware no search.py precisa do TIPO + ENTITY nos
        # metadados do shot (places_csv / landmarks_csv / food_csv).
        must_have = [et]
        must_not = ["people"] if et == "landmark" else []
        return VisualBrief(
            scene_id=scene.scene_id,
            visual_subject_en=f"close-up cinematic shot of {anchor['required_entity']} "
                              f"in Porto Portugal",
            must_have=must_have, must_not=must_not,
            shot_type_pref="close-up" if et in ("food", "landmark") else "medium",
            mood=mood,
            required_entity=anchor["required_entity"],
            required_entity_type=et,
            required_entity_aliases=anchor["required_entity_aliases"],
            strict_entity=anchor["strict_entity"],
            entity_importance=anchor["entity_importance"],
            location_context=anchor["location_context"],
        )

    # Cena SEM entity explícita (genérico B-roll): heurística antiga
    text = scene.text
    food = bool(_FOOD_PT.search(text))
    monument = bool(_MONUMENT_PT.search(text))
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
                       visual_subject_en="cinematic street scene in Porto portugal")


def build_briefs(scenes: list[Scene], settings: Settings) -> tuple[list[VisualBrief], float]:
    if settings.mock_mode:
        # Mock: âncora da cena é RESPEITADA, mas Gemini mock não precisa correr.
        return [_mock_brief(s) for s in scenes], 0.0

    # Real Gemini: passamos a cena COM anchor (para o prompt) mas pedimos
    # APENAS campos auxiliares. O anchor é depois fundido por código.
    # cena block inclui anchor para contexto, mas requested schema NÃO
    # o tem → Gemini não pode inventar/sobrescrever.
    scene_lines = []
    for s in scenes:
        anchor = _scene_anchor(s)
        anchor_repr = (
            f"anchor={{entity='{anchor['required_entity']}', "
            f"type='{anchor['required_entity_type']}', "
            f"strict={anchor['strict_entity']}, "
            f"importance={anchor['entity_importance']:.2f}}}"
            if anchor["required_entity"] else "anchor={}"
        )
        scene_lines.append(
            f"- {s.scene_id} [{s.beat}] {anchor_repr}: \"{s.text}\""
        )
    scenes_txt = "\n".join(scene_lines)
    raw = (settings.prompts_root / "vision" / "visual_brief.v1.md").read_text("utf-8")
    prompt = raw.replace("{scenes}", scenes_txt)

    data, cost, last_err = None, 0.0, None
    for temperature in (0.3, 0.0):
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
        log.warning("briefs JSON inválido após retry (%s) — a usar heurística mock", last_err)
        return [_mock_brief(s) for s in scenes], cost

    # Gemini devolve JSON por scene_id com APENAS campos auxiliares. Os
    # anchor fields ficam FIXOS (vindos da Scene, não de Gemini).
    errs = []
    by_id = {}
    for b in data.get("briefs", data) if isinstance(data, dict) else []:
        if not isinstance(b, dict):
            continue
        sid = b.get("scene_id") or b.get("id")
        if not sid:
            continue
        try:
            by_id[sid] = {
                "visual_subject_en": b.get("visual_subject_en",
                                            "cinematic street scene in Porto portugal"),
                "must_have": b.get("must_have", []) or [],
                "must_not": b.get("must_not", []) or [],
                "shot_type_pref": b.get("shot_type_pref", "medium"),
                "mood": b.get("mood", ""),
            }
        except Exception as exc:
            errs.append(f"{sid}: {exc}")
    if errs:
        log.warning("briefs: %d Gemini responses com shape inválido — resto usa mock", len(errs))

    out: list[VisualBrief] = []
    for s in scenes:
        anchor = _scene_anchor(s)
        aux = by_id.get(s.scene_id)
        if aux is None:
            # cena sem resposta válida: heurística mock (anchor preservado)
            out.append(_mock_brief(s))
            continue
        out.append(VisualBrief(
            scene_id=s.scene_id,
            visual_subject_en=aux["visual_subject_en"],
            must_have=aux["must_have"], must_not=aux["must_not"],
            shot_type_pref=aux["shot_type_pref"], mood=aux["mood"],
            required_entity=anchor["required_entity"],
            required_entity_type=anchor["required_entity_type"],
            required_entity_aliases=anchor["required_entity_aliases"],
            strict_entity=anchor["strict_entity"],
            entity_importance=anchor["entity_importance"],
            location_context=anchor["location_context"],
        ))
    return out, cost
