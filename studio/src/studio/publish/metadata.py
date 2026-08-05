"""Metadata YouTube: título/descrição/tags via Flash; capítulos
determinísticos a partir das cenas (mudança de beat = capítulo).
Atribuições CC agregadas da timeline entram na descrição (LIBRARY_POLICY §4)."""

from __future__ import annotations

import json
import re

from studio.config import Settings
from studio.llm.gemini import generate


def _chapters(scenes: list[dict]) -> list[tuple[float, str]]:
    out, prev = [], None
    for s in scenes:
        if s["beat"] != prev:
            out.append((s["t_in"], s["beat"]))
            prev = s["beat"]
    return out


def _fmt_ts(t: float) -> str:
    return f"{int(t // 60):d}:{int(t % 60):02d}"


def build_metadata(script: str, scenes: list[dict], topic: str,
                   attributions: list[str], settings: Settings) -> tuple[dict, float]:
    chapters = _chapters(scenes)
    if settings.mock_mode:
        meta = {"title": f"{topic} — o segredo que ninguém conta"[:95],
                "description": "Descrição mock.",
                "tags": ["lisboa", "viagem", "gastronomia"],
                "chapter_titles": [b for _, b in chapters]}
        cost = 0.0
    else:
        prompt = (
            "És especialista em SEO de YouTube (nicho viagens PT-BR). Com base "
            f"nesta narração, gera JSON com: title (≤95 chars, curiosidade sem "
            f"clickbait barato), description (2 parágrafos + convite a comentar), "
            f"tags (12-20), chapter_titles (array com {len(chapters)} títulos "
            f"curtos, ordem dos capítulos: "
            f"{[b for _, b in chapters]}).\nJSON puro.\n---\n{script}"
        )
        text, cost = generate(prompt, settings, model=settings.model_flash,
                              json_mode=True, temperature=0.5)
        m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
        meta = json.loads((m.group(1) if m else text).strip())

    titles = meta.get("chapter_titles") or [b for _, b in chapters]
    chapter_lines = [f"{_fmt_ts(t)} {titles[i] if i < len(titles) else beat}"
                     for i, (t, beat) in enumerate(chapters)]
    # YouTube exige 1º capítulo em 0:00
    if chapter_lines and not chapter_lines[0].startswith("0:00"):
        chapter_lines[0] = "0:00 " + chapter_lines[0].split(" ", 1)[1]

    description = meta["description"]
    if chapter_lines:
        description += "\n\nCapítulos:\n" + "\n".join(chapter_lines)
    if attributions:
        description += "\n\nFootage:\n" + "\n".join(sorted(set(attributions)))

    return {"title": meta["title"], "description": description,
            "tags": meta.get("tags", []), "chapters": chapter_lines}, cost
