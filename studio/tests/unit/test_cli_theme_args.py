"""Testes de parsing da CLI `studio run` (item 2 — ThemeSpec/CLI).

Não executa o pipeline: monkeypatch de `cmd_run` para capturar o
`argparse.Namespace` já parseado e inspecionar os campos novos.
"""
from __future__ import annotations

from studio import cli


def _captured_args(monkeypatch, argv):
    captured = {}

    def _fake_cmd_run(args):
        captured["args"] = args
        return 0

    monkeypatch.setattr(cli, "cmd_run", _fake_cmd_run)
    rc = cli.main(argv)
    return rc, captured["args"]


def test_run_aceita_multiplos_required_topic(monkeypatch):
    rc, args = _captured_args(monkeypatch, [
        "run", "--topic", "O que fazer em 24 horas no Porto", "--duration", "3",
        "--required-topic", "Sé do Porto",
        "--required-topic", "Ponte Dom Luís I",
        "--required-topic", "Livraria Lello",
    ])
    assert rc == 0
    assert args.required_topics == ["Sé do Porto", "Ponte Dom Luís I", "Livraria Lello"]
    assert args.duration == 3.0


def test_run_sem_required_topic_default_lista_vazia(monkeypatch):
    _, args = _captured_args(monkeypatch, ["run", "--topic", "X"])
    assert args.required_topics == []
    assert args.optional_topics == []


def test_run_auto_acquire_library_default_false(monkeypatch):
    _, args = _captured_args(monkeypatch, ["run", "--topic", "X"])
    assert args.auto_acquire_library is False


def test_run_auto_acquire_library_flag(monkeypatch):
    _, args = _captured_args(monkeypatch, ["run", "--topic", "X", "--auto-acquire-library"])
    assert args.auto_acquire_library is True


def test_run_brief_file_flag(monkeypatch, tmp_path):
    brief = tmp_path / "brief.json"
    brief.write_text("{}", encoding="utf-8")
    _, args = _captured_args(monkeypatch, ["run", "--brief-file", str(brief)])
    assert str(args.brief_file) == str(brief)
