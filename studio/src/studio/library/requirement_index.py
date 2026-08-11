"""requirement_index — relação persistente workset ↔ requirement ↔ shot.

Substitui o dicionário volátil `_confirmed_index` em reconcile state por
uma tabela persistente em LanceDB. reload-safe, query-first, sem dependência
de state.json efémero.

Schema:
    requirement_matches (LanceDB):
        workset_id:    str
        requirement_id: str
        shot_id:       str
        media_sha:     str
        similarity:    float          (cosine entre shot embedding e req embed)
        duration:      float          (segundos do shot — populado por measure_coverage)
        confirmation_status:
            NOT_REQUIRED | PENDING | CONFIRMED | REJECTED | FAILED_RETRYABLE
        confirmation_confidence: float (0..1)
        strict_eligible: bool          (True ⇔ strict_visual)
        evidence_json:   str           (lista serializada JSON; eg OCR + visual + metadata)
        updated_at:      str           (ISO timestamp)

    query_history (LanceDB):
        workset_id, requirement_id, provider, query_normalized
        attempt, results_count, result_provider_ids, status, created_at

Gate semântico (P3.1 — strict usa CONFIRMED-only):
    is_strict_covered(workset_id, requirement_id) ⇔
        strict_eligible=True + confirmation_status='CONFIRMED'
        + sum(duration) >= target_seconds
        + distinct_shots(shot_id) >= min_distinct_shots

API pública:
    RequirementIndex(db) : wrapper table-access
        upsert_match(...)
        list_for_requirement(workset_id, requirement_id) -> list[dict]
        list_for_workset(workset_id) -> list[dict]
        count_by_status(workset_id, status) -> int
        is_strict_covered(workset_id, requirement_id, target_s, min_shots) -> bool
    QueryHistory(db) : provider-level dedup window
        was_tried(workset_id, req_id, provider, query) -> bool
        record(workset_id, req_id, provider, query, results_count, ids, status)
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("studio.requirement_index")

# Confirmation status enum — espelha AssetState para outputs Gemíni status.
CS_NOT_REQUIRED = "NOT_REQUIRED"
CS_PENDING = "PENDING"
CS_CONFIRMED = "CONFIRMED"
CS_REJECTED = "REJECTED"
CS_FAILED_RETRYABLE = "FAILED_RETRYABLE"

ALL_CS = {CS_NOT_REQUIRED, CS_PENDING, CS_CONFIRMED, CS_REJECTED, CS_FAILED_RETRYABLE}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class RequirementMatch:
    workset_id: str
    requirement_id: str
    shot_id: str
    media_sha: str
    similarity: float
    duration: float
    confirmation_status: str
    confirmation_confidence: float
    strict_eligible: bool
    evidence: tuple[str, ...] = ()
    updated_at: str = ""

    def to_row(self) -> dict:
        return {
            "workset_id": self.workset_id,
            "requirement_id": self.requirement_id,
            "shot_id": self.shot_id,
            "media_sha": self.media_sha,
            "similarity": float(self.similarity),
            "duration": float(self.duration),
            "confirmation_status": self.confirmation_status,
            "confirmation_confidence": float(self.confirmation_confidence),
            "strict_eligible": bool(self.strict_eligible),
            "evidence_json": json.dumps(list(self.evidence), ensure_ascii=False),
            "updated_at": self.updated_at or _now_iso(),
        }

    @staticmethod
    def from_row(row: dict) -> "RequirementMatch":
        evidence_raw = row.get("evidence_json") or "[]"
        try:
            evidence = tuple(json.loads(evidence_raw))
        except (TypeError, json.JSONDecodeError):
            evidence = ()
        return RequirementMatch(
            workset_id=row.get("workset_id", ""),
            requirement_id=row.get("requirement_id", ""),
            shot_id=row.get("shot_id", ""),
            media_sha=row.get("media_sha", ""),
            similarity=float(row.get("similarity", 0.0) or 0.0),
            duration=float(row.get("duration", 0.0) or 0.0),
            confirmation_status=row.get("confirmation_status", CS_NOT_REQUIRED),
            confirmation_confidence=float(
                row.get("confirmation_confidence", 0.0) or 0.0),
            strict_eligible=bool(row.get("strict_eligible", False)),
            evidence=evidence,
            updated_at=row.get("updated_at", _now_iso()),
        )


@dataclass
class QueryHistoryEntry:
    workset_id: str
    requirement_id: str
    provider: str
    query_normalized: str
    attempt: int
    results_count: int
    result_provider_ids: tuple[str, ...]
    status: str                                # 'success' | 'empty' | 'error'
    created_at: str = ""

    def to_row(self) -> dict:
        return {
            "workset_id": self.workset_id,
            "requirement_id": self.requirement_id,
            "provider": self.provider,
            "query_normalized": self.query_normalized,
            "attempt": int(self.attempt),
            "results_count": int(self.results_count),
            "result_provider_ids": ",".join(self.result_provider_ids),
            "status": self.status,
            "created_at": self.created_at or _now_iso(),
        }


class RequirementIndex:
    """Persistente workset↔requirement↔shot relation.

    Usa LanceDB como backend (já existe no projeto); se LanceDB falhar,
    fallback para JSONL append-only em data/library/requirement_matches.jsonl.
    """

    TABLE = "requirement_matches"

    def __init__(self, db):
        # db é LibraryDB. Não forçamos abertura da tabela — fallback JSONL
        # cobre o caso "tabela ainda não existe" (criada on first upsert).
        self._db = db
        # P5 fix (code-reviewer): usar property pública `library_root` em vez
        # de tocar em `_library_root` directamente. Fallback `.root` legacy.
        root_path = getattr(db, "library_root", None) \
                    or getattr(db, "root", None)
        if root_path is None:
            log.warning(
                "RequirementIndex: db não tem 'library_root' nem 'root' — "
                "fallback JSONL desactivado. Use LibraryDB padrão.")
        self._fallback_path = (
            Path(root_path) / "requirement_matches.jsonl"
            if root_path is not None else None
        )

    def _table(self):
        # LanceDB table handle com fallback gracioso.
        try:
            return self._db._lance.open_table(self.TABLE)
        except Exception as exc:
            log.debug("RequirementIndex: LanceDB table %s indisponível: %s — "
                      "fallback JSONL em %s",
                      self.TABLE, exc.__class__.__name__, self._fallback_path)
            return None

    def upsert_match(self, match: RequirementMatch) -> bool:
        """Upsert (workset_id, requirement_id, shot_id) → row única."""
        row = match.to_row()
        tab = self._table()
        if tab is not None:
            try:
                # LanceDB merge_insert; sem unique compound key explícito
                # usamos update+insert via query-pattern (delete+add).
                self._delete_match(tab, match.workset_id, match.requirement_id,
                                   match.shot_id)
                tab.add([row])
                return True
            except Exception as exc:
                log.warning("RequirementIndex.upsert_match: LanceDB add "
                            "falhou (%s) — fallback JSONL", exc)
        # Fallback: JSONL append
        if self._fallback_path is not None:
            try:
                self._fallback_path.parent.mkdir(parents=True, exist_ok=True)
                with self._fallback_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
                return True
            except OSError as exc:
                log.warning("RequirementIndex.upsert_match: JSONL write "
                            "falhou (%s)", exc)
        return False

    def _delete_match(self, tab, workset_id: str, requirement_id: str,
                      shot_id: str) -> None:
        try:
            tab.delete(
                f"workset_id = '{workset_id}' AND "
                f"requirement_id = '{requirement_id}' AND "
                f"shot_id = '{shot_id}'")
        except Exception:
            # tabela vazia ou delete parcial é fine; add() sobrepõe.
            pass

    def list_for_requirement(self, workset_id: str, requirement_id: str
                             ) -> list[RequirementMatch]:
        tab = self._table()
        if tab is not None:
            try:
                rows = (tab.search()
                        .where(f"workset_id = '{workset_id}' AND "
                               f"requirement_id = '{requirement_id}'")
                        .to_list())
                return [RequirementMatch.from_row(r) for r in rows]
            except Exception as exc:
                log.debug(
                    "RequirementIndex.list_for_requirement: LanceDB select "
                    "falhou (%s) — JSONL fallback", exc)
        # JSONL fallback
        if self._fallback_path is None or not self._fallback_path.exists():
            return []
        out: list[RequirementMatch] = []
        try:
            with self._fallback_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    row = json.loads(line)
                    if (row.get("workset_id") == workset_id
                            and row.get("requirement_id") == requirement_id):
                        out.append(RequirementMatch.from_row(row))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("RequirementIndex.list_for_requirement: JSONL "
                        "leitura falhou (%s)", exc)
        return out

    def list_for_workset(self, workset_id: str) -> list[RequirementMatch]:
        tab = self._table()
        if tab is not None:
            try:
                rows = (tab.search()
                        .where(f"workset_id = '{workset_id}'")
                        .to_list())
                return [RequirementMatch.from_row(r) for r in rows]
            except Exception as exc:
                log.debug(
                    "RequirementIndex.list_for_workset: LanceDB select "
                    "falhou (%s) — JSONL fallback", exc)
        if self._fallback_path is None or not self._fallback_path.exists():
            return []
        out: list[RequirementMatch] = []
        try:
            with self._fallback_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    row = json.loads(line)
                    if row.get("workset_id") == workset_id:
                        out.append(RequirementMatch.from_row(row))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("RequirementIndex.list_for_workset: JSONL "
                        "leitura falhou (%s)", exc)
        return out

    def count_by_status(self, workset_id: str, status: str) -> int:
        return sum(1 for m in self.list_for_workset(workset_id)
                   if m.confirmation_status == status)

    def is_strict_covered(self, workset_id: str, requirement_id: str,
                          *, target_seconds: float,
                          min_distinct_shots: int) -> tuple[bool, float, int]:
        """Devolve (covered, total_seconds, distinct_shots) confirmados strict.

        Strict só conta shots com confirmation_status == CONFIRMED (não só
        candidate de SigLIP P3.1 §A).
        """
        matches = [
            m for m in self.list_for_requirement(workset_id, requirement_id)
            if m.strict_eligible and m.confirmation_status == CS_CONFIRMED
        ]
        total_seconds = sum(m.duration for m in matches)
        distinct_shots = len({m.shot_id for m in matches})
        covered = (total_seconds >= target_seconds
                   and distinct_shots >= min_distinct_shots)
        return covered, total_seconds, distinct_shots


# Função pura para testes + benchmark (P3 §test strict obrigatório).
def is_strict_covered_pure(
    matches: list[RequirementMatch],
    *,
    target_seconds: float,
    min_distinct_shots: int,
) -> tuple[bool, float, int]:
    """Versão pura (sem db) que recebe lista de matches já filtados.

    Edge cases documentados:
    - `matches=[]` → `(False, 0.0, 0)` (sem coverage, sem shots).
    - matches só com status PENDING/REJECTED (sem CONFIRMED) → `(False, 0, 0)`.
    - strict_eligible=False em CONFIRMED → ignorado (não conta).

    Validação em _b3:
    - Case A: 1 CONFIRMED + 5 PENDING → NOT_COVERED (10.0s < 48.75s target).
    - Case B: 5 CONFIRMED × 11s → COVERED (55.0s + 5 distinct shots).
    - Case C: matches=[] → (False, 0, 0).
    - Case D: 5 CONFIRMED strict_eligible=False → (False, 0, 0).
    """
    strict_confirmed = [
        m for m in matches
        if m.strict_eligible and m.confirmation_status == CS_CONFIRMED
    ]
    total_seconds = sum(m.duration for m in strict_confirmed)
    distinct_shots = len({m.shot_id for m in strict_confirmed})
    covered = (total_seconds >= target_seconds
               and distinct_shots >= min_distinct_shots)
    return covered, total_seconds, distinct_shots


class QueryHistory:
    """Provider-level dedup window: evita repetir query que já retornou vazio.

    Schema: query_history table em LanceDB. Composite key (workset_id,
    requirement_id, provider, query_normalized) → status unificado.
    """

    TABLE = "query_history"

    def __init__(self, db):
        self._db = db
        # P5 fix: usar property pública `library_root` em vez de `_library_root`.
        root_path = getattr(db, "library_root", None) \
                    or getattr(db, "root", None)
        if root_path is None:
            log.warning(
                "QueryHistory: db não tem 'library_root' nem 'root' — "
                "fallback JSONL desactivado.")
        self._fallback_path = (
            Path(root_path) / "query_history.jsonl"
            if root_path is not None else None
        )

    def _table(self):
        try:
            lance = getattr(self._db, "lance", None) or self._db._db
            return lance.open_table(self.TABLE)
        except Exception:
            return None

    def was_tried(self, workset_id: str, requirement_id: str,
                  provider: str, query: str) -> Optional[str]:
        """Devolve status anterior ('success' | 'empty' | 'error') se existir."""
        qt = self._normalize(query)
        tab = self._table()
        if tab is not None:
            try:
                rows = (tab.search()
                        .where(f"workset_id = '{workset_id}' AND "
                               f"requirement_id = '{requirement_id}' AND "
                               f"provider = '{provider}' AND "
                               f"query_normalized = '{qt}'")
                        .limit(1).to_list())
                if rows:
                    return rows[0].get("status")
            except Exception:
                pass
        if self._fallback_path is None or not self._fallback_path.exists():
            return None
        try:
            with self._fallback_path.open("r", encoding="utf-8") as f:
                for line in f:
                    row = json.loads(line.strip())
                    if (row.get("workset_id") == workset_id
                            and row.get("requirement_id") == requirement_id
                            and row.get("provider") == provider
                            and row.get("query_normalized") == qt):
                        return row.get("status")
        except (OSError, json.JSONDecodeError):
            return None
        return None

    def record(self, entry: QueryHistoryEntry) -> bool:
        entry.query_normalized = self._normalize(entry.query_normalized)
        row = entry.to_row()
        tab = self._table()
        if tab is not None:
            try:
                tab.add([row])
                return True
            except Exception as exc:
                log.debug("QueryHistory.record: LanceDB add falhou (%s) — "
                          "JSONL fallback", exc)
        if self._fallback_path is not None:
            try:
                self._fallback_path.parent.mkdir(parents=True, exist_ok=True)
                with self._fallback_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
                return True
            except OSError as exc:
                log.debug("QueryHistory.record: JSONL write falhou (%s)", exc)
        return False

    @staticmethod
    def _normalize(q: str) -> str:
        """Normaliza query para dedup: lowercase + collapse whitespace."""
        return " ".join((q or "").lower().split())


__all__ = [
    "CS_NOT_REQUIRED", "CS_PENDING", "CS_CONFIRMED", "CS_REJECTED",
    "CS_FAILED_RETRYABLE",
    "ALL_CS",
    "RequirementMatch",
    "QueryHistoryEntry",
    "RequirementIndex",
    "QueryHistory",
]
