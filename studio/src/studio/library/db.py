"""LanceDB — a base da biblioteca (ADR-0002).

Uma tabela `shots`. Vetor SigLIP + metadados achatados em colunas escalares
filtráveis (booleans/strings) + meta_json com a fidelidade completa.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any  # usado no annotation @property lance

import numpy as np
import pyarrow as pa

from studio.library.embed import DIM

log = logging.getLogger("studio.library")

SHOTS_TABLE = "shots"
CACHE_TABLE = "provider_cache"


def _build_iter_clause(where: str, include_restricted: bool) -> str:
    """Fase D testar helper: devolve o clause final usado por iter_rows.
    - Default include_restricted=False adiciona `(where) AND restricted=false`.
    - Word-boundary regex evita duplicação se caller já passou `restricted=...`.
    - Triangulâmico testável sem Instanciar LibraryDB ou LanceDB.
    - FIX 2 (code-reviewer): fail-loud em combinações inválidas (sem
      `WHERE` mas pedindo tudo) em vez de mascarar com `1 = 0`.
    """
    empty = not where.strip()
    if empty:
        if include_restricted:
            raise ValueError(
                "_build_iter_clause: include_restricted=True + empty where "
                "— ill-defined (filtrar nada sem critério explícito)")
        return "restricted = false"
    if include_restricted or re.search(r"\brestricted\b", where):
        return where.strip()
    return f"({where}) AND restricted = false"

_SCHEMA = pa.schema([
    ("shot_id", pa.string()),
    ("media_sha", pa.string()),
    ("t_in", pa.float32()),
    ("t_out", pa.float32()),
    ("vec", pa.list_(pa.float32(), DIM)),
    ("summary", pa.string()),
    ("places_csv", pa.string()),
    ("landmarks_csv", pa.string()),
    ("food_csv", pa.string()),
    ("objects_csv", pa.string()),
    ("shot_type", pa.string()),
    ("camera_motion", pa.string()),
    ("time_of_day", pa.string()),
    ("indoor_outdoor", pa.string()),
    ("people_present", pa.bool_()),
    ("quality", pa.int32()),
    ("has_food", pa.bool_()),
    ("has_landmark", pa.bool_()),
    ("restricted", pa.bool_()),      # ex.: cc-by-sa (LIBRARY_POLICY §4.3)
    ("revoked", pa.bool_()),         # takedown (LIBRARY_POLICY §6)
    ("license_source", pa.string()),
    ("license", pa.string()),
    ("attribution_required", pa.bool_()),
    ("attribution_text", pa.string()),
    ("source_url", pa.string()),
    ("author", pa.string()),
    ("usage_count", pa.int32()),
    ("last_used_run", pa.string()),
    ("ingested_at", pa.string()),
    ("keyframes_csv", pa.string()),
    ("media_path", pa.string()),
    ("meta_json", pa.string()),
])

# Provider_cache: persistência de (provider, source_url) → status. Suporta
# negative cache de Vision rejections (Fase 2 — economiza calls repetidas)
# e provider cache (evita re-download de URLs já cacheadas).
_CACHE_SCHEMA = pa.schema([
    ("provider", pa.string()),         # "pexels" | "pixabay" | "vimeo" | ...
    ("source_url", pa.string()),       # chave primária lógica (com provider)
    ("status", pa.string()),           # "hit" (já ingested) | "rejected"
    ("media_sha", pa.string()),        # hit: SHA-256 da media; rejected: ""
    ("reason", pa.string()),           # rejected: motivo (≤200 chars)
    ("created_at", pa.string()),       # ISO8601 UTC, TTL = 90 dias (Settings)
])


class LibraryDB:
    def __init__(self, library_root: Path):
        import lancedb

        self.root = library_root
        self.root.mkdir(parents=True, exist_ok=True)
        # Write-lock (Fase 2): serializa add_shots/mark_revoked/register_usage/
        # cache_mark/cache_mark_rejected dentro do mesmo processo. Reads
        # (search/iter/get) ficam lock-free porque LanceDB read API é
        # thread-safe na API pública.
        self._write_lock = threading.Lock()
        self._db = lancedb.connect(str(library_root / "lancedb"))
        if SHOTS_TABLE in self._db.table_names():
            self._table = self._db.open_table(SHOTS_TABLE)
        else:
            self._table = self._db.create_table(SHOTS_TABLE, schema=_SCHEMA)
        if CACHE_TABLE in self._db.table_names():
            self._cache_tbl = self._db.open_table(CACHE_TABLE)
        else:
            self._cache_tbl = self._db.create_table(CACHE_TABLE,
                                                    schema=_CACHE_SCHEMA)

    # --- public properties (acesso encapsulado a atributos internos) ---
    @property
    def library_root(self) -> Path:
        """Path público equivalente a `self.root` (alias estável para callers
        externos como requirement_index e discovery — evita espalhamento de
        `_library_root` em código downstream).

        NOTA: `self.root` E `self.library_root` são aliases intencionais. O
        primeiro é o nome canónico interno; o segundo existe por ergonomia
        para callers externos (que esperam `library_root_path` semantics).
        """
        return self.root

    @property
    def lance(self) -> "Any":
        """LanceDB connection handle pública. Substitui `_db` privado em
        callers externos que precisam de abrir tabelas próprias
        (requirement_index, discovery, benchmark).

        ⚠️ READ-ONLY USE: writes devem continuar a passar pelos métodos da
        LibraryDB (add_shots, cache_mark, etc.) que serializam via
        `_write_lock`. Bypass expõe a conexão fora do lock — pode causar
        race conditions em writes concorrentes.
        """
        return self._db

    def get_shot(self, shot_id: str) -> dict | None:
        rows = (self._table.search()
                .where(f"shot_id = '{shot_id}'").limit(1).to_list())
        return rows[0] if rows else None

    def media_exists(self, media_sha: str) -> bool:
        return bool(
            self._table.search()
            .where(f"media_sha = '{media_sha}'")
            .limit(1)
            .to_list()
        )

    def add_shots(self, rows: list[dict]) -> None:
        # Lock em writes: dentro do mesmo processo, 2+ threads chamando
        # add_shots em simultâneo serializam (evita corrupção LanceDB).
        with self._write_lock:
            if rows:
                self._table.add(rows)

    def count(self) -> int:
        return self._table.count_rows()

    def term_counts(self) -> dict[str, dict[str, int]]:
        """Vocabulário real da biblioteca: contagem por termo de lugar,
        monumento e comida (shots não revogados). Alimenta o guião grounded
        e o matching por entidade."""
        tbl = self._table.to_arrow()
        revoked = tbl.column("revoked").to_pylist()
        out: dict[str, dict[str, int]] = {"places": {}, "landmarks": {}, "foods": {}}
        for col, key in (("places_csv", "places"), ("landmarks_csv", "landmarks"),
                         ("food_csv", "foods")):
            for cell, rev in zip(tbl.column(col).to_pylist(), revoked):
                if rev or not cell:
                    continue
                for term in cell.split(","):
                    term = term.strip()
                    if term:
                        out[key][term] = out[key].get(term, 0) + 1
        return out

    def search_vec(self, vec: np.ndarray, where: str | None = None,
                   limit: int = 40) -> list[dict]:
        q = self._table.search(vec.tolist()).metric("cosine")
        if where:
            q = q.where(where, prefilter=True)
        results = q.limit(limit).to_list()
        for r in results:
            r.pop("vec", None)  # não arrastar 768 floats para cima
            r["similarity"] = 1.0 - r.get("_distance", 1.0)
            r["meta"] = json.loads(r.get("meta_json") or "{}")
        return results

    def mark_revoked(self, media_sha: str) -> None:
        with self._write_lock:
            self._table.update(where=f"media_sha = '{media_sha}'",
                               values={"revoked": True})

    def iter_rows(self, where_clause: str, *,
                  limit: int = 20_000, include_restricted: bool = False) -> list[dict]:
        """API pública para scans por metadata (Fase C code-reviewer #1+#B).
        Lógica de adição de `AND restricted = false` extraída para
        `_build_iter_clause` (testável sem I/O real)."""
        clause = _build_iter_clause(where_clause, include_restricted)
        try:
            return (self._table.search()
                    .where(clause).limit(limit).to_list())
        except Exception as exc:
            log.warning("LibraryDB.iter_rows falhou (where=%r): %s",
                        where_clause, exc)
            return []  # Fail-soft: caller decide

    def register_usage(self, shot_id: str, run_id: str) -> None:
        # CORRECTNESS (Fase 2 code-reviewer): read tem de ficar DENTRO do
        # lock — read fora + write dentro permite lost-update race (A lê 5,
        # B lê 5, ambos gravam 6 — devia ser 7). Read API é thread-safe mas
        # NÃO atómico contra writes concorrentes; precisamos do lock para
        # garantir o increment é correcto. Trade-off: pequena contenção em
        # writes concorrentes, mas correctness > perf em usage_count.
        with self._write_lock:
            rows = (self._table.search().where(f"shot_id = '{shot_id}'")
                    .limit(1).to_list())
            if rows:
                self._table.update(
                    where=f"shot_id = '{shot_id}'",
                    values={
                        "usage_count": rows[0]["usage_count"] + 1,
                        "last_used_run": run_id,
                    },
                )

    # ----------- Provider / Negative cache (Fase 2) -----------
    # ----------- Provider / Negative cache (Fase 2) -----------
    @staticmethod
    def _esc_sql(s: str) -> str:
        """Defensive SQL escape (Fase 2 code-reviewer): `provider` e
        `source_url` vêm dos nossos próprios resultados de search, mas
        se um provider meter uma aspa simples no URL (ex: Pexels descritor
        com "'s" tipo "it's"), a f-string interpolation quebra a query
        LanceDB ou potencialmente injeta SQL. Escape `'` → `''`.
        """
        return (s or "").replace("'", "''")

    def cache_get(self, provider: str, source_url: str) -> dict | None:
        """Look up (provider, source_url). Returns row or None se miss.

        Read-only: não precisa de lock (LanceDB search é thread-safe).
        Filter via WHERE composto (não scan + python filter).
        """
        rows = (self._cache_tbl.search()
                .where(f"provider = '{self._esc_sql(provider)}' "
                       f"AND source_url = '{self._esc_sql(source_url)}'")
                .limit(1).to_list())
        return rows[0] if rows else None

    def cache_mark(self, provider: str, source_url: str,
                   media_sha: str | None = None) -> None:
        """Marca (provider, source_url) como 'hit'. Append-only (LanceDB).

        Insere nova row em vez de UPDATE: simplicidade + audit log implícito
        (mesma URL pode aparecer várias vezes se re-marcada após TTL).
        """
        row = {
            "provider": provider, "source_url": source_url,
            "status": "hit", "media_sha": media_sha or "",
            "reason": "",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        with self._write_lock:
            self._cache_tbl.add([row])

    def cache_mark_rejected(self, provider: str, source_url: str,
                            reason: str) -> None:
        """Marca (provider, source_url) como 'rejected' com reason ≤200."""
        row = {
            "provider": provider, "source_url": source_url,
            "status": "rejected", "media_sha": "",
            "reason": (reason or "")[:200],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        with self._write_lock:
            self._cache_tbl.add([row])

    def cache_iter_rows(self, where_clause: str, *,
                        limit: int = 20_000) -> list[dict]:
        """API pública para scans sobre provider_cache (Pass 3 close-out).

        NAO aplica restricted filter (cache_tbl nao tem essa coluna) nem
        escapa o clause (caller-controlled; Pass 3 fix remove _esc_sql que
        estava a manglar SQL: status = 'rejected' -> status = ''rejected''
        invalido).
        """
        try:
            return (self._cache_tbl.search()
                    .where(where_clause).limit(limit).to_list())
        except Exception as exc:
            log.warning("LibraryDB.cache_iter_rows falhou (where=%r): %s",
                        where_clause, exc)
            return []

    def cache_prune_by_ttl(self, days: int) -> int:
        """Apaga rows provider_cache com created_at mais antigo que TTL.

        Idempotente. Returns nº rows pruned. Se LanceDB delete() não
        estiver disponível no schema, faz fallback para no-op + warn
        (operador pode correr cleanup manual).
        """
        from datetime import timedelta as _td
        cutoff = datetime.now(timezone.utc) - _td(days=days)
        cutoff_iso = cutoff.isoformat()
        old_clause = f"created_at < '{cutoff_iso}'"
        try:
            old_rows = self.cache_iter_rows(old_clause)
            if not old_rows:
                return 0
            self._cache_tbl.delete(old_clause)
            pruned = len(old_rows)
            log.info("LibraryDB.cache_prune_by_ttl: pruned %d rows older than %dd",
                     pruned, days)
            return pruned
        except AttributeError as exc:
            # FAIL-LOUD (code-reviewer Fase 2 Pass 3): log.error + ingest_log
            # entry tagged prune_disabled=delete_unavailable. Operador vê no
            # log estruturado que cache vai acumular stale rows silenciosamente
            # e deve correr cleanup manual via LanceDB API ou upgrade.
            log.error(
                "LibraryDB.cache_prune_by_ttl: %s -- "
                "prune_disabled=delete_unavailable (LanceDB schema sem .delete())",
                exc.__class__.__name__,
            )
            try:
                self.root.mkdir(parents=True, exist_ok=True)
                with (self.root / "ingest_log.jsonl").open(
                    "a", encoding="utf-8",
                ) as f:
                    f.write(json.dumps({
                        "at": cutoff_iso,
                        "event": "prune_failed",
                        "prune_disabled": "delete_unavailable",
                        "days": days,
                        "operator_action": (
                            "LanceDB schema sem .delete() -- corre cleanup "
                            "manual ou upgrade LanceDB. Cache vai acumular "
                            "stale rows silenciosamente."
                        ),
                    }) + "\n")
            except Exception as log_exc:
                log.debug("cache_prune: ingest_log write falhou (nao fatal): %s",
                          log_exc.__class__.__name__)
            return 0
        except Exception as exc:
            log.warning("LibraryDB.cache_prune_by_ttl falhou (days=%d): %s",
                        days, exc.__class__.__name__)
            return 0
