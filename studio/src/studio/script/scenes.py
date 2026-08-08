"""Segmentação de cenas — Fase B: entity-aware (ARCHITECTURE §1.7 + Fase B).

Frases (do roteiro) → alinhadas aos word timestamps → agrupadas em cenas de
5-18 s preferindo fronteiras com pausa real. Mudança de entity strict
*TAMBÉM* fecha cena mesmo sem pausa (regra nova Fase B). Beat narrativo
por cena (herdado do outline por posição).

NOVO (Fase B):
- Scene recebe 6 campos entity (primary_entity, primary_entity_type,
  entity_aliases, entity_importance, strict_entity, location_context) —
  todos com defaults retro-compatíveis.
- segment_scenes() aceita `entity_spans: list[EntitySpan]` (opcional). Para
  cada sentence-group, calcula a entity dominante (overlap temporal com
  EntitySpan × importância). Mudança entre duas entities strict fecha
  cena mesmo sem pausa suficiente (mantém MIN_SCENE_S/2 para evitar
  over-splitting).
"""

from __future__ import annotations

import re
from typing import Iterable

from pydantic import BaseModel, Field

from studio.script.entities import EntitySpan
from studio.script.writer import Outline

MIN_SCENE_S = 5.0
MAX_SCENE_S = 18.0
PAUSE_GAP_S = 0.35  # gap entre palavras que conta como pausa de respiração
# Fase B: limiar mínimo relaxado para cenas entity-aware poderem ser curtas
# quando há troca de entity strict sem pausa.
MIN_SCENE_S_RELAXED = 2.5


class Scene(BaseModel):
    scene_id: str
    t_in: float
    t_out: float
    text: str
    beat: str = "detail"
    # Fase B — campos entity (defaults garantem retro-compat com testes
    # existentes que constroem Scene(scene_id, t_in, t_out, text, beat=...)).
    primary_entity: str = ""
    primary_entity_type: str = ""
    entity_aliases: list[str] = Field(default_factory=list)
    entity_importance: float = 0.0
    strict_entity: bool = False
    location_context: str = ""


def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?…])\s+", text.strip()) if s]


def _norm(w: str) -> str:
    return re.sub(r"[^\wáàâãéêíóôõúç]", "", w.lower())


def _align_sentences(sentences: list[str], words: list[dict]) -> list[tuple[float, float, str]]:
    """Consome a lista de words sequencialmente, frase a frase."""
    out, idx = [], 0
    for sent in sentences:
        n = len(sent.split())
        if idx >= len(words):
            break
        chunk = words[idx: idx + n]
        # reancorar levemente: se a 1ª palavra não bate, procurar perto
        if chunk and _norm(chunk[0]["word"]) != _norm(sent.split()[0]):
            for j in range(max(0, idx - 3), min(len(words), idx + 4)):
                if _norm(words[j]["word"]) == _norm(sent.split()[0]):
                    idx = j
                    chunk = words[idx: idx + n]
                    break
        if not chunk:
            break
        out.append((chunk[0]["start"], chunk[-1]["end"], sent))
        idx += n
    return out


def _beat_for_position(pos: float, outline: Outline | None) -> str:
    if outline and outline.chapters:
        total = sum(c.target_seconds for c in outline.chapters) or 1
        acc = 0.0
        for ch in outline.chapters:
            acc += ch.target_seconds / total
            if pos <= acc:
                return ch.beat
        return outline.chapters[-1].beat
    return "hook" if pos < 0.08 else ("payoff" if pos > 0.9 else "detail")


def _dominant_entity(t_start: float, t_end: float,
                     entity_spans: Iterable[EntitySpan]) -> EntitySpan | None:
    """Para um intervalo [t_start, t_end] em segundos, devolve a EntitySpan
    com maior overlap em duração (segundos). Em empate, importance mais
    alta; em empate, a mais antiga (t_in menor). None se nada overlap."""
    if not entity_spans:
        return None
    best: EntitySpan | None = None
    best_overlap = 0.0
    for span in entity_spans:
        lo = max(span.t_in, t_start)
        hi = min(span.t_out, t_end)
        if hi <= lo:
            continue
        overlap = hi - lo
        # Critério: overlap > best OU (overlap == best E importance >).
        # Mesma overlap+importance → mantém o primeiro por estabilidade.
        if (overlap > best_overlap
            or (overlap == best_overlap
                and best is not None
                and span.importance > best.importance)):
            best_overlap = overlap
            best = span
    return best


def segment_scenes(script_text: str, words: list[dict],
                   outline: Outline | None = None,
                   entity_spans: list[EntitySpan] | None = None
                   ) -> list[Scene]:
    """Aceita entity_spans opcional. Sem entity_spans ⇒ comportamento
    legacy (só duração + pausas)."""
    sentences = _sentences(script_text)
    aligned = _align_sentences(sentences, words)
    if not aligned:
        return []
    total_end = aligned[-1][1] or 1.0
    spans = entity_spans or []

    groups: list[tuple[float, float, list[str], EntitySpan | None]] = []
    cur_start, cur_end, cur_texts = aligned[0][0], aligned[0][1], [aligned[0][2]]
    cur_entity = _dominant_entity(cur_start, cur_end, spans)
    for i in range(1, len(aligned)):
        s_start, s_end, s_text = aligned[i]
        s_entity = _dominant_entity(s_start, s_end, spans)
        gap = s_start - cur_end
        duration = cur_end - cur_start
        # close (duração ou pausa):
        close_by_dur = (duration >= MIN_SCENE_S
                        and gap >= PAUSE_GAP_S) or (s_end - cur_start > MAX_SCENE_S)
        # Fase B: close por troca de entity strict (mesmo sem pausa)
        close_by_entity = (
            duration >= MIN_SCENE_S_RELAXED
            and cur_entity is not None
            and s_entity is not None
            and cur_entity.strict_visual
            and s_entity.strict_visual
            and cur_entity.canonical_name.strip().lower()
                != s_entity.canonical_name.strip().lower()
        )
        if close_by_dur or close_by_entity:
            groups.append((cur_start, cur_end, cur_texts, cur_entity))
            cur_start, cur_end, cur_texts = s_start, s_end, [s_text]
            cur_entity = s_entity
        else:
            cur_end, cur_texts = s_end, cur_texts + [s_text]
            # entity pode fundir-se: se a nova frase tem entity strict e a
            # anterior não tinha → re-estima a entity do group corrente
            if cur_entity is None and s_entity is not None and s_entity.strict_visual:
                cur_entity = s_entity
    groups.append((cur_start, cur_end, cur_texts, cur_entity))

    scenes: list[Scene] = []
    for i, (g_start, g_end, texts, ent) in enumerate(groups):
        if i == 0:
            pos = 0.0
        elif i == len(groups) - 1:
            pos = 1.0
        else:
            pos = (g_start + g_end) / 2 / total_end
        scenes.append(Scene(
            scene_id=f"s{i:03d}", t_in=round(g_start, 3), t_out=round(g_end, 3),
            text=" ".join(texts), beat=_beat_for_position(pos, outline),
            primary_entity=ent.canonical_name if ent else "",
            primary_entity_type=ent.entity_type if ent else "",
            entity_aliases=list(ent.aliases) if ent else [],
            entity_importance=ent.importance if ent else 0.0,
            strict_entity=ent.strict_visual if ent else False,
            location_context=ent.location_context if ent else "",
        ))
    return scenes
