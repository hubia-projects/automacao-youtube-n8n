"""Item 2.5 (automation closure): testes de paridade backend para os
endpoints novos de monitor_server.py — SSE stream, snapshot de workset,
aprovação de gate (com resume automático), start-from-frontend.

Corre um `ThreadingHTTPServer` real numa porta efémera (127.0.0.1:0) e faz
pedidos HTTP reais — é a forma correcta de testar `http.server` stdlib
sem reescrever a lógica de parsing HTTP à mão. `subprocess.Popen` é
sempre mockado — nunca spawna processos `uv`/`studio` reais durante os
testes.
"""
from __future__ import annotations

import http.client
import json
import socket
import threading
import time
from http.server import ThreadingHTTPServer
from unittest.mock import MagicMock, patch

import pytest

import monitor_server


def _raw_get_stream(port: int, path: str, *, until: bytes, timeout: float = 3.0) -> bytes:
    """Item 2.5: `http.client` assume Content-Length/chunked para saber
    quando parar de ler — uma resposta SSE em streaming (sem nenhum dos
    dois, delimitada só por close de conexão) fica bloqueada em
    `HTTPResponse.read()` até a ligação fechar, o que nunca acontece
    enquanto o stream está vivo. Socket raw evita essa suposição."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    sock.sendall(
        f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        .encode("utf-8"))
    sock.settimeout(timeout)
    data = b""
    deadline = time.time() + timeout
    try:
        while time.time() < deadline and until not in data:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            data += chunk
    finally:
        sock.close()
    return data


@pytest.fixture()
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(monitor_server, "DATA_ROOT", tmp_path)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), monitor_server.Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    thread.join(timeout=5)


def _get(server, path) -> tuple[int, dict]:
    conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1],
                                      timeout=5)
    conn.request("GET", path)
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp.status, json.loads(body) if body else {}


def _post(server, path, payload) -> tuple[int, dict]:
    conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1],
                                      timeout=5)
    data = json.dumps(payload).encode("utf-8")
    conn.request("POST", path, body=data,
                headers={"Content-Type": "application/json",
                        "Content-Length": str(len(data))})
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp.status, json.loads(body) if body else {}


def _write_run_json(tmp_path, video_id, *, gates=None):
    run_dir = tmp_path / "runs" / video_id
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "run.json").write_text(json.dumps({
        "video_id": video_id, "topic": "teste", "created_at": "2026-01-01",
        "gates": gates or {}, "stages": {}, "params": {},
        "cost_ledger": {"total_usd": 0.0, "budget_usd": 15.0},
    }), "utf-8")
    return run_dir


# ---------------------------------------------------------------------------
# GET /api/runs/<id>/workset
# ---------------------------------------------------------------------------
def test_workset_snapshot_sem_workset_devolve_exists_false(server, tmp_path):
    status, body = _get(server, "/api/runs/vid1/workset")
    assert status == 200
    assert body["exists"] is False


def test_workset_snapshot_com_workset_devolve_conteudo_real(server, tmp_path):
    wdir = tmp_path / "library" / "worksets" / "vid1"
    wdir.mkdir(parents=True)
    (wdir / "coverage.json").write_text(
        json.dumps({"is_workset_ready": True, "selection_feasible": True}),
        "utf-8")
    (wdir / "selected_shots.json").write_text(
        json.dumps({"by_entity": {"Lisboa": ["seed_001"]}}), "utf-8")
    status, body = _get(server, "/api/runs/vid1/workset")
    assert status == 200
    assert body["exists"] is True
    assert body["coverage"]["is_workset_ready"] is True
    assert body["selected_shots"]["by_entity"]["Lisboa"] == ["seed_001"]
    assert body["visual_requirements"] is None  # ficheiro não existe


# ---------------------------------------------------------------------------
# POST /api/runs/<id>/approve
# ---------------------------------------------------------------------------
def test_approve_gate_actualiza_run_json_e_spawna_resume(server, tmp_path):
    run_dir = _write_run_json(tmp_path, "vid1")
    with patch("monitor_server._spawn_cli",
              return_value=(True, "/tmp/x.log")) as spawn_mock:
        status, body = _post(server, "/api/runs/vid1/approve",
                             {"gate": "library", "decision": "approve"})
    assert status == 200
    assert body["ok"] is True
    assert body["resume_spawned"] is True
    spawn_mock.assert_called_once_with("vid1", ["resume", "vid1"],
                                       "resume_runner.log")
    saved = json.loads((run_dir / "run.json").read_text("utf-8"))
    assert saved["gates"]["library"] == "approve"


def test_approve_reject_nao_spawna_resume(server, tmp_path):
    _write_run_json(tmp_path, "vid1")
    with patch("monitor_server._spawn_cli") as spawn_mock:
        status, body = _post(server, "/api/runs/vid1/approve",
                             {"gate": "library", "decision": "reject"})
    assert status == 200
    assert body["resume_spawned"] is False
    spawn_mock.assert_not_called()


def test_approve_run_inexistente_devolve_404(server, tmp_path):
    status, body = _post(server, "/api/runs/nope/approve",
                         {"gate": "library", "decision": "approve"})
    assert status == 404


def test_approve_decision_invalida_devolve_400(server, tmp_path):
    _write_run_json(tmp_path, "vid1")
    status, body = _post(server, "/api/runs/vid1/approve",
                         {"gate": "library", "decision": "maybe"})
    assert status == 400


# ---------------------------------------------------------------------------
# POST /api/runs (start-from-frontend)
# ---------------------------------------------------------------------------
def test_start_run_spawna_cli_com_args_corretos(server, tmp_path):
    with patch("monitor_server._spawn_cli",
              return_value=(True, "/tmp/x.log")) as spawn_mock:
        status, body = _post(server, "/api/runs", {
            "video_id": "porto-24h-001",
            "topic": "O que fazer em 24 horas no Porto",
            "duration": 3, "location": "Porto",
            "required_topics": ["Sé do Porto", "Francesinha"],
            "auto_acquire_library": True,
        })
    assert status == 200
    assert body["ok"] is True
    args = spawn_mock.call_args[0][1]
    assert args[:3] == ["run", "--video-id", "porto-24h-001"]
    assert "--topic" in args
    assert "--duration" in args and "3" in args
    assert "--location" in args and "Porto" in args
    assert args.count("--required-topic") == 2
    assert "--auto-acquire-library" in args
    assert "--upload" not in args  # item 20: UPLOAD=OFF por defeito


def test_start_run_sem_video_id_devolve_400(server, tmp_path):
    status, body = _post(server, "/api/runs", {"topic": "x"})
    assert status == 400


# ---------------------------------------------------------------------------
# GET /api/runs/<id>/events/stream (SSE)
# ---------------------------------------------------------------------------
def test_sse_stream_emite_eventos_existentes_na_ordem(server, tmp_path):
    import studio.events as events_mod
    run_dir = tmp_path / "runs" / "vid1"
    j = events_mod.EventJournal(run_dir, "vid1")
    j.emit("s01", "stage_started", "a")
    j.emit("s01", "stage_completed", "b")

    port = server.server_address[1]
    data = _raw_get_stream(port, "/api/runs/vid1/events/stream?after_seq=0",
                           until=b"stage_completed")
    text = data.decode("utf-8")
    assert "text/event-stream" in text
    assert "stage_started" in text
    assert "stage_completed" in text
    assert text.index("stage_started") < text.index("stage_completed")


def test_sse_stream_after_seq_so_devolve_eventos_novos(server, tmp_path):
    import studio.events as events_mod
    run_dir = tmp_path / "runs" / "vid1"
    j = events_mod.EventJournal(run_dir, "vid1")
    j.emit("s01", "a_antigo", "a")
    j.emit("s01", "b_novo", "b")

    port = server.server_address[1]
    data = _raw_get_stream(port, "/api/runs/vid1/events/stream?after_seq=1",
                           until=b"b_novo")
    text = data.decode("utf-8")
    assert "b_novo" in text
    assert "a_antigo" not in text
