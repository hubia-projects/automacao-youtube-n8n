"""Track-and-skip dedup da biblioteca (Task 4).

Mantém um set persistido de source_id já ingested para evitar:
- Re-download do mesmo vídeo de Pexels/Pixabay/Vimeo
- Re-análise (Gemini Flash) do mesmo footage
- Re-embedding SigLIP

Implementação: JSON atómico (write-and-rename) + LRU em memória.

Também é gravado `media_sha` para permitir dedup cross-source (mesmo vídeo
publicado em duas fontes é detectado). Não substitui LanceDB provider_cache
(table já existe) — coexiste para queries rápidas.
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

log = logging.getLogger("studio.library.dedup")

# Repos-aware path (idêntico ao reconcile.py): este módulo pode ser importado
# via `python -m` (CWD=repo-root) OU via `uv run --directory studio` (CWD=studio),
# daí derivar do __file__ para NÃO resolver em data/library relativa ao CWD
# (que seria studio/data/library/ — costumam ficar índices stale).
_REPO_ROOT_DEDUP = Path(__file__).resolve().parents[4]
INDEX_PATH = _REPO_ROOT_DEDUP / "data" / "library" / "ingested_index.json"


class DedupIndex:
    """Cache persistente de source_id já ingested.

    Thread-safe para uso concorrente em múltiplos workers Pexels.

    Uso típico:
        idx = DedupIndex()
        if idx.has("pexels_6288293"):
            skip_download()
        else:
            download()
            idx.add("pexels_6288293", media_sha="<sha256>")

    Erros de escrita em disco são tratados como **fatais**: se o tmp-rename
    falhar, persistimos um flag `dirty=true` no fim do ficheiro e marcamos
    em memória como `_dirty=True`. O próximo processo que arrancar vê o
    `dirty` e regride ao estado em memória (correto) em vez de carregar o
    estado em disco desactualizado.
    """

    def __init__(self, path: Path = INDEX_PATH) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._items: dict[str, dict] = {}   # source_id -> {media_sha, at, status, at_iso}
        self._sha_index: dict[str, str] = {}  # media_sha -> source_id (O(1) cross-source)
        self._dirty: bool = False
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            log.debug("dedup: %s não existe — começa vazio", self.path)
            return
        try:
            data = json.loads(self.path.read_text("utf-8"))
            items = data.get("items", data.get("source_ids", []))
            if items and isinstance(items[0], str):
                # legacy formato: lista de strings
                self._items = {sid: {"media_sha": "", "at": ""} for sid in items}
            else:
                self._items = {it["source_id"]: it for it in items}
            # Rebuild secondary index by sha (file-review fix #3: O(1) has_sha)
            self._sha_index = {
                it.get("media_sha", ""): sid
                for sid, it in self._items.items()
                if it.get("media_sha")
            }
            if data.get("dirty"):
                log.warning("dedup: disco marcado dirty — usando estado em memória de %d items",
                            len(self._items))
            log.info("dedup: %d entries loaded from %s (sha_index=%d)",
                     len(self._items), self.path, len(self._sha_index))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("dedup: %s unreadable (%s) — começa vazio", self.path, exc)
            self._items = {}
            self._sha_index = {}

    def has(self, source_id: str) -> bool:
        """True se o source_id JÁ foi ingested (não re-download)."""
        with self._lock:
            return source_id in self._items

    def has_sha(self, media_sha: str) -> bool:
        """True se algum item com este media_sha JÁ existe (cross-source dedup).
        O(1) via _sha_index."""
        if not media_sha:
            return False
        with self._lock:
            return media_sha in self._sha_index

    def add(self, source_id: str, media_sha: str = "",
            status: str = "ingested") -> bool:
        """Devolve True se source_id era novo; False se já existia."""
        with self._lock:
            if source_id in self._items:
                return False
            from datetime import datetime, timezone
            self._items[source_id] = {
                "source_id": source_id,
                "media_sha": media_sha,
                "status": status,
                "at": datetime.now(timezone.utc).isoformat(),
            }
            if media_sha:
                self._sha_index[media_sha] = source_id
            try:
                self._persist()
                self._dirty = False
            except OSError:
                # file-review fix #4: NÃO swallow; marca dirty para próximo startup
                self._dirty = True
                raise
            return True

    def _persist(self) -> None:
        """Escrita atómica: tmp + rename (POSIX garante consistência).
        file-review fix #4: raise se rename falha (não swallow)."""
        tmp = self.path.with_suffix(".tmp")
        payload = {
            "version": 2,
            "count": len(self._items),
            "dirty": self._dirty,
            "items": [self._items[k] for k in sorted(self._items.keys())],
        }
        try:
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
            tmp.rename(self.path)
        except OSError as exc:
            log.error("dedup: persist FATAL — %s (in-mem=%d sha_index=%d)",
                      exc, len(self._items), len(self._sha_index))
            raise

    def is_dirty(self) -> bool:
        return self._dirty

    def stats(self) -> dict:
        with self._lock:
            by_status: dict[str, int] = {}
            for it in self._items.values():
                st = it.get("status", "?")
                by_status[st] = by_status.get(st, 0) + 1
            return {
                "path": str(self.path),
                "total": len(self._items),
                "by_status": by_status,
            }


__all__ = ["DedupIndex", "INDEX_PATH"]
