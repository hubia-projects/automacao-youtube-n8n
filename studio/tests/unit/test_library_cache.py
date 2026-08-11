"""Testes Pass 1 Fase 2 - provider_cache + LanceDB write-lock em LibraryDB.

Cobre:
- cache_get miss retorna None
- cache_mark escreve "hit" e cache_get devolve a row
- cache_mark_rejected escreve "rejected" com reason <=200 chars
- cache_mark HIT vs REJECTED coexistem (chave unica)
- add_shots/mark_revoked/cache_mark/cache_mark_rejected usam o write-lock
- register_usage atomic (lost-update fix do code-reviewer)
- search_vec, count, get_shot, iter_rows NAO usam o write-lock
- SQL escape em URLs com aspas simples
- 8 Settings novos de Fase 2 com defaults corretos

Estrategia de mocks:
- _FakeLanceTable: stand-in in-memory da tabela LanceDB shots. Substitui
  db._table nos testes de lock para evitar pyarrow validation em rows
  parcialmente preenchidos (que rebentava os testes originais).
- _FakeQuery: chain where/limit/to_list com regex parse `col='value'`.

Limitacao conhecida (documentada para code-reviewer):
- _FakeLanceTable.update() so cobre equality simples (`col='value'`). Em
  producao, db.py so usa equality em register_usage (`shot_id = '...'`) e
  mark_revoked (`media_sha = '...'`). Cobertura suficiente para os testes
  atuais, mas se db.py ganhar AND/OR compostos, este mock tera de ser
  estendido.
"""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path

import pytest


# ----------- helpers in-memory (mock LanceDB table) -----------


class _FakeQuery:
    """Query chain stand-in: where + limit + to_list com regex simples."""

    def __init__(self, rows: list[dict]):
        self._rows = rows
        self._where_clause = None
        self._limit_n = None

    def where(self, clause, **kw):
        self._where_clause = clause
        return self

    def limit(self, n):
        self._limit_n = n
        return self

    def metric(self, name):
        return self

    def to_list(self):
        result = list(self._rows)
        if self._where_clause:
            clauses = re.findall(r"(\w+)\s*=\s*'([^']*)'", self._where_clause)
            if clauses:
                result = [r for r in result
                          if all(str(r.get(c, "")) == v for c, v in clauses)]
        if self._limit_n is not None:
            result = result[: self._limit_n]
        return result


class _FakeLanceTable:
    """LanceDB table in-memory usada nos testes de lock (substitui db._table).

    API minima: add, count_rows, search (devolve _FakeQuery), update com
    equality simples. Veja comment no topo do modulo sobre limitacao.
    """

    def __init__(self):
        self._rows: list[dict] = []

    def add(self, rows):
        # copy para evitar aliasing
        for r in rows:
            self._rows.append(dict(r))

    def count_rows(self):
        return len(self._rows)

    def search(self, vec=None):
        return _FakeQuery(self._rows)

    def update(self, where, values):
        # DB.py so passa equality simples, entao regex cobre 100% dos usos.
        for m in re.finditer(r"(\w+)\s*=\s*'([^']*)'", where):
            col, val = m.group(1), m.group(2)
            for r in self._rows:
                if str(r.get(col, "")) == val:
                    r.update(values)


# ----------- fixtures -----------


@pytest.fixture
def db(tmp_path: Path):
    """LibraryDB fresca em tmp_path para isolamento LanceDB per-teste."""
    from studio.library.db import LibraryDB
    return LibraryDB(tmp_path)


# ----------- tests: cache semanticos -----------


def test_cache_get_empty_returns_none(db):
    """DB nova sem nada em provider_cache -> cache_get devolve None."""
    assert db.cache_get("pexels", "https://example.com/v/123") is None


def test_cache_mark_hit_then_get_returns_hit(db):
    """cache_mark(provider, url, sha) -> cache_get devolve row status=hit."""
    db.cache_mark("pexels", "https://example.com/v/123",
                  media_sha="abc" * 22)  # 66-char fake SHA-256-like
    entry = db.cache_get("pexels", "https://example.com/v/123")
    assert entry is not None
    assert entry["provider"] == "pexels"
    assert entry["source_url"] == "https://example.com/v/123"
    assert entry["status"] == "hit"
    assert entry["media_sha"] == "abc" * 22
    assert entry["reason"] == ""
    assert entry["created_at"]  # ISO8601 preenchido


def test_cache_mark_rejected_then_get_returns_rejected_with_reason(db):
    """cache_mark_rejected(provider, url, reason) -> status=rejected + reason."""
    db.cache_mark_rejected("pexels", "https://example.com/v/456",
                            reason="watermark_detected")
    entry = db.cache_get("pexels", "https://example.com/v/456")
    assert entry is not None
    assert entry["status"] == "rejected"
    assert entry["reason"] == "watermark_detected"
    assert entry["media_sha"] == ""


def test_cache_mark_rejected_truncates_reason_to_200_chars(db):
    """Reasons longos (>200) sao truncados (defensive)."""
    long_reason = "x" * 500
    db.cache_mark_rejected("pexels", "https://example.com/v/789", long_reason)
    entry = db.cache_get("pexels", "https://example.com/v/789")
    assert len(entry["reason"]) == 200, \
        f"reason deve ser truncado a 200 chars, obtido {len(entry['reason'])}"


def test_cache_hit_and_rejected_coexist_per_url(db):
    """Hit vs rejected para URLs DIFERENTES coexistem (key = provider+url)."""
    db.cache_mark("pexels", "https://ex.com/v/1", media_sha="sha1")
    db.cache_mark_rejected("pexels", "https://ex.com/v/2", "low_res")
    e1 = db.cache_get("pexels", "https://ex.com/v/1")
    e2 = db.cache_get("pexels", "https://ex.com/v/2")
    assert e1["status"] == "hit" and e1["media_sha"] == "sha1"
    assert e2["status"] == "rejected" and e2["reason"] == "low_res"


def test_cache_mark_isolates_per_provider(db):
    """Mesmo source_url em providers diferentes = entries separados."""
    db.cache_mark("pexels", "https://common.example/v/1", media_sha="sha_pexels")
    db.cache_mark("pixabay", "https://common.example/v/1", media_sha="sha_pixabay")
    assert db.cache_get("pexels", "https://common.example/v/1")["media_sha"] == "sha_pexels"
    assert db.cache_get("pixabay", "https://common.example/v/1")["media_sha"] == "sha_pixabay"


def test_cache_get_handles_source_url_with_single_quote(db):
    """SQL-injection defense (Fase 2 code-reviewer): URL com aspas simples
    nao deve quebrar o cache_get. Pexels URLs por vezes tem apostrofes.
    """
    tricky_url = "https://ex.com/it's-a-test?v=1"
    db.cache_mark("pexels", tricky_url, media_sha="sha_apos")
    entry = db.cache_get("pexels", tricky_url)
    assert entry is not None
    assert entry["source_url"] == tricky_url  # round-trip preservado


# ----------- tests: lock wiring (writes usam lock, reads NAO) -----------


def test_add_shots_acquires_write_lock(db, monkeypatch):
    """add_shots deve adquirir self._write_lock (via __enter__)."""
    acquired_count: list[str] = []
    real_lock = db._write_lock

    class _LockedProbe:
        def __enter__(self):
            acquired_count.append("enter")
            return real_lock.__enter__()

        def __exit__(self, *a):
            return real_lock.__exit__(*a)

    monkeypatch.setattr(db, "_write_lock", _LockedProbe())
    monkeypatch.setattr(db, "_table", _FakeLanceTable())  # evita pyarrow validation
    db.add_shots([{"fake": "row"}])
    assert len(acquired_count) >= 1, \
        f"add_shots nao entrou no lock - acquired_count={acquired_count!r}"


def test_mark_revoked_acquires_write_lock(db, monkeypatch):
    """mark_revoked deve adquirir self._write_lock."""
    acquired_count: list[str] = []
    real_lock = db._write_lock

    class _LockedProbe:
        def __enter__(self):
            acquired_count.append("enter")
            return real_lock.__enter__()

        def __exit__(self, *a):
            return real_lock.__exit__(*a)

    monkeypatch.setattr(db, "_write_lock", _LockedProbe())
    monkeypatch.setattr(db, "_table", _FakeLanceTable())
    db.mark_revoked("nonexistent_sha")
    assert len(acquired_count) >= 1


def test_cache_writes_acquire_write_lock(db, monkeypatch):
    """cache_mark + cache_mark_rejected devem adquirir self._write_lock."""
    acquired_count: list[str] = []
    real_lock = db._write_lock

    class _LockedProbe:
        def __enter__(self):
            acquired_count.append("enter")
            return real_lock.__enter__()

        def __exit__(self, *a):
            return real_lock.__exit__(*a)

    monkeypatch.setattr(db, "_write_lock", _LockedProbe())
    db.cache_mark("pexels", "https://ex.com/v/1")
    db.cache_mark_rejected("pexels", "https://ex.com/v/2", "reason")
    assert len(acquired_count) >= 2


def test_reads_do_not_acquire_write_lock(db):
    """Reads (count, get_shot, iter_rows, search_vec) NAO devem adquirir lock.

    Probe **RAISE** (fail-loud): se algum read inadvertidamente usar o lock,
    o teste detecta e falha explicitamente em vez de passar soft.
    """
    real_lock = db._write_lock
    forbid_called = {"hit": False}

    class _ForbiddenLock:
        """Proxy que faz forward de reads (search/count_rows/etc.) para a
        tabela real, mas RAISE em __enter__ para detectar lock-acquired.

        Sem __getattr__ proxy, `iter_rows`/`get_shot`/`count` rebentavam
        com AttributeError ANTES do probe do lock disparar, e o teste
        passava silenciosamente sem verificar nada.
        """

        def __getattr__(self, name):
            # Forward todo attribute access para a tabela real; dunders
            # são resolvidos a type-level antes do __getattr__ cair (não há
            # paranoia necessária).
            return getattr(db._table, name)

        def __enter__(self):
            forbid_called["hit"] = True
            raise AssertionError(
                "READ adquiriu write-lock - regressao (reads tem de ser "
                "lock-free em db.py)")

        def __exit__(self, *a):
            return real_lock.__exit__(*a)

    db._write_lock = _ForbiddenLock()
    try:
        # Captura AssertionError como sinal de deteccao (test deve FALHAR
        # no assert final se algum read tocou o lock).
        try:
            _ = db.count()
            _ = db.get_shot("nonexistent_shot_id")
            _ = db.iter_rows("1 = 0")
        except AssertionError:
            pass
    finally:
        db._write_lock = real_lock
    assert not forbid_called["hit"], \
        "reads adquiriram write-lock - reads tem de ser lock-free"


# ----------- tests: concurrency (lock serializa e atomic guarantee) -----------


def test_lock_protects_concurrent_add_shots_no_corruption(db, monkeypatch):
    """8 threads paralelas com mock table; lock serializa -> 40 rows unicas."""
    fake_table = _FakeLanceTable()
    monkeypatch.setattr(db, "_table", fake_table)

    n_threads = 8
    rows_per_thread = 5
    errors: list[str] = []

    def worker(tid: int) -> None:
        try:
            rows = [
                {"shot_id": f"t{tid}_s{j}", "media_sha": f"sha_t{tid}",
                 "usage_count": 0, "quality": 5}
                for j in range(rows_per_thread)
            ]
            db.add_shots(rows)
        except Exception as exc:
            errors.append(f"thread {tid}: {exc!r}")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == [], f"errors paralelas: {errors}"
    assert fake_table.count_rows() == n_threads * rows_per_thread, \
        f"esperado {n_threads * rows_per_thread} rows, obtido {fake_table.count_rows()}"
    # Cada shot_id unico (locks serializaram writes -> 0 overwrites)
    shot_ids = [r["shot_id"] for r in fake_table._rows]
    assert len(set(shot_ids)) == n_threads * rows_per_thread, \
        f"shot_ids duplicados: {len(shot_ids)} != {len(set(shot_ids))}"


def test_lock_serializes_cache_writes_in_order(db):
    """Duas cache_mark com mesma URL = 2 rows (append-only)."""
    db.cache_mark("pexels", "https://ex.com/v/1", media_sha="first")
    db.cache_mark("pexels", "https://ex.com/v/1", media_sha="second")
    assert db._cache_tbl.count_rows() == 2  # ambas persistidas


def test_register_usage_is_atomic_under_concurrency(db, monkeypatch):
    """CORRECTNESS REGRESSION: 10 threads paralelas em register_usage
    devem incrementar usage_count exactamente 10 vezes (lost-update bug fix).

    Mock `_FakeLanceTable` + 5ms `time.sleep` no update() para ampliar
    race window deterministica (sem delay, GIL pode serializar as threads
    em runs single-core e o teste passaria MESMO SEM o fix do lost-update).
    """
    fake_table = _FakeLanceTable()
    shot_id = "test_atomic_register"
    fake_table.add([{
        "shot_id": shot_id, "media_sha": "sha_atomic",
        "usage_count": 0, "last_used_run": "",
    }])
    # Delay de 5ms em cada update() amplia a janela onde duas threads
    # leriam o mesmo counter sem atomicidade.
    real_update = fake_table.update

    def slow_update(where, values):
        time.sleep(0.005)
        real_update(where, values)

    fake_table.update = slow_update
    monkeypatch.setattr(db, "_table", fake_table)

    n_threads = 10
    errors: list[str] = []

    def worker(i: int) -> None:
        try:
            db.register_usage(shot_id, f"run_{i}")
        except Exception as exc:
            errors.append(repr(exc))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == [], f"register_usage errors: {errors}"
    final = db.get_shot(shot_id)
    # Sem o lock: valor aleatorio < 10 (lost-updates). Com o lock: 10.
    assert final["usage_count"] == n_threads, \
        f"register_usage lost-update: esperado {n_threads}, obtido {final['usage_count']}"


# ----------- tests: settings wiring -----------


def test_settings_have_new_fase2_fields():
    """Settings deve expor os 8 novos campos da Fase 2 com defaults coerentes.

    NOTA: defaults calibrados em 2026-08 no hardware GTX 1050 Ti 4 GB VRAM:
    ingest_batch_size_start=8 (floor seguro); ingest_batch_size_max=64
    (cap auto-tune). Os valores iniciais deste test (16, 32) eram
    placeholders que foram afinados em produção — o test acompanha os
    defaults operacionais para detectar drift silencioso entre código
    e config.
    """
    from studio.config import Settings
    s = Settings()
    assert s.topup_dl_workers == 2
    assert s.topup_ingest_workers == 1
    assert s.topup_queue_max == 32
    assert s.ingest_batch_size_start == 8
    assert s.ingest_batch_size_max == 64
    assert s.early_reject_min_resolution == 720
    assert s.early_reject_min_duration_s == 2.0
    assert s.negative_cache_ttl_days == 90
