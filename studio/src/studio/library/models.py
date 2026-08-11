"""Phase 1 — Modelos de domínio da biblioteca (Task: preparation-before-bulk-search).

Reune os modelos partilhados entre:
- ingest pipeline (state machine por media_sha);
- coverage planning (VisualRequirement + CoverageState);
- workset + reconcile (selecção e reporting).

Não tem efeitos colaterais — apenas defines dataclasses/enums + BaseModels
com validação. Side-effects (DB, ficheiros) vivem em ingest / workset /
reconcile / db.

DOC: 20-principles library plan §P3 P6 P2.
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field

log = logging.getLogger("studio.library.models")

# Repos-aware root (igual a dedup.py / buckets.py / reconcile.py — evita
# CWD-relative bugs quando chamado via `uv run --directory studio`).
_REPO_ROOT_MODELS = Path(__file__).resolve().parents[4]
DATA_ROOT = _REPO_ROOT_MODELS / "data" / "library"
STATES_ROOT = DATA_ROOT / "states"


# ============================================================
# P6 — AssetState (state machine REAL por media_sha)
# ============================================================
class AssetState(str, Enum):
    """Ciclo de vida de UM asset (ficheiro de media) na biblioteca.

    Transições válidas (linear happy-path):
        DISCOVERED → DOWNLOAD_PENDING → DOWNLOADED → VALIDATED →
        INGESTING → SCENE_DETECTED → EMBEDDED → METADATA_ANALYZED →
        REGISTERED → VERIFIED → DONE

    Saídas alternativas (erro):
        INGESTING/REGISTERED → FAILED_RETRYABLE (transient: 429, network)
        INGESTING/REGISTERED → FAILED_PERMANENT (invalid: codec, license)

    DONE é exclusivo: só através de VERIFIED→DONE. Nunca setar DONE sem
    get_shot() readback confirmar a row no LanceDB.
    """
    DISCOVERED = "DISCOVERED"
    DOWNLOAD_PENDING = "DOWNLOAD_PENDING"
    DOWNLOADED = "DOWNLOADED"
    VALIDATED = "VALIDATED"
    INGESTING = "INGESTING"
    SCENE_DETECTED = "SCENE_DETECTED"
    EMBEDDED = "EMBEDDED"
    METADATA_ANALYZED = "METADATA_ANALYZED"
    REGISTERED = "REGISTERED"
    VERIFIED = "VERIFIED"
    DONE = "DONE"
    FAILED_RETRYABLE = "FAILED_RETRYABLE"
    FAILED_PERMANENT = "FAILED_PERMANENT"


# Transições válidas — usado em testes para garantir que o caller não pula
# estados. Não é exaustivo (cobre happy-path + 2 saídas de erro principais).
VALID_TRANSITIONS: set[tuple[AssetState, AssetState]] = {
    (AssetState.DISCOVERED, AssetState.DOWNLOAD_PENDING),
    (AssetState.DOWNLOAD_PENDING, AssetState.DOWNLOADED),
    (AssetState.DOWNLOADED, AssetState.VALIDATED),
    (AssetState.VALIDATED, AssetState.INGESTING),
    (AssetState.INGESTING, AssetState.SCENE_DETECTED),
    (AssetState.SCENE_DETECTED, AssetState.EMBEDDED),
    (AssetState.EMBEDDED, AssetState.METADATA_ANALYZED),
    (AssetState.METADATA_ANALYZED, AssetState.REGISTERED),
    (AssetState.REGISTERED, AssetState.VERIFIED),
    (AssetState.VERIFIED, AssetState.DONE),
    # Failure exits
    (AssetState.INGESTING, AssetState.FAILED_RETRYABLE),
    (AssetState.INGESTING, AssetState.FAILED_PERMANENT),
    (AssetState.REGISTERED, AssetState.FAILED_RETRYABLE),
    (AssetState.REGISTERED, AssetState.FAILED_PERMANENT),
    # Retry from FAILED_RETRYABLE → INGESTING
    (AssetState.FAILED_RETRYABLE, AssetState.INGESTING),
}


# ============================================================
# P2 — CoverageState (analytic state por VisualRequirement)
# ============================================================
class CoverageState(str, Enum):
    """Estado analítico de um VisualRequirement (não confundir com AssetState).

    NOT_FOUND    — entity nunca apareceu em coverage scan
    PARTIAL      — available_seconds < required_seconds (deficit > 0)
    COVERED      — available_seconds >= required_seconds E < target_seconds
    OVER_COVERED — available_seconds >= target_seconds (parar de buscar)
    """
    NOT_FOUND = "NOT_FOUND"
    PARTIAL = "PARTIAL"
    COVERED = "COVERED"
    OVER_COVERED = "OVER_COVERED"


# ============================================================
# P3 — VisualRequirement (BaseModel)
# ============================================================
class VisualRequirement(BaseModel):
    """Requisito visual extraído do script para um vídeo.

    Consumido por:
    - topup.py (vê deficit_seconds para decidir se busca);
    - coverage_plan.py (calcula o ranking de entities deficitárias);
    - workset.py (selected_shots.json: shots que suprem este requisito).
    """
    requirement_id: str
    canonical_entity: str
    entity_type: str = "landmark"   # landmark | food | place | scene
    aliases: list[str] = Field(default_factory=list)
    location: Optional[str] = None  # cidade/região ("Porto")

    narration_t_in: float = 0.0
    narration_t_out: float = 0.0
    narration_seconds: float = 0.0
    importance: float = 1.0
    strict: bool = True              # True ⇒ entity visual obrigatória

    desired_shots: int = 3           # nº mínimo de shots distintos
    required_seconds: float = 15.0   # minimo para vídeo não parecer gap
    target_seconds: float = 25.0     # optimal — STOP quando atinge

    # Mutable (atualizado por coverage recalc)
    available_seconds: float = 0.0
    deficit_seconds: float = 0.0
    matched_shot_ids: list[str] = Field(default_factory=list)
    status: CoverageState = CoverageState.NOT_FOUND

    def update_coverage(self, available: float) -> None:
        """Recalcula status/deficit_seconds quando nova medição chega."""
        self.available_seconds = round(available, 3)
        self.deficit_seconds = round(
            max(0.0, self.required_seconds - self.available_seconds), 3
        )
        if self.available_seconds == 0:
            self.status = CoverageState.NOT_FOUND
        elif self.available_seconds < self.required_seconds:
            self.status = CoverageState.PARTIAL
        elif self.available_seconds < self.target_seconds:
            self.status = CoverageState.COVERED
        else:
            self.status = CoverageState.OVER_COVERED


# ============================================================
# P6 — AssetStateRecord (sidecar JSON por media_sha)
# ============================================================
class AssetStateRecord(BaseModel):
    """Estado persistido (sidecar JSON em data/library/states/<sha>.json).

    Vantagens vs campo LanceDB:
    - write por-asset sem retry/transaction overhead (.add() batch em LanceDB
      pode causar contention com outros writers concorrentes);
    - permance em disco mesmo se LanceDB corromper;
    - facilmente audível por humanos (cat JSON).
    """
    media_sha: str
    source_path: str
    state: AssetState
    attempts: int = 0
    last_error: str = ""
    last_successful_step: Optional[AssetState] = None
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    source_id: Optional[str] = None   # pexels_12345 etc.
    video_id: Optional[str] = None    # se ingest foi para um workset específico


class AssetStateStore:
    """Persistência atomic sidecar JSON por media_sha.

    Thread-safe (lock por media_sha). Migrar para column LanceDB se
    volume crescer >10k assets e I/O serial aqui virar gargalo.
    """

    def __init__(self, root: Path = STATES_ROOT) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _lock_for(self, sha: str) -> threading.Lock:
        with self._locks_guard:
            if sha not in self._locks:
                self._locks[sha] = threading.Lock()
            return self._locks[sha]

    def _path_for(self, sha: str) -> Path:
        return self.root / f"{sha}.json"

    def get(self, sha: str) -> Optional[AssetStateRecord]:
        p = self._path_for(sha)
        if not p.exists():
            return None
        try:
            return AssetStateRecord.model_validate_json(p.read_text())
        except Exception as exc:
            log.warning("AssetStateStore.get(%s) unreadable: %s", sha[:12], exc)
            return None

    def save(self, rec: AssetStateRecord, *,
             force_transition: bool = False) -> None:
        """Atomic save (tmp+rename). Se transição inválida e force_transition
        é False → raise ValueError. force_transition=True é para retry do
        caller (FAILED_RETRYABLE → INGESTING)."""
        with self._lock_for(rec.media_sha):
            current = self.get(rec.media_sha)
            if (current is not None
                    and not force_transition
                    and (current.state, rec.state) not in VALID_TRANSITIONS
                    and current.state != rec.state):
                raise ValueError(
                    f"AssetState transição inválida: "
                    f"{current.state.value} → {rec.state.value} "
                    f"(force_transition=True para retry)"
                )
            rec.updated_at = datetime.now(timezone.utc).isoformat()
            p = self._path_for(rec.media_sha)
            tmp = p.with_suffix(".tmp")
            tmp.write_text(
                rec.model_dump_json(ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            tmp.rename(p)

    def transition(self, sha: str, new_state: AssetState, *,
                   source_path: str = "", source_id: Optional[str] = None,
                   video_id: Optional[str] = None,
                   error: str = "",
                   force: bool = False) -> AssetStateRecord:
        """Conveniência: cria/atualiza record e transita."""
        cur = self.get(sha)
        if cur is None:
            cur = AssetStateRecord(
                media_sha=sha,
                source_path=source_path or "",
                state=AssetState.DISCOVERED,
                source_id=source_id,
                video_id=video_id,
            )
        if not error and cur.state in (AssetState.FAILED_RETRYABLE,
                                        AssetState.FAILED_PERMANENT):
            cur.attempts += 1
        cur.state = new_state
        cur.last_error = error or cur.last_error
        if new_state != AssetState.FAILED_RETRYABLE:
            # Sucesso parcial — regista o step mais à frente
            if (cur.last_successful_step is None
                    or new_state.value < cur.last_successful_step.value):
                cur.last_successful_step = new_state
        self.save(cur, force_transition=force)
        return cur


# ============================================================
# P5 — CoverageReport (para dashboard /api/library/coverage/<video_id>)
# ============================================================
class CoverageReport(BaseModel):
    """Snapshot de coverage para UM vídeo (video_id)."""
    video_id: str
    requirements: list[VisualRequirement] = Field(default_factory=list)
    overall_status: str = "computing"
    is_ready: bool = False
    overall_required_seconds: float = 0.0
    overall_available_seconds: float = 0.0
    overall_deficit_seconds: float = 0.0
    requirements_covered: int = 0
    requirements_partial: int = 0
    requirements_not_found: int = 0
    requirements_strict_uncovered: int = 0


__all__ = [
    "AssetState", "AssetStateRecord", "AssetStateStore",
    "CoverageState", "CoverageReport",
    "VisualRequirement", "VALID_TRANSITIONS",
    "DATA_ROOT", "STATES_ROOT",
]
