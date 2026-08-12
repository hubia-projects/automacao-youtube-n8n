"""ThemeSpec — contrato persistente do tema de um vídeo (item 2 do master task).

Substitui o par solto `topic`/`duration_minutes` por um contrato explícito
que inclui `mandatory_topics` (entidades que o roteiro TEM de citar — ver
`script/validate_topics.py`) e `optional_topics` (sugestões editoriais, não
obrigatórias). Mantém retrocompatibilidade: runs antigos sem `theme_spec`
em `params` continuam a funcionar via `ThemeSpec.from_params`.
"""
from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field


class ThemeSpec(BaseModel):
    theme: str
    target_duration_minutes: float = 12.0
    mandatory_topics: list[str] = Field(default_factory=list)
    optional_topics: list[str] = Field(default_factory=list)
    language: str = "pt-PT"
    location: str | None = None

    @classmethod
    def from_cli(
        cls,
        *,
        topic: str,
        duration_minutes: float,
        required_topics: list[str] | None = None,
        optional_topics: list[str] | None = None,
        language: str = "pt-PT",
        location: str | None = None,
    ) -> "ThemeSpec":
        return cls(
            theme=topic,
            target_duration_minutes=duration_minutes,
            mandatory_topics=list(required_topics or []),
            optional_topics=list(optional_topics or []),
            language=language,
            location=location,
        )

    @classmethod
    def from_brief_file(cls, path: Path) -> "ThemeSpec":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        # aceita tanto o nome "theme" como "topic" (alias comum em briefs manuais)
        if "theme" not in data and "topic" in data:
            data["theme"] = data.pop("topic")
        if "target_duration_minutes" not in data and "duration_minutes" in data:
            data["target_duration_minutes"] = data.pop("duration_minutes")
        return cls.model_validate(data)

    def to_params(self) -> dict:
        return self.model_dump()

    @classmethod
    def from_params(cls, params: dict) -> "ThemeSpec":
        """Reconstrói a partir de `RunState.params`.

        Retrocompatibilidade: runs criados antes deste contrato só têm
        `topic`/`duration_minutes` soltos em `params` — nesse caso não há
        `mandatory_topics`/`optional_topics` (listas vazias, comportamento
        idêntico ao anterior).
        """
        raw = params.get("theme_spec")
        if isinstance(raw, dict):
            return cls.model_validate(raw)
        return cls(
            theme=params.get("topic") or "",
            target_duration_minutes=float(params.get("duration_minutes", 12.0)),
        )
