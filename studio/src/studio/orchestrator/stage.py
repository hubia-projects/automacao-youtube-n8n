"""Contrato de Stage — ver ARCHITECTURE.md §3.

Regras:
- Comunicação entre stages só por ficheiros (nunca em memória).
- Um stage ou termina com todos os `outputs` existentes ou o run pára (fail-closed).
- Loops limitados vivem DENTRO de um stage composto, nunca no runner.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol, runtime_checkable

from pydantic import BaseModel

from studio.config import Settings

StageStatus = Literal["pending", "running", "done", "failed", "waiting_approval"]


class TokenUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0


class StageResult(BaseModel):
    status: Literal["done", "failed", "waiting_approval"]
    outputs: list[Path] = []
    cost_usd: float = 0.0
    tokens: TokenUsage | None = None
    notes: str = ""


@dataclass
class RunContext:
    video_id: str
    run_dir: Path
    settings: Settings
    # Parâmetros livres do run (topic, flags de gate, etc.)
    params: dict = field(default_factory=dict)
    # Estado partilhado do run — atribuído pelo runner. REGRA: só o runner
    # grava run.json; stages mutam ctx.state (ex.: gates) e nunca gravam.
    state: object | None = None

    def stage_dir(self, stage_name: str) -> Path:
        d = self.run_dir / stage_name
        d.mkdir(parents=True, exist_ok=True)
        return d


@runtime_checkable
class Stage(Protocol):
    name: str  # ex.: "08_matching" — prefixo numérico define a ordem no pipeline

    def run(self, ctx: RunContext) -> StageResult: ...
