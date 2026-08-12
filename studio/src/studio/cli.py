"""CLI do Studio — studio run|resume|status|approve|ingest."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

from studio.config import get_settings
from studio.logging_setup import configure_logging
from studio.orchestrator.runner import PipelineRunner, StageFailed, WaitingApproval, resume
from studio.theme import ThemeSpec
from studio.orchestrator.stage import RunContext
from studio.orchestrator.state import load_state, new_state, save_state, state_path


def _build_stages(pipeline: str) -> list:
    if pipeline == "dummy":
        from studio.stages.dummy import dummy_stages

        return dummy_stages()
    if pipeline == "produce":
        from studio.stages.produce import produce_stages

        return produce_stages()  # s01-s06 (Fase 3); s07+ nas Fases 4-7
    raise SystemExit(f"pipeline {pipeline!r} desconhecido (dummy | produce)")


def _ctx(video_id: str, params: dict | None = None) -> RunContext:
    settings = get_settings()
    run_dir = settings.runs_root / video_id
    return RunContext(video_id=video_id, run_dir=run_dir, settings=settings,
                      params=params or {})


def cmd_run(args: argparse.Namespace) -> int:
    settings = get_settings()
    video_id = args.video_id or datetime.now().strftime("%Y%m%d-%H%M%S")

    if getattr(args, "brief_file", None):
        theme_spec = ThemeSpec.from_brief_file(args.brief_file)
    else:
        theme_spec = ThemeSpec.from_cli(
            topic=args.topic,
            duration_minutes=args.duration,
            required_topics=args.required_topics,
            optional_topics=args.optional_topics,
            language=args.language,
            location=args.location,
        )
    if not theme_spec.theme:
        raise SystemExit("tema vazio — usa --topic ou --brief-file")

    ctx = _ctx(video_id, {"topic": theme_spec.theme,
                          "duration_minutes": theme_spec.target_duration_minutes,
                          "gate_script": args.gate_script,
                          "upload": args.upload,
                          "auto_acquire_library": args.auto_acquire_library,
                          "theme_spec": theme_spec.to_params()})

    if state_path(ctx.run_dir).exists():
        raise SystemExit(f"run {video_id} já existe — usa `studio resume {video_id}`")

    state = new_state(video_id, theme_spec.theme, settings.budget_usd_per_run,
                      params=ctx.params)
    save_state(state, ctx.run_dir)
    return _execute(ctx, _build_stages(args.pipeline), state)


def cmd_resume(args: argparse.Namespace) -> int:
    ctx = _ctx(args.video_id)
    try:
        resume(ctx, _build_stages(args.pipeline))
    except (StageFailed, WaitingApproval) as exc:
        print(f"parado: {exc}", file=sys.stderr)
        return 1
    print(f"run {args.video_id} concluído")
    return 0


def _execute(ctx: RunContext, stages: list, state) -> int:
    try:
        PipelineRunner(stages).run(ctx, state)
    except WaitingApproval as exc:
        print(f"à espera de aprovação: {exc} — decide no Telegram e corre "
              f"`studio resume {ctx.video_id}`", file=sys.stderr)
        return 2
    except StageFailed as exc:
        print(f"falhou: {exc} — corrige e corre `studio resume {ctx.video_id}`",
              file=sys.stderr)
        return 1
    print(f"run {ctx.video_id} concluído — artefactos em {ctx.run_dir}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    settings = get_settings()
    if args.video_id:
        state = load_state(settings.runs_root / args.video_id)
        print(json.dumps(json.loads(state.model_dump_json()), indent=2, ensure_ascii=False))
        return 0
    runs = sorted(settings.runs_root.glob("*/run.json")) if settings.runs_root.exists() else []
    if not runs:
        print("sem runs")
        return 0
    for run_file in runs:
        state = load_state(run_file.parent)
        done = sum(1 for s in state.stages.values() if s.status == "done")
        print(f"{state.video_id:24s} stages done: {done:2d}  "
              f"custo: ${state.cost_ledger.total_usd:.2f}  topic: {state.topic[:40]}")
    return 0


def cmd_approve(args: argparse.Namespace) -> int:
    """Decisão manual local (fallback quando o Telegram não está configurado)."""
    settings = get_settings()
    run_dir = settings.runs_root / args.video_id
    state = load_state(run_dir)
    state.gates[args.gate] = args.decision
    save_state(state, run_dir)
    print(f"gate {args.gate!r} = {args.decision!r} — corre `studio resume {args.video_id}`")
    return 0


def _library(settings):
    from studio.library.db import LibraryDB
    from studio.library.embed import SiglipEmbedder

    return LibraryDB(settings.library_root), SiglipEmbedder()


def cmd_ingest(args: argparse.Namespace) -> int:
    # P3 (2026-08-11): migrate cmd_ingest de ingest_file → ingest_asset.
    # ingest_asset é a ÚNICA porta canónica para colocar media na biblioteca,
    # com state machine (DONE/FAILED_RETRYABLE/FAILED_PERMANENT), DB write
    # verification (P6), empty-media defence (A1). production callers
    # DEVEM usar ingest_asset. ingest_file fica apenas como definição em
    # library/ingest.py (invocado internamente por ingest_asset).
    from studio.library.ingest_asset import ingest_asset

    settings = get_settings()
    db, embedder = _library(settings)
    downloads = settings.library_root / "downloads"
    results = []

    if args.action == "status":
        print(f"shots na biblioteca: {db.count()}")
        return 0

    def _ing(path, lic, src_id=None, vid=None):
        """Wrapper que extrai só o IngestResult (tuple unpacking)."""
        r, _state = ingest_asset(
            path, lic, db, settings, embedder,
            source_id=src_id or "",
            video_id=vid,
        )
        return r

    if args.action == "file":
        if not args.path:
            raise SystemExit("--path obrigatório")
        license_raw = json.loads(args.license) if args.license else {
            "source": "owned", "source_url": "", "license": "owned", "verified_by": "manual",
        }
        results.append(_ing(args.path, license_raw, src_id=args.path.name))

    elif args.action == "sweep":
        if not args.query:
            raise SystemExit("--query obrigatório (em INGLÊS — ADR-0003)")
        provider = args.provider
        if provider == "pexels":
            from studio.library.sources.pexels import sweep
        elif provider == "pixabay":
            from studio.library.sources.pixabay import sweep
        elif provider == "wikimedia":
            from studio.library.sources.wikimedia import sweep
        elif provider == "vimeo":
            from studio.library.sources.vimeo import sweep
        else:
            raise SystemExit(f"provider desconhecido: {provider}")
        for path, lic in sweep(args.query, args.count, settings, downloads):
            src_id = ((lic or {}).get("source_url", "")
                      if isinstance(lic, dict)
                      else getattr(lic, "source_url", "") or path.name)
            results.append(_ing(path, lic, src_id=src_id))

    elif args.action == "watch":
        from studio.library.sources.watchfolder import scan

        inbox = settings.library_root / "inbox"
        for media, lic in scan(inbox):
            if lic is None:
                print(f"REJEITADO (sem sidecar .license.json): {media.name}")
                continue
            src_id = ((lic or {}).get("source_url", "")
                      if isinstance(lic, dict)
                      else getattr(lic, "source_url", "") or media.name)
            results.append(_ing(media, lic, src_id=src_id))

    elif args.action == "seed":
        seed_file = Path(args.path or "seed/queries_travel_pt.txt")
        queries = [ln.strip() for ln in seed_file.read_text("utf-8").splitlines()
                   if ln.strip() and not ln.startswith("#")]
        for provider in ("pexels", "pixabay", "wikimedia", "vimeo"):
            mod = __import__(f"studio.library.sources.{provider}",
                             fromlist=["sweep"])
            for q in queries:
                try:
                    for p, lic in mod.sweep(q, args.count, settings, downloads):
                        src_id = ((lic or {}).get("source_url", "")
                                  if isinstance(lic, dict)
                                  else getattr(lic, "source_url", "") or p.name)
                        results.append(_ing(p, lic, src_id=src_id))
                except Exception as exc:
                    print(f"[{provider}] '{q}' falhou: {exc}")

    elif args.action == "youtube-cc":
        from studio.library.sources.ytdlp_cc import download_cc

        if not args.url:
            raise SystemExit("--url obrigatório")
        path, lic = download_cc(args.url, settings.library_root, downloads)
        results.append(_ing(path, lic, src_id=args.url))

    ingested = sum(1 for r in results if r.status == "ingested")
    shots = sum(r.shots_added for r in results)
    cost = sum(r.cost_usd for r in results)
    print(f"ingeridos: {ingested}/{len(results)} ficheiros, {shots} shots, "
          f"custo ${cost:.3f} — total na biblioteca: {db.count()} shots")
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    from studio.library.search import search_shots

    settings = get_settings()
    db, embedder = _library(settings)
    results = search_shots(
        db, embedder, args.query,
        must_have=args.must_have.split(",") if args.must_have else None,
        must_not=args.must_not.split(",") if args.must_not else None,
        k=args.k,
    )
    for r in results:
        print(f"{r['similarity']:.3f}  {r['shot_id']}  q={r['quality']}  "
              f"food={r['has_food']}  landmark={r['has_landmark']}  {r['summary'][:70]}")
    if not results:
        print("sem resultados")
    return 0


def cmd_discover(args: argparse.Namespace) -> int:
    from studio.approvals.telegram import TelegramClient
    from studio.discovery.topics import discover_topics

    settings = get_settings()
    _, embedder = _library(settings)
    ideas, cost = discover_topics(settings, embedder, count=args.count)
    lines = [f"{i + 1}. [{t.total_score:5.1f}] {t.title_pt} — cobertura "
             f"{t.coverage_pct:.0f}% | demanda {t.demand_score} | "
             f"evergreen {t.evergreen}" for i, t in enumerate(ideas)]
    print("\n".join(lines) + f"\n(custo ${cost:.3f})")
    if args.telegram:
        TelegramClient(settings).send_text(
            "Temas da semana (score | cobertura da biblioteca):\n" + "\n".join(lines)
            + "\n\nProduzir: studio run --topic \"<título>\"")
    return 0


def cmd_cleanup(args: argparse.Namespace) -> int:
    """Manter só os N runs mais recentes (NUNCA toca em data/library/);
    compactar media da biblioteca cujos shots nunca foram usados (720p crf30,
    embeddings/metadados intactos no LanceDB)."""
    import shutil
    import subprocess

    settings = get_settings()
    runs = sorted(settings.runs_root.glob("*/run.json"),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    for run_file in runs[args.keep:]:
        shutil.rmtree(run_file.parent, ignore_errors=True)
        print(f"apagado run antigo: {run_file.parent.name}")

    if args.compact_library:
        from studio.library.db import LibraryDB

        db = LibraryDB(settings.library_root)
        rows = db._table.search().where("usage_count = 0").limit(100000).to_list()
        by_media: dict[str, str] = {r["media_sha"]: r["media_path"] for r in rows}
        used = {r["media_sha"] for r in
                db._table.search().where("usage_count > 0").limit(100000).to_list()}
        for sha, path in by_media.items():
            p = Path(path)
            if sha in used or not p.exists() or p.stat().st_size < 20_000_000:
                continue
            tmp = p.with_suffix(".compact.mp4")
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(p),
                            "-vf", "scale=-2:720", "-c:v", "libx264", "-crf", "30",
                            "-preset", "fast", "-an", str(tmp)], check=True)
            if tmp.stat().st_size < p.stat().st_size:
                tmp.replace(p)
                print(f"compactado: {p.name}")
            else:
                tmp.unlink()
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    """Daemon: retoma runs parados em waiting_approval quando o humano decide
    (botão Telegram ou `studio approve`). Ctrl-C para sair."""
    import time

    from studio.orchestrator.runner import StageFailed, WaitingApproval

    settings = get_settings()
    print(f"watch: poll a cada {args.interval}s (Ctrl-C para sair)")
    while True:
        for run_file in sorted(settings.runs_root.glob("*/run.json")):
            state = load_state(run_file.parent)
            waiting = [n for n, r in state.stages.items()
                       if r.status == "waiting_approval"]
            failed_resumable = [n for n, r in state.stages.items()
                                if r.status == "failed" and args.retry_failed]
            if not waiting and not failed_resumable:
                continue
            ctx = _ctx(state.video_id)
            try:
                resume(ctx, _build_stages(args.pipeline))
                print(f"[watch] {state.video_id}: CONCLUÍDO")
            except WaitingApproval as exc:
                print(f"[watch] {state.video_id}: ainda à espera ({exc.gate})")
            except StageFailed as exc:
                print(f"[watch] {state.video_id}: falhou — {exc}")
        if args.once:
            return 0
        time.sleep(args.interval)


def cmd_costs(args: argparse.Namespace) -> int:
    settings = get_settings()
    total = 0.0
    for run_file in sorted(settings.runs_root.glob("*/run.json")):
        state = load_state(run_file.parent)
        c = state.cost_ledger.total_usd
        total += c
        top = max(state.cost_ledger.by_stage.items(),
                  key=lambda kv: kv[1], default=("-", 0))
        print(f"{state.video_id:24s} ${c:6.3f}  (maior: {top[0]} ${top[1]:.3f})")
    print(f"{'TOTAL':24s} ${total:6.3f}")
    return 0


def cmd_monitor(args: argparse.Namespace) -> int:
    """Arranca o dashboard HTTP que espelha run.json + log em tempo real.
    Stdlib puro (sem deps). Ctrl-C para sair."""
    import importlib.util
    from http.server import ThreadingHTTPServer
    from pathlib import Path

    here = Path(__file__).resolve().parent
    monitor_path = here.parent / "scripts" / "monitor_server.py"
    spec = importlib.util.spec_from_file_location("_studio_monitor", monitor_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    if args.data_root is not None:
        mod.DATA_ROOT = args.data_root
    if str(args.log) != "/tmp/pfv-run.log":
        mod.DEFAULT_LOG = args.log
    addr = (args.bind, args.port)
    print(f"studio-monitor: http://{args.bind}:{args.port}/  "
          f"data={mod.DATA_ROOT}  log={mod.DEFAULT_LOG}")
    try:
        ThreadingHTTPServer(addr, mod.Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstudio-monitor: a sair.")
    return 0


def main(argv: list[str] | None = None) -> int:
    configure_logging(level=logging.INFO, fmt="%(name)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(prog="studio")
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="iniciar um run novo")
    p_run.add_argument("--topic", default="")
    p_run.add_argument("--video-id", default=None)
    p_run.add_argument("--pipeline", default="produce")
    p_run.add_argument("--duration", type=float, default=12.0, help="minutos alvo")
    p_run.add_argument("--gate-script", action="store_true",
                       help="gate humano de aprovação do roteiro")
    p_run.add_argument("--upload", action="store_true",
                       help="publica no YouTube (privado) após aprovação")
    p_run.add_argument("--required-topic", action="append", dest="required_topics",
                       default=[], metavar="TOPIC",
                       help="tópico obrigatório no roteiro (repetível)")
    p_run.add_argument("--optional-topic", action="append", dest="optional_topics",
                       default=[], metavar="TOPIC",
                       help="tópico editorial opcional (repetível)")
    p_run.add_argument("--language", default="pt-PT")
    p_run.add_argument("--location", default=None)
    p_run.add_argument("--brief-file", type=Path, default=None,
                       help="JSON com theme/target_duration_minutes/mandatory_topics/"
                            "optional_topics/language/location — sobrepõe as outras flags")
    p_run.add_argument("--auto-acquire-library", action="store_true",
                       help="adquire assets automaticamente até 100%% de cobertura, "
                            "sem gate manual (default: FALSE — pede aprovação)")
    p_run.set_defaults(func=cmd_run)

    p_res = sub.add_parser("resume", help="retomar run onde parou")
    p_res.add_argument("video_id")
    p_res.add_argument("--pipeline", default="produce")
    p_res.set_defaults(func=cmd_resume)

    p_st = sub.add_parser("status", help="estado de um run ou lista de runs")
    p_st.add_argument("video_id", nargs="?", default=None)
    p_st.set_defaults(func=cmd_status)

    p_ap = sub.add_parser("approve", help="decidir gate manualmente")
    p_ap.add_argument("video_id")
    p_ap.add_argument("gate")
    p_ap.add_argument("decision", choices=["approve", "reject"])
    p_ap.set_defaults(func=cmd_approve)

    p_in = sub.add_parser("ingest", help="ingestão da biblioteca")
    p_in.add_argument("action",
                      choices=["file", "sweep", "watch", "youtube-cc", "seed", "status"])
    p_in.add_argument("--path", type=Path, default=None, help="ficheiro local (action=file)")
    p_in.add_argument("--license", default=None, help="JSON de licença (default: owned)")
    p_in.add_argument("--query", default=None, help="query EM INGLÊS (action=sweep)")
    p_in.add_argument("--provider", default="pexels",
                      choices=["pexels", "pixabay", "wikimedia", "vimeo"])
    p_in.add_argument("--count", type=int, default=5)
    p_in.add_argument("--url", default=None, help="URL YouTube CC (action=youtube-cc)")
    p_in.set_defaults(func=cmd_ingest)

    p_di = sub.add_parser("discover", help="shortlist semanal de temas")
    p_di.add_argument("--count", type=int, default=8)
    p_di.add_argument("--telegram", action="store_true", help="envia para o Telegram")
    p_di.set_defaults(func=cmd_discover)

    p_cl = sub.add_parser("cleanup", help="apaga runs antigos + compacta biblioteca")
    p_cl.add_argument("--keep", type=int, default=10)
    p_cl.add_argument("--compact-library", action="store_true")
    p_cl.set_defaults(func=cmd_cleanup)

    p_wa = sub.add_parser("watch", help="daemon: retoma runs após aprovação Telegram")
    p_wa.add_argument("--interval", type=float, default=20.0)
    p_wa.add_argument("--pipeline", default="produce")
    p_wa.add_argument("--once", action="store_true", help="uma passagem e sai")
    p_wa.add_argument("--retry-failed", action="store_true")
    p_wa.set_defaults(func=cmd_watch)

    p_mo = sub.add_parser("monitor", help="dashboard HTTP que espelha runs ativos")
    p_mo.add_argument("--port", type=int, default=8765)
    p_mo.add_argument("--bind", default="127.0.0.1",
                      help="default 127.0.0.1; use 0.0.0.0 para aceder de fora")
    p_mo.add_argument("--data-root", type=Path, default=None,
                      help="default STUDIO_DATA_ROOT (ou repo/data)")
    p_mo.add_argument("--log", type=Path, default=Path("/tmp/pfv-run.log"),
                      help="log file a fazer tail+live")
    p_mo.set_defaults(func=cmd_monitor)

    p_co = sub.add_parser("costs", help="custos por run (ledgers)")
    p_co.set_defaults(func=cmd_costs)

    p_se = sub.add_parser("search", help="busca híbrida na biblioteca (query em inglês)")
    p_se.add_argument("query")
    p_se.add_argument("--must-have", default=None, help="ex.: food")
    p_se.add_argument("--must-not", default=None, help="ex.: monument,people")
    p_se.add_argument("-k", type=int, default=10)
    p_se.set_defaults(func=cmd_search)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
