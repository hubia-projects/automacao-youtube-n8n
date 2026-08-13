"""Estado do run — run.json (ver ARCHITECTURE.md §5.1).

Escrita sempre atómica (tmp + rename). Este ficheiro é a única fonte de
verdade sobre o progresso de um vídeo; artefactos vivem nos diretórios
de cada stage.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, Field

SCHEMA_VERSION = "1.0"


class StageRecord(BaseModel):
    status: str = "pending"
    attempts: int = 0
    started_at: str | None = None
    finished_at: str | None = None
    cost_usd: float = 0.0
    error: str | None = None
    outputs: list[str] = Field(default_factory=list)


class CostLedger(BaseModel):
    total_usd: float = 0.0
    by_stage: dict[str, float] = Field(default_factory=dict)
    budget_usd: float = 15.0


class RunState(BaseModel):
    schema_version: str = SCHEMA_VERSION
    video_id: str
    topic: str = ""
    created_at: str = ""
    params: dict = Field(default_factory=dict)  # persistem para o resume
    stages: dict[str, StageRecord] = Field(default_factory=dict)
    gates: dict[str, str | None] = Field(default_factory=dict)
    cost_ledger: CostLedger = Field(default_factory=CostLedger)
    policies: list[str] = Field(default_factory=list)

    def stage(self, name: str) -> StageRecord:
        if name not in self.stages:
            self.stages[name] = StageRecord()
        return self.stages[name]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_state(video_id: str, topic: str, budget_usd: float,
              params: dict | None = None) -> RunState:
    state = RunState(video_id=video_id, topic=topic, created_at=_now(),
                     params=params or {})
    state.cost_ledger.budget_usd = budget_usd
    return state


def state_path(run_dir: Path) -> Path:
    return run_dir / "run.json"


def save_state(state: RunState, run_dir: Path) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    target = state_path(run_dir)
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(state.model_dump_json(indent=2), encoding="utf-8")
    os.replace(tmp, target)  # atómico no mesmo filesystem


def load_state(run_dir: Path) -> RunState:
    raw = state_path(run_dir).read_text(encoding="utf-8")
    return RunState.model_validate(json.loads(raw))


def set_gate_decision(run_dir: Path, gate: str, decision: str) -> RunState:
    """Item 2.3/32 (automation closure): lógica partilhada CLI+frontend
    para registar uma decisão de gate. `cli.py::cmd_approve` e o endpoint
    HTTP `POST /api/runs/<id>/approve` (monitor_server.py) chamam esta
    MESMA função — zero lógica de negócio duplicada entre os dois
    (item 22/41: frontend nunca decide nada, só invoca o mesmo caminho).
    """
    state = load_state(run_dir)
    state.gates[gate] = decision
    save_state(state, run_dir)
    return state


def touch_stage_start(state: RunState, name: str) -> None:
    rec = state.stage(name)
    rec.status = "running"
    rec.attempts += 1
    rec.started_at = _now()


def touch_stage_end(state: RunState, name: str, status: str, *, cost_usd: float = 0.0,
                    outputs: list[str] | None = None, error: str | None = None) -> None:
    rec = state.stage(name)
    rec.status = status
    rec.finished_at = _now()
    rec.cost_usd += cost_usd
    rec.error = error
    if outputs is not None:
        rec.outputs = outputs
    state.cost_ledger.total_usd += cost_usd
    state.cost_ledger.by_stage[name] = state.cost_ledger.by_stage.get(name, 0.0) + cost_usd
