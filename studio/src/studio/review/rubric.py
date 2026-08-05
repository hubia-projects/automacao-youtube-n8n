"""Rubrica do revisor — output estruturado (ARCHITECTURE §5.3).

Vocabulário FECHADO de fixes: nada fora dele é executado (ADR-0005).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

FixAction = Literal["replace_shot", "trim", "reorder", "change_transition", "extend_broll"]


class SceneReview(BaseModel):
    scene_id: str
    visual_match: int = 5
    continuity: int = 5
    pacing: int = 5
    issues: list[str] = Field(default_factory=list)


class GlobalReview(BaseModel):
    narrative_flow: int = 5
    repetition: int = 5
    audio_sync: int = 5
    overall: int = 0


class Fix(BaseModel):
    scene_id: str
    action: FixAction
    reason: str = ""
    brief_override: dict | None = None


class ReviewReport(BaseModel):
    per_scene: list[SceneReview] = Field(default_factory=list)
    global_: GlobalReview = Field(default_factory=GlobalReview, alias="global")
    fixes: list[Fix] = Field(default_factory=list)

    model_config = {"populate_by_name": True}

    @property
    def overall(self) -> int:
        return self.global_.overall
