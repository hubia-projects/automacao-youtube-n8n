"""Item 2.1 (automation closure): EventJournal — journal de eventos
append-only, seq monótono, redacção de segredos, resume-safe.
"""
from __future__ import annotations

import json

import pytest

from studio.events import EventJournal, emit, get_journal, reset_journal_cache


@pytest.fixture(autouse=True)
def _reset():
    reset_journal_cache()


def test_emit_grava_jsonl_com_seq_monotono(tmp_path):
    j = EventJournal(tmp_path, "vid1")
    e1 = j.emit("08_matching", "stage_started", "a")
    e2 = j.emit("08_matching", "stage_completed", "b")
    assert e1.seq == 1
    assert e2.seq == 2
    lines = (tmp_path / "events.jsonl").read_text("utf-8").strip().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["event_type"] == "stage_started"


def test_seq_resume_safe_le_ultima_linha_do_ficheiro(tmp_path):
    j1 = EventJournal(tmp_path, "vid1")
    j1.emit("s08", "a")
    j1.emit("s08", "b")
    # simula reinício de processo: nova instância, mesmo ficheiro.
    j2 = EventJournal(tmp_path, "vid1")
    e3 = j2.emit("s08", "c")
    assert e3.seq == 3


def test_read_from_devolve_so_eventos_apos_seq(tmp_path):
    j = EventJournal(tmp_path, "vid1")
    j.emit("s08", "a")
    j.emit("s08", "b")
    j.emit("s08", "c")
    events = j.read_from(after_seq=1)
    assert [e.seq for e in events] == [2, 3]


def test_read_from_zero_devolve_todos(tmp_path):
    j = EventJournal(tmp_path, "vid1")
    j.emit("s08", "a")
    j.emit("s08", "b")
    assert len(j.read_from(after_seq=0)) == 2


def test_read_from_sem_ficheiro_devolve_vazio(tmp_path):
    j = EventJournal(tmp_path / "nope", "vid1")
    assert j.read_from() == []


def test_redaccao_de_segredos_na_message_e_payload(tmp_path):
    j = EventJournal(tmp_path, "vid1")
    e = j.emit("s08", "credentials_invalid",
              "erro na chamada, Bearer abc123xyz falhou",
              payload={"url": "https://x.com/?key=AIzaSyABCDEF1234567890",
                       "nested": {"token": "Bearer abc123"}})
    assert "abc123xyz" not in e.message
    assert "AIzaSyABCDEF1234567890" not in e.payload["url"]
    assert "abc123" not in json.dumps(e.payload)


def test_get_journal_cacheia_por_run_dir(tmp_path):
    j1 = get_journal(tmp_path, "vid1")
    j2 = get_journal(tmp_path, "vid1")
    assert j1 is j2
    j1.emit("s08", "a")
    e2 = j2.emit("s08", "b")
    assert e2.seq == 2  # partilham o mesmo contador (mesma instância)


def test_emit_helper_top_level(tmp_path):
    ev = emit(tmp_path, "vid1", "s01", "run_started", "ola")
    assert ev.seq == 1
    assert (tmp_path / "events.jsonl").exists()
