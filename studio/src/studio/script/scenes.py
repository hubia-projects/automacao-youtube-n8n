"""Segmentação de cenas — por significado, não por frase (ARCHITECTURE §1.7).

Frases (do roteiro) → alinhadas aos word timestamps → agrupadas em cenas de
5-18 s preferindo fronteiras com pausa real → beat narrativo por cena
(herdado do outline por posição; refinável por LLM na Fase 4).
"""

from __future__ import annotations

import re

from pydantic import BaseModel

from studio.script.writer import Outline

MIN_SCENE_S = 5.0
MAX_SCENE_S = 18.0
PAUSE_GAP_S = 0.35  # gap entre palavras que conta como pausa de respiração


class Scene(BaseModel):
    scene_id: str
    t_in: float
    t_out: float
    text: str
    beat: str = "detail"


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
        # posição normalizada → capítulo correspondente (por tempo alvo)
        total = sum(c.target_seconds for c in outline.chapters) or 1
        acc = 0.0
        for ch in outline.chapters:
            acc += ch.target_seconds / total
            if pos <= acc:
                return ch.beat
        return outline.chapters[-1].beat
    return "hook" if pos < 0.08 else ("payoff" if pos > 0.9 else "detail")


def segment_scenes(script_text: str, words: list[dict],
                   outline: Outline | None = None) -> list[Scene]:
    sentences = _sentences(script_text)
    aligned = _align_sentences(sentences, words)
    if not aligned:
        return []
    total_end = aligned[-1][1] or 1.0

    groups: list[tuple[float, float, list[str]]] = []
    cur_start, cur_end, cur_texts = aligned[0][0], aligned[0][1], [aligned[0][2]]
    for i in range(1, len(aligned)):
        s_start, s_end, s_text = aligned[i]
        gap = s_start - cur_end
        duration = cur_end - cur_start
        # fechar cena: já longa o suficiente E há pausa real, ou estouraria o máx
        close = (duration >= MIN_SCENE_S and gap >= PAUSE_GAP_S) or \
                (s_end - cur_start > MAX_SCENE_S)
        if close:
            groups.append((cur_start, cur_end, cur_texts))
            cur_start, cur_end, cur_texts = s_start, s_end, [s_text]
        else:
            cur_end, cur_texts = s_end, cur_texts + [s_text]
    groups.append((cur_start, cur_end, cur_texts))

    scenes: list[Scene] = []
    for i, (g_start, g_end, texts) in enumerate(groups):
        # regra editorial: 1ª cena herda o beat de abertura (hook), a última o
        # de fecho (payoff/cta); intermédias mapeiam pelo ponto médio
        if i == 0:
            pos = 0.0
        elif i == len(groups) - 1:
            pos = 1.0
        else:
            pos = (g_start + g_end) / 2 / total_end
        scenes.append(Scene(
            scene_id=f"s{i:03d}", t_in=round(g_start, 3), t_out=round(g_end, 3),
            text=" ".join(texts), beat=_beat_for_position(pos, outline),
        ))
    return scenes
