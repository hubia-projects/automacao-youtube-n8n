#!/usr/bin/env python3
"""Monitor HTTP server para o pipeline Studio Hubia.

Stdlib puro (http.server + json) — não toca pyproject.toml nem precisa de
deps novas. Lê `run.json` do run + tail do log em cada request; o cliente
faz polling a cada 4s (não usamos server-sent events para manter stdlib).

Endpoints:
    GET /                           → dashboard HTML estático
    GET /api/runs/<video_id>        → JSON com 14 estágios + custo + gates
    GET /api/log?lines=80           → tail do log file
    GET /api/ping                   → healthcheck
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
# SCRIPTS_DIR = <repo>/studio/scripts  →  parents[0] é <repo>/studio.
STUDIO_ROOT = SCRIPTS_DIR.parents[0]
REPO_ROOT = STUDIO_ROOT.parent
DATA_ROOT = Path(os.environ.get("STUDIO_DATA_ROOT") or REPO_ROOT / "data")
DEFAULT_LOG = Path(os.environ.get("STUDIO_MONITOR_LOG") or "/tmp/pfv-run.log")
DEFAULT_PORT = int(os.environ.get("STUDIO_MONITOR_PORT") or "8765")

# Ordem canónica dos 14 estágios do pipeline produce — bate certo com
# produce_stages() em stages/produce.py.
STAGES_ORDER = [
    "01_topic", "02_research", "03_script", "04_tts", "05_timestamps",
    "06_scenes", "07_briefs", "08_matching", "09_timeline", "10_render_proxy",
    "11_review", "12_render_final", "13_package", "14_upload",
]

STAGE_LABELS = {
    "01_topic":        "Tópico",
    "02_research":     "Pesquisa Gemini",
    "03_script":       "Roteiro (Gemini Pro)",
    "04_tts":          "Síntese de voz (TTS)",
    "05_timestamps":   "Whisper timestamps",
    "06_scenes":       "Segmentação cenas",
    "07_briefs":       "Visual briefs",
    "08_matching":     "Matching shots↔cenas",
    "09_timeline":     "Timeline builder",
    "10_render_proxy": "Render proxy 480p",
    "11_review":       "Review Vision (Gemini)",
    "12_render_final": "Render final 1080p",
    "13_package":      "Metadata + thumbnail",
    "14_upload":       "Publicar YouTube",
}


def _read_run(video_id: str) -> dict | None:
    rp = DATA_ROOT / "runs" / video_id / "run.json"
    if not rp.exists():
        return None
    try:
        return json.loads(rp.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _tail_lines(path: Path, n: int) -> list[str]:
    """Últimas N linhas do ficheiro (lê 64KB do fim — mais janela que 8KB
    anterior; o user pediu que o log não pareça 'estagnado')."""
    if not path.exists():
        return []
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            f.seek(max(0, size - 65536))
            data = f.read().decode("utf-8", errors="replace")
        return [l for l in data.splitlines() if l.strip()][-n:]
    except OSError:
        return []


def _file_stats(path: Path) -> dict:
    """mtime + size do ficheiro em epoch/ISO — usado pelo cliente para
    saber SE o log mudou desde a última fetch (flash visual + 'Xs ago')."""
    if not path.exists():
        return {"exists": False, "mtime_epoch": None, "mtime_iso": None,
                "size_bytes": 0}
    try:
        st = path.stat()
        return {
            "exists": True,
            "mtime_epoch": st.st_mtime,
            "mtime_iso": dt.datetime.fromtimestamp(st.st_mtime,
                                                   tz=dt.timezone.utc).isoformat(),
            "size_bytes": st.st_size,
        }
    except OSError:
        return {"exists": False, "mtime_epoch": None, "mtime_iso": None,
                "size_bytes": 0}


# Mapa reverso de label → estado humano (pt-PT)
PT_STATUS = {
    "done": "CONCLUÍDO",
    "running": "A CORRER",
    "failed": "FALHOU",
    "waiting_approval": "À ESPERA",
    "pending": "PENDENTE",
}


class Handler(BaseHTTPRequestHandler):
    # Silencia o log de acesso (chatty em produção)
    def log_message(self, fmt: str, *args) -> None:  # noqa: D401
        pass

    def _send_json(self, obj: dict, code: int = 200) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: Path) -> None:
        if not path.exists():
            self.send_error(404, f"{path.name} not found")
            return
        body = path.read_bytes()
        self.send_response(200)
        ctype = ("text/html; charset=utf-8" if path.suffix == ".html"
                 else "application/octet-stream")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _stage_view(self, run: dict) -> list[dict]:
        stages_meta = run.get("stages", {})
        out = []
        for name in STAGES_ORDER:
            rec = stages_meta.get(name, {}) or {}
            out.append({
                "name": name,
                "label": STAGE_LABELS[name],
                "status": rec.get("status", "pending"),
                "status_pt": PT_STATUS.get(rec.get("status", "pending"),
                                            rec.get("status", "pending").upper()),
                "attempts": rec.get("attempts", 0),
                "cost_usd": float(rec.get("cost_usd") or 0.0),
                "started_at": rec.get("started_at"),
                "finished_at": rec.get("finished_at"),
                "error": rec.get("error"),
            })
        return out

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        path = self.path.split("?", 1)[0]

        if path == "/" or path == "/index" or path == "/index.html":
            return self._send_file(STUDIO_ROOT / "scripts" / "static" / "index.html")

        if path.startswith("/api/runs/"):
            vid = path[len("/api/runs/"):].strip("/")
            if not vid or "/" in vid:
                return self._send_json({"error": "bad video_id format"}, 400)
            run = _read_run(vid)
            if not run:
                return self._send_json(
                    {"error": "run not found", "video_id": vid,
                     "data_root": str(DATA_ROOT)}, 404)
            stages = self._stage_view(run)
            budget = run.get("cost_ledger", {}).get("budget_usd", 15.0)
            return self._send_json({
                "video_id": run["video_id"],
                "topic": run.get("topic", ""),
                "created_at": run.get("created_at"),
                "params": run.get("params", {}),
                "gates": run.get("gates", {}),
                "cost_total": float(run.get("cost_ledger", {}).get("total_usd") or 0.0),
                "budget": float(budget),
                "stages": stages,
            })

        if path.startswith("/api/log"):
            qpath = self.path.split("?", 1)
            qparams: dict = {}
            if len(qpath) > 1:
                for kv in qpath[1].split("&"):
                    if "=" in kv:
                        k, v = kv.split("=", 1)
                        qparams[k] = v
            try:
                n = max(1, min(int(qparams.get("lines", "120")), 500))
            except ValueError:
                n = 120
            stats = _file_stats(DEFAULT_LOG)
            return self._send_json({
                "path": str(DEFAULT_LOG),
                "exists": DEFAULT_LOG.exists(),
                "server_now_epoch": dt.datetime.now(dt.timezone.utc).timestamp(),
                "server_now_iso": dt.datetime.now(dt.timezone.utc).isoformat(),
                "file_mtime_epoch": stats["mtime_epoch"],
                "file_mtime_iso": stats["mtime_iso"],
                "size_bytes": stats["size_bytes"],
                "lines": _tail_lines(DEFAULT_LOG, n),
            })

        if path == "/api/ping":
            now = dt.datetime.now(dt.timezone.utc).isoformat()
            return self._send_json({"ok": True, "now": now,
                                    "data_root": str(DATA_ROOT)})

        if path == "/api/runs":
            rs = DATA_ROOT / "runs"
            if not rs.exists():
                return self._send_json({"runs": []})
            entries = []
            for p in rs.iterdir():
                if not p.is_dir():
                    continue
                rp = p / "run.json"
                if not rp.exists():
                    continue
                try:
                    meta = json.loads(rp.read_text("utf-8"))
                except Exception:
                    continue
                entries.append({
                    "video_id": p.name,
                    "topic": meta.get("topic", ""),
                    "created_at": meta.get("created_at"),
                    "started_at_01": (meta.get("stages") or {}).get(
                        "01_topic", {}).get("started_at"),
                    "cost_total": float(meta.get("cost_ledger", {}).get("total_usd") or 0.0),
                    "current_stage": next(
                        ({"stage": k, "status": v.get("status"),
                          "started_at": v.get("started_at")}
                         for k, v in (meta.get("stages") or {}).items()
                         if v.get("status") in ("running", "waiting_approval")),
                        None),
                })
            # Sort: MAIS RECENTE PRIMEIRO (o utilizador quer ver o run ativo,
            # não um smoke-test antigo). created_at é ISO UTC — string sort
            # funciona perfeitamente.
            entries.sort(key=lambda e: (e.get("created_at") or ""), reverse=True)
            return self._send_json({"runs": entries[:20]})

        self.send_error(404, "Not found")


def main() -> None:
    global DATA_ROOT  # noqa: PLW0603 — declarar antes de qualquer referência
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--bind", default="127.0.0.1",
                    help="default 127.0.0.1; use 0.0.0.0 para aceder de outra máquina")
    ap.add_argument("--data-root", type=Path, default=DATA_ROOT)
    args = ap.parse_args()

    # Aplicar override pós-argparse (CLI ganha sobre env var)
    if args.data_root is not None:
        DATA_ROOT = args.data_root
    if not (STUDIO_ROOT / "scripts" / "static" / "index.html").exists():
        raise SystemExit(
            f"index.html não encontrado em scripts/static/. Cria-o primeiro."
        )

    srv = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"studio-monitor: http://{args.bind}:{args.port}/  data={DATA_ROOT}  "
          f"log={DEFAULT_LOG}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstudio-monitor: a sair.")


if __name__ == "__main__":
    main()
