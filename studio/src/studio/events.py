"""events.py — item 2.1 (automation closure): journal de eventos
estruturado, append-only, por run.

Requisito: «Anything operationally important visible in the terminal
must be visible in the frontend, in near real time.» Isto é o canal
partilhado — o terminal (logging normal) e o frontend (SSE, item 2.3)
consomem a MESMA fonte de eventos; nenhum é gerado só para um dos dois.

Persistido em `data/runs/<video_id>/events.jsonl`. `run.json`
(orchestrator/state.py) continua a ser a SSoT de estado do run; os
ficheiros do workset continuam a ser a SSoT de biblioteca/prontidão.
Eventos são AUDITORIA/OBSERVABILIDADE — nunca uma segunda fonte de
verdade para decisões de negócio.

`seq` monótono lido da ÚLTIMA linha do ficheiro ao abrir (não um contador
separado — duas fontes de verdade seriam piores que uma) — resume-safe
entre reinícios de processo. Limitação conhecida e aceite: se DOIS
processos escreverem no MESMO run concorrentemente (ex.: CLI + subprocess
de reconcile), pode haver uma colisão rara de `seq` — aceitável para um
canal de observabilidade, não para RunState (que já tem o seu próprio
lock em orchestrator/runner.py).
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field

from studio.logging_setup import redact_secrets

log = logging.getLogger("studio.events")


class RunEvent(BaseModel):
    seq: int
    timestamp: str
    video_id: str
    stage: str = ""
    event_type: str
    level: str = "INFO"
    message: str = ""
    progress: Optional[float] = None
    payload: dict[str, Any] = Field(default_factory=dict)


def _redact_payload(payload: dict) -> dict:
    """Redacta recursivamente qualquer string no payload — item 44
    (automation closure): nunca API keys/tokens em eventos."""
    out: dict[str, Any] = {}
    for k, v in payload.items():
        if isinstance(v, str):
            out[k] = redact_secrets(v)
        elif isinstance(v, dict):
            out[k] = _redact_payload(v)
        elif isinstance(v, list):
            out[k] = [redact_secrets(i) if isinstance(i, str) else i for i in v]
        else:
            out[k] = v
    return out


class EventJournal:
    """Append-only JSONL por run. 1 instância por `run_dir` (cacheada via
    `get_journal`) reusa o contador de `seq` entre chamadas `emit()` no
    mesmo processo sem reabrir/reler o ficheiro a cada evento."""

    def __init__(self, run_dir: Path, video_id: str):
        self.path = run_dir / "events.jsonl"
        self.video_id = video_id
        self._lock = threading.Lock()
        self._next_seq = self._read_last_seq() + 1

    def _read_last_seq(self) -> int:
        if not self.path.exists():
            return 0
        try:
            last_line = None
            with self.path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        last_line = line
            if last_line is None:
                return 0
            return int(json.loads(last_line).get("seq", 0))
        except (OSError, json.JSONDecodeError, ValueError):
            return 0

    def emit(
        self, stage: str, event_type: str, message: str = "", *,
        level: str = "INFO", progress: float | None = None,
        payload: dict | None = None,
    ) -> RunEvent:
        with self._lock:
            seq = self._next_seq
            self._next_seq += 1
            ev = RunEvent(
                seq=seq,
                timestamp=datetime.now(timezone.utc).isoformat(),
                video_id=self.video_id, stage=stage, event_type=event_type,
                level=level, message=redact_secrets(message or ""),
                progress=progress, payload=_redact_payload(payload or {}),
            )
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as f:
                    f.write(ev.model_dump_json() + "\n")
            except OSError as exc:
                # item 45 (performance/robustez): emitir eventos nunca pode
                # abortar o pipeline — fail-soft, log e continua.
                log.warning("EventJournal.emit: write falhou (não fatal): %s",
                            exc.__class__.__name__)
            return ev

    def read_from(self, after_seq: int = 0) -> list[RunEvent]:
        """Lê eventos com seq > after_seq — usado pelo snapshot inicial e
        pelo reconnect SSE (item 27: `after_seq`/`Last-Event-ID`)."""
        if not self.path.exists():
            return []
        out: list[RunEvent] = []
        try:
            with self.path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if int(row.get("seq", 0)) > after_seq:
                        try:
                            out.append(RunEvent.model_validate(row))
                        except Exception:
                            continue
        except OSError:
            pass
        return out


_journals: dict[str, EventJournal] = {}
_journals_guard = threading.Lock()


def get_journal(run_dir: Path, video_id: str) -> EventJournal:
    """1 EventJournal por `run_dir`, cacheado in-process."""
    key = str(run_dir)
    with _journals_guard:
        j = _journals.get(key)
        if j is None:
            j = EventJournal(run_dir, video_id)
            _journals[key] = j
        return j


def emit(
    run_dir: Path, video_id: str, stage: str, event_type: str,
    message: str = "", *, level: str = "INFO",
    progress: float | None = None, payload: dict | None = None,
) -> RunEvent:
    """Conveniência: emite sem gerir `EventJournal` explicitamente."""
    return get_journal(run_dir, video_id).emit(
        stage, event_type, message, level=level, progress=progress,
        payload=payload)


def reset_journal_cache() -> None:
    """Só para testes — limpa o cache in-process de EventJournal entre runs
    isoladas com o mesmo `run_dir` (tmp_path reusado)."""
    with _journals_guard:
        _journals.clear()
