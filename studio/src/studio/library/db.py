"""LanceDB — a base da biblioteca (ADR-0002).

Uma tabela `shots`. Vetor SigLIP + metadados achatados em colunas escalares
filtráveis (booleans/strings) + meta_json com a fidelidade completa.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pyarrow as pa

from studio.library.embed import DIM

SHOTS_TABLE = "shots"

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


class LibraryDB:
    def __init__(self, library_root: Path):
        import lancedb

        self.root = library_root
        self.root.mkdir(parents=True, exist_ok=True)
        self._db = lancedb.connect(str(library_root / "lancedb"))
        if SHOTS_TABLE in self._db.table_names():
            self._table = self._db.open_table(SHOTS_TABLE)
        else:
            self._table = self._db.create_table(SHOTS_TABLE, schema=_SCHEMA)

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
        self._table.update(where=f"media_sha = '{media_sha}'", values={"revoked": True})

    def register_usage(self, shot_id: str, run_id: str) -> None:
        rows = (self._table.search().where(f"shot_id = '{shot_id}'").limit(1).to_list())
        if rows:
            self._table.update(
                where=f"shot_id = '{shot_id}'",
                values={"usage_count": rows[0]["usage_count"] + 1, "last_used_run": run_id},
            )
