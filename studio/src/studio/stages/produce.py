"""Stages s01-s06 do pipeline de produção (Fase 3).

Cada stage é fino: lê artefactos anteriores do disco, chama o módulo de
domínio, escreve outputs + devolve custo. Fail-closed em tudo.
"""

from __future__ import annotations

import json
import logging

from studio.approvals.gates import GatePending, GateRejected, request_gate
from studio.events import emit as emit_event
from studio.orchestrator.stage import RunContext, StageResult
from studio.theme import ThemeSpec
from studio.script.lint import lint, normalize_for_tts, scrub_safety_phrases
from studio.script.scenes import segment_scenes
from studio.script.writer import (
    Outline,
    build_mega_script,
    critique_and_revise,
    humanize,
    research_pack,
    reset_mega_metrics,
    get_mega_metrics,
)

log = logging.getLogger("studio.produce")


# ----------------- Fase G helpers (S08Matching) -----------------
def _attach_segment_metadata(segments, db) -> int:
    """FIX-2 (CRÍTICO code-reviewer): SegmentAssignment vem SEM
    `places_csv`/`landmarks_csv`/`food_csv` por defeito (defaults ""),
    e o Pydantic v2 default reject `extra='allow'` na schema.

    Solução aplicada (Fase G):
      * SegmentAssignment declara os 3 campos com `default=""` e
        `model_config = {"extra": "allow"}` (ver assigner.py).
      * Aqui usamos diretamente `setattr(seg, col, val)` — funciona
        porque os campos estão declarados.
      * `__confirmation` (não declarada) entra via `extra='allow'`.

    FIX-6: aproveita o lookup para também anexar `__confirmation`
    parseado do meta_json (cached in-process no confirmation.py).
    """
    if not segments:
        return 0
    enriched = 0
    seen_cache: dict[str, dict] = {}
    for seg in segments:
        if not seg.shot_id:
            continue
        # Já tem CSV preenchido vindo do assign_shots — não re-enriquecer.
        if all(getattr(seg, c, "") for c in
               ("places_csv", "landmarks_csv", "food_csv")):
            enriched += 1
            continue
        row = seen_cache.get(seg.shot_id)
        if row is None:
            try:
                row = db.get_shot(seg.shot_id) or {}
            except Exception as exc:
                log.debug("_attach_segment_metadata: get_shot('%s') "
                          "falhou (%s) — segmento fica sem CSV",
                          seg.shot_id, exc.__class__.__name__)
                row = {}
            seen_cache[seg.shot_id] = row
        # setattr directo: os 3 campos estão declarados em SegmentAssignment.
        for col in ("places_csv", "landmarks_csv", "food_csv"):
            if not getattr(seg, col, ""):
                try:
                    setattr(seg, col, row.get(col, "") or "")
                except Exception as exc:
                    log.debug("_attach_segment_metadata: setattr('%s') "
                              "falhou (%s)", col, exc.__class__.__name__)
        # FIX-6: __confirmation extraída do meta_json (não-declarada → extra)
        try:
            meta_raw = row.get("meta_json", "") or ""
            meta = json.loads(meta_raw) if isinstance(meta_raw, str) else {}
            confs = meta.get("confirmations", {}) or {}
            if confs and not getattr(seg, "__confirmation", None):
                first = next(iter(confs.values()), None)
                if isinstance(first, dict):
                    seg.__confirmation = first
        except (json.JSONDecodeError, AttributeError, StopIteration):
            pass
        enriched += 1
    return enriched


def _targeted_topup_for_entity(
    canonical: str, entity_type: str,
    plan, db, settings, *, embedder, run_id,
) -> int:
    """Top-up dirigido a UMA entity específica (FIX-reviewer-#1:

    recebe canonical+type directamente, em vez de via lista de violações.
    Usado quando o `assign_shots` levanta `SceneStrictCoverageGap` com
    payload `entity=` preenchido.

    Reutiliza a machinery do coverage_plan (queries hierárquicas
    N1→N2→N3, measure_coverage final). `embedder` é OBRIGATÓRIO aqui
    (não tem o default empty-string do `_maybe_targeted_topup`).

    Returns 1 se correu, 0 se a entity não estava no plano / sem deficit.
    """
    if not canonical:
        return 0
    try:
        from studio.matching.coverage_plan import (
            build_query_hierarchy, measure_coverage,
        )
    except ImportError:
        return 0
    key = canonical.strip().lower()
    ent_plan = None
    for e in (plan.ranked_entities or []):
        if (e.canonical_name or "").strip().lower() == key:
            ent_plan = e
            break
    if ent_plan is None or ent_plan.deficit_seconds <= 0:
        return 0
    levels = settings.query_levels - 1 if ent_plan.strict else settings.query_levels
    queries = build_query_hierarchy(
        ent_plan.canonical_name,
        location=ent_plan.location or "",
        entity_type=ent_plan.entity_type,
        features=[],
        levels=levels,
    )
    run_subdir = run_id or "shared"
    dest = (settings.library_root / "downloads" / run_subdir
            / ent_plan.canonical_name.replace(" ", "_"))
    try:
        # P3 (2026-08-11): targeted top-up em produce.py migrado para
        # ingest_asset canónico com state machine + DB verify.
        from studio.library.sources.pexels import sweep
        from studio.library.ingest_asset import ingest_asset
        for q in queries[:1]:
            downloaded = sweep(q, count=3, settings=settings, dest=dest)
            for path, lic in downloaded:
                if not path.exists():
                    continue
                src_url = ((lic or {}).get("source_url", "")
                           if isinstance(lic, dict)
                           else getattr(lic, "source_url", "") or path.name)
                ingest_asset(
                    path, lic, db, settings, embedder,
                    source_id=src_url,
                    video_id=run_id,
                )
        measure_coverage(ent_plan, db)
        ent_plan.deficit_seconds = round(
            max(0.0, ent_plan.target_seconds - ent_plan.available_seconds), 3)
        log.info("_targeted_topup_for_entity: '%s' refreshed (deficit=%.1fs)",
                 canonical, ent_plan.deficit_seconds)
        return 1
    except (OSError, TimeoutError, ConnectionError) as exc:
        log.warning("_targeted_topup_for_entity: '%s' infra falhou (%s)",
                    canonical, exc.__class__.__name__)
        return 0
    except Exception:
        log.exception("_targeted_topup_for_entity: '%s' erro não-recuperável",
                      canonical)
        raise


def _maybe_targeted_topup(strict_violations, plan, db,
                          settings, *, embedder=None, run_id=None) -> int:
    """Para cada entity strict com deficit, dispara UMA ronda extra de
    top-up por entity (não global) só se a violação denuncia
    `generic_for_strict_entity` ou `entity_coverage_gap`.

    FIX-2 (CRÍTICO code-reviewer): except largo foi separado em
    ImportError (módulo top-up não disponível: no-op silencioso) e
    Exception genérica (log.exception + re-raise, NÃO swallow).
    """
    if not strict_violations:
        return 0
    try:
        from studio.matching.coverage_plan import (
            build_query_hierarchy, measure_coverage,
        )
    except ImportError:
        return 0  # módulo genuinely não instalado → no-op OK

    needed: dict[str, dict] = {}
    for v in strict_violations:
        ent = (v.expected_entity or "").strip().lower()
        if not ent:
            continue
        if v.violation_type.value not in (
                "generic_for_strict_entity", "entity_coverage_gap",
                "missing_required_entity"):
            continue
        needed.setdefault(ent, {
            "canonical": v.expected_entity,
            "entity_type": v.expected_entity_type,
        })

    plan_entities = {(e.canonical_name or "").strip().lower(): e
                     for e in plan.ranked_entities}
    touched = 0
    for ent_low, info in needed.items():
        ent_plan = plan_entities.get(ent_low)
        if ent_plan is None or ent_plan.deficit_seconds <= 0:
            continue
        # 1 ronda de top-up dirigida à entity (não via topup_for_plan=
        # — um único entity, queries N1..N3, 1 sweep).
        levels = settings.query_levels - 1 if ent_plan.strict else settings.query_levels
        queries = build_query_hierarchy(
            ent_plan.canonical_name,
            location=ent_plan.location or "",
            entity_type=ent_plan.entity_type,
            features=[],
            levels=levels,
        )
        run_subdir = run_id or "shared"
        dest = (settings.library_root / "downloads" / run_subdir
                / ent_plan.canonical_name.replace(" ", "_"))
        try:
            # P3 (2026-08-11): _maybe_targeted_topup migrado para ingest_asset.
            from studio.library.sources.pexels import sweep
            from studio.library.ingest_asset import ingest_asset
            added = 0
            for q in queries[:1]:
                downloaded = sweep(q, count=3, settings=settings, dest=dest)
                for path, lic in downloaded:
                    if not path.exists():
                        continue
                    src_url = ((lic or {}).get("source_url", "")
                               if isinstance(lic, dict)
                               else getattr(lic, "source_url", "") or path.name)
                    r, _ = ingest_asset(
                        path, lic, db, settings, embedder or embedder,
                        source_id=src_url,
                        video_id=run_id,
                    )
                    added += r.shots_added
            measure_coverage(ent_plan, db)
            ent_plan.deficit_seconds = round(
                max(0.0, ent_plan.target_seconds - ent_plan.available_seconds), 3)
            touched += 1
        except Exception as exc:
            # FIX-2: differentiate between infra failures (log+continue) and
            # programming errors (log+raise). Network/IO errors: continue.
            if isinstance(exc, (OSError, TimeoutError, ConnectionError)):
                log.warning("_maybe_targeted_topup: '%s' infra falhou (%s)",
                            ent_plan.canonical_name, exc.__class__.__name__)
                continue
            log.exception("_maybe_targeted_topup: '%s' erro não-recuperável",
                          ent_plan.canonical_name)
            raise
    return touched


def _params(ctx: RunContext) -> tuple[str, float]:
    topic = ctx.params.get("topic") or ctx.state.topic
    duration = float(ctx.params.get("duration_minutes", 12.0))
    return topic, duration


def _theme_spec(ctx: RunContext) -> ThemeSpec:
    """ThemeSpec do run — retrocompatível com runs sem `theme_spec` em params."""
    spec = ThemeSpec.from_params(ctx.params)
    if not spec.theme:
        topic, duration = _params(ctx)
        spec = ThemeSpec(theme=topic, target_duration_minutes=duration)
    return spec


class S01Topic:
    name = "01_topic"

    def run(self, ctx: RunContext) -> StageResult:
        # Code-reviewer item B: counters de build_mega_script devem ser
        # limpos no início de cada run para os success/fallback counts
        # não acumularem cross-runs (perderiam significado para o
        # dashboard post-Sprint Optimização).
        reset_mega_metrics()
        topic, duration = _params(ctx)
        if not topic:
            return StageResult(status="failed", notes="topic vazio — usa --topic")
        try:
            request_gate(ctx.settings, ctx.state, "topic",
                         f"Aprovar tema do vídeo?\n\n{topic} (~{duration:.0f} min)")
        except GatePending:
            return StageResult(status="waiting_approval", notes="gate: topic")
        out = ctx.stage_dir(self.name) / "topic.json"
        out.write_text(json.dumps({"topic": topic, "duration_minutes": duration},
                                  ensure_ascii=False, indent=2), "utf-8")
        return StageResult(status="done", outputs=[out])


class S02Research:
    name = "02_research"

    def run(self, ctx: RunContext) -> StageResult:
        topic, _ = _params(ctx)
        text, cost = research_pack(topic, ctx.settings)
        out = ctx.stage_dir(self.name) / "research_pack.md"
        out.write_text(text, "utf-8")
        return StageResult(status="done", outputs=[out], cost_usd=cost)


class S03Script:
    name = "03_script"

    def run(self, ctx: RunContext) -> StageResult:
        from studio.library.db import LibraryDB
        from studio.library.inventory import inventory_text

        topic, duration = _params(ctx)
        theme_spec = _theme_spec(ctx)
        d = ctx.stage_dir(self.name)
        research = (ctx.run_dir / "02_research" / "research_pack.md").read_text("utf-8")
        total = 0.0

        # Diagnóstico/observability apenas (item 3): a biblioteca NUNCA
        # condiciona o que o roteiro pode nomear — isso é decidido por
        # research_pack + mandatory_topics. O inventário serve só para o
        # writer priorizar visuais já disponíveis quando editorialmente
        # equivalente, e para estimar dificuldade de aquisição a jusante.
        inventory = inventory_text(LibraryDB(ctx.settings.library_root))
        (d / "visual_inventory.txt").write_text(inventory, "utf-8")

        # Fase 2: outline+draft consolidado em 1 chamada Flash
        # (build_mega_script). Em caso de erro Flash, fallback transparente
        # para Pro multi-pass (build_outline+write_draft) em writer.py.
        outline, draft, c = build_mega_script(topic, research, duration,
                                              ctx.settings,
                                              visual_inventory=inventory,
                                              mandatory_topics=theme_spec.mandatory_topics)
        total += c
        (d / "outline.json").write_text(outline.model_dump_json(indent=2), "utf-8")
        (d / "draft.md").write_text(draft, "utf-8")

        # Code-reviewer item D: snapshot dos contadores in-process
        # build_mega_script → observability para o operador. Sem isto o
        # cost_ledger mostra $X gasto mas o sucesso/fallback Flash vs Pro
        # fica invisível (sem SLO pós-deploy do Sprint Optimização).
        success_n, fallback_n = get_mega_metrics()
        mega_metrics_path = d / "mega_metrics.json"
        mega_metrics_path.write_text(json.dumps({
            "mega_success": success_n,
            "mega_fallback": fallback_n,
            "flash_win_rate": success_n / max(success_n + fallback_n, 1),
        }, ensure_ascii=False, indent=2), "utf-8")

        revised, notes, c = critique_and_revise(draft, ctx.settings)
        total += c
        (d / "critique_notes.json").write_text(
            json.dumps(notes, ensure_ascii=False, indent=2), "utf-8")

        final, c = humanize(revised, ctx.settings)
        total += c
        final = normalize_for_tts(final)
        # Scrub determinístico de frases banidas antes do lint — resolve o
        # caso do fix_lint Flash não conseguir apagar completamente certas
        # locuções (~30% das gerações reais). Custo zero (regex local).
        final = scrub_safety_phrases(final)

        # Gate determinístico anti-slop — 1 passe corretivo, depois fail-closed
        min_words = 0 if ctx.settings.mock_mode else int(duration * 100)
        report = lint(final, min_words=min_words)
        if not report.ok:
            from studio.script.writer import fix_lint_errors

            final, c = fix_lint_errors(final, report.errors, ctx.settings)
            total += c
            final = normalize_for_tts(final)
            final = scrub_safety_phrases(final)
            report = lint(final, min_words=min_words)
        (d / "lint_report.json").write_text(json.dumps(
            {"errors": report.errors, "warnings": report.warnings, "stats": report.stats},
            ensure_ascii=False, indent=2), "utf-8")
        if not report.ok:
            return StageResult(status="failed", cost_usd=total,
                               notes=f"lint falhou (pós-correção): {report.errors}")

        # Item 3: validação determinística de mandatory_topics — 1 passe
        # corretivo, depois fail-closed. A biblioteca nunca entra nesta
        # decisão (ver comentário acima sobre visual_inventory).
        from studio.script.validate_topics import find_missing_topics

        missing_before = find_missing_topics(final, theme_spec.mandatory_topics)
        missing_after = missing_before
        if missing_before:
            from studio.script.writer import fix_missing_topics

            final, c = fix_missing_topics(final, missing_before, ctx.settings)
            total += c
            final = normalize_for_tts(final)
            final = scrub_safety_phrases(final)
            missing_after = find_missing_topics(final, theme_spec.mandatory_topics)
        topics_report_path = d / "mandatory_topics_report.json"
        topics_report_path.write_text(json.dumps({
            "mandatory_topics": theme_spec.mandatory_topics,
            "missing_before_corrective_pass": missing_before,
            "missing_after_corrective_pass": missing_after,
        }, ensure_ascii=False, indent=2), "utf-8")
        if missing_after:
            return StageResult(status="failed", cost_usd=total,
                               outputs=[topics_report_path],
                               notes=f"mandatory_topics ausentes após corrective pass: "
                                     f"{missing_after}")

        script_md = d / "script.md"
        script_md.write_text(final, "utf-8")
        emit_event(ctx.run_dir, ctx.video_id, self.name, "script_generated",
                  f"{report.stats.get('words', 0)} palavras",
                  payload={"words": report.stats.get("words", 0),
                          "cost_usd": total})
        emit_event(ctx.run_dir, ctx.video_id, self.name, "topics_validated",
                  f"{len(theme_spec.mandatory_topics)} mandatory_topics "
                  f"cobertos", payload={"mandatory_topics":
                                       theme_spec.mandatory_topics})

        # Code-reviewer final: mega_metrics.json listado em outputs (não só
        # side-file) para o orchestrator propagar para state.json do run
        # → dashboard do operador vê o flash_win_rate sem globbing manual.
        outputs = [script_md, mega_metrics_path, topics_report_path]

        if ctx.params.get("gate_script"):
            try:
                request_gate(ctx.settings, ctx.state, "script",
                             f"Aprovar roteiro? ({report.stats['words']} palavras)\n\n"
                             f"{final[:800]}…")
            except GatePending:
                return StageResult(status="waiting_approval", cost_usd=total,
                                   outputs=outputs,
                                   notes="gate: script")
        return StageResult(status="done", outputs=outputs, cost_usd=total)


class S04Tts:
    name = "04_tts"

    def run(self, ctx: RunContext) -> StageResult:
        from studio.audio.tts_client import synthesize

        script = (ctx.run_dir / "03_script" / "script.md").read_text("utf-8")
        out = ctx.stage_dir(self.name) / "narration.wav"
        duration = synthesize(script, out, ctx.settings)
        meta = ctx.stage_dir(self.name) / "audio_meta.json"
        meta.write_text(json.dumps({"duration_seconds": duration}), "utf-8")
        return StageResult(status="done", outputs=[out, meta])


class S05Timestamps:
    name = "05_timestamps"

    def run(self, ctx: RunContext) -> StageResult:
        from studio.audio.whisper import transcribe_words

        script = (ctx.run_dir / "03_script" / "script.md").read_text("utf-8")
        audio = ctx.run_dir / "04_tts" / "narration.wav"
        words = transcribe_words(audio, ctx.settings, script_text=script)
        if not words:
            return StageResult(status="failed", notes="0 palavras transcritas")
        out = ctx.stage_dir(self.name) / "words.json"
        out.write_text(json.dumps(words, ensure_ascii=False), "utf-8")
        return StageResult(status="done", outputs=[out])


class S06Scenes:
    """Fase A: extrai entidades do roteiro + alinha timestamps antes de segmentar.

    Artefactos em 06_scenes/:
      - entity_mentions.json    (todas as menções estruturadas)
      - entity_spans.json       (menções alinhadas a janelas de áudio)
      - scenes.json             (lista Scene, igual à versão anterior)
    """
    name = "06_scenes"

    def run(self, ctx: RunContext) -> StageResult:
        from studio.script.entities import (
            align_timestamps, extract_entities, write_artifacts,
        )

        script = (ctx.run_dir / "03_script" / "script.md").read_text("utf-8")
        words = json.loads((ctx.run_dir / "05_timestamps" / "words.json").read_text("utf-8"))
        outline_path = ctx.run_dir / "03_script" / "outline.json"
        outline = Outline.model_validate_json(outline_path.read_text("utf-8")) \
            if outline_path.exists() else None
        research_path = ctx.run_dir / "02_research" / "research_pack.md"
        research = research_path.read_text("utf-8") if research_path.exists() else ""

        d = ctx.stage_dir(self.name)
        total = 0.0

        # Fase A — extracção de entidades (Gemini Flash 1× ou mock determinístico)
        mentions, c_ext = extract_entities(script, research, ctx.settings)
        total += c_ext
        # alinhamento determinístico (sem LLM) contra words.json
        spans = align_timestamps(mentions, words)
        p_mentions, p_spans = write_artifacts(d, mentions, spans)

        # Fase B — segmentação entity-aware: Scene herda primary_entity do
        # entity_span dominante no intervalo. Mudança de entity strict
        # FECHA cena mesmo sem pausa.
        scenes = segment_scenes(script, words, outline,
                                entity_spans=spans or None)
        if not scenes:
            return StageResult(status="failed",
                               notes="segmentação produziu 0 cenas",
                               outputs=[p_mentions, p_spans], cost_usd=total)
        out = d / "scenes.json"
        out.write_text(json.dumps([s.model_dump() for s in scenes],
                                  ensure_ascii=False, indent=2), "utf-8")
        return StageResult(status="done",
                           outputs=[p_mentions, p_spans, out],
                           cost_usd=total,
                           notes=f"{len(scenes)} cenas · "
                                 f"{len(spans)}/{len(mentions)} entidades alinhadas")


class S07Briefs:
    name = "07_briefs"

    def run(self, ctx: RunContext) -> StageResult:
        from studio.matching.briefs import build_briefs
        from studio.script.scenes import Scene

        scenes = [Scene.model_validate(s) for s in json.loads(
            (ctx.run_dir / "06_scenes" / "scenes.json").read_text("utf-8"))]
        briefs, cost = build_briefs(scenes, ctx.settings)
        out = ctx.stage_dir(self.name) / "briefs.json"
        out.write_text(json.dumps([b.model_dump() for b in briefs],
                                  ensure_ascii=False, indent=2), "utf-8")
        return StageResult(status="done", outputs=[out], cost_usd=cost)


class S08Matching:
    name = "08_matching"

    def run(self, ctx: RunContext) -> StageResult:
        from studio.library.db import LibraryDB
        from studio.matching.assigner import assign_shots
        from studio.matching.briefs import VisualBrief
        from studio.matching.coverage_plan import write_plan
        from studio.script.entities import EntitySpan
        from studio.script.scenes import Scene

        # item N (closure pass): 1 chamada barata ANTES de qualquer
        # confirmação Vision/aquisição — descobrir uma credencial inválida
        # cedo é muito mais barato do que descobrir a meio de N cenas
        # strict (cada uma já fail-fast em metadata.py, mas só depois de
        # muito trabalho de scene/coverage já feito).
        from studio.library.gemini_preflight import preflight_gemini_credentials
        cred_ok, cred_reason = preflight_gemini_credentials(ctx.settings)
        if not cred_ok:
            emit_event(ctx.run_dir, ctx.video_id, self.name,
                      "credentials_invalid", cred_reason, level="ERROR")
            return StageResult(
                status="failed",
                notes=f"S08 abortou antes de iniciar (fail-fast, item N): "
                      f"{cred_reason}",
            )

        scenes = [Scene.model_validate(s) for s in json.loads(
            (ctx.run_dir / "06_scenes" / "scenes.json").read_text("utf-8"))]
        briefs = [VisualBrief.model_validate(b) for b in json.loads(
            (ctx.run_dir / "07_briefs" / "briefs.json").read_text("utf-8"))]
        d = ctx.stage_dir(self.name)

        # Fase C — Coverage Plan primeiro: ranking + measure + queries
        # hierárquicas ANTES do matching. Cada entity recebe:
        # required_seconds, target_seconds (buffer 1.25×), available_seconds,
        # deficit_seconds, queries. Artefacto consumido por top-up (Fase D)
        # e pelo alignment validator (Fase G).
        topic = (ctx.state.topic or ctx.params.get("topic", ""))
        spans_path = ctx.run_dir / "06_scenes" / "entity_spans.json"
        if spans_path.exists():
            # FIX-Pipeline-resume: S06Scenes.write_artifacts() guarda
            # `{"spans": [...]}` (envelope com chave). Antes desta fase o
            # reader iterava o envelope dict e processava 'spans' como
            # string → Pydantic error "model_type". Agora extraímos
            # `data["spans"]` (ou aceitamos lista crua, retro-compatível).
            raw = json.loads(spans_path.read_text("utf-8"))
            spans_payload = (raw.get("spans", [])
                             if isinstance(raw, dict) else raw)
            spans = [EntitySpan.model_validate(s) for s in spans_payload]
        else:
            spans = []  # run legacy sem Fase A → plano vazio

        embedder = ctx.params.get("_embedder")
        if embedder is None:
            from studio.library.embed import SiglipEmbedder

            embedder = SiglipEmbedder()
        db = LibraryDB(ctx.settings.library_root)

        # item B (closure pass): S08 vivo passa a usar o workset genérico
        # (build_workset/load_workset_context) em vez de chamar
        # build_coverage_plan directamente sem scenes/include_filler —
        # workset_builder já invoca build_coverage_plan(scenes=...,
        # include_filler=True) internamente e persiste o resultado em
        # data/library/worksets/<workset_id>/ (SSoT partilhada com
        # reconcile.py/discovery.py).
        from studio.library.workset_builder import (
            MandatoryTopicUnresolvedError,
            build_workset,
        )
        from studio.library.workset_context import (
            MODE_WORKFLOW,
            load_workset_context,
        )
        script_path = ctx.run_dir / "03_script" / "script.md"
        script_text = script_path.read_text("utf-8") if script_path.exists() else ""
        theme_spec = _theme_spec(ctx)
        try:
            workset_result = build_workset(
                theme_spec, script_text, scenes, spans, db, ctx.settings,
                workset_id=ctx.video_id,
            )
        except MandatoryTopicUnresolvedError as exc:
            # item D: fail-closed — tópico obrigatório do operador não
            # aparece em NENHUMA Scene do script. S09/S10 não podem
            # arrancar sem que isto seja resolvido a montante (roteiro).
            return StageResult(
                status="failed",
                notes=f"mandatory_topics sem cobertura em nenhuma Scene "
                      f"(fail-closed, item D): {exc.topics}",
            )
        plan = workset_result.plan
        workset_ctx = load_workset_context(
            workflow_id=workset_result.workset_id,
            workset_dir=workset_result.workset_dir,
            embedder=embedder, mode=MODE_WORKFLOW,
        )
        write_plan(plan, d / "coverage_plan.json")
        log.info("workset=%s (reused=%s, ready=%s): %d entities (top=%s)",
                 workset_result.workset_id, workset_result.reused,
                 workset_result.is_workset_ready, len(plan.ranked_entities),
                 plan.ranked_entities[0].canonical_name if plan.ranked_entities else "—")
        emit_event(ctx.run_dir, ctx.video_id, self.name, "workset_created",
                  f"workset={workset_result.workset_id} (reused="
                  f"{workset_result.reused}) — {len(plan.ranked_entities)} "
                  f"requirements",
                  payload={"workset_id": workset_result.workset_id,
                           "reused": workset_result.reused,
                           "n_requirements": len(plan.ranked_entities)})

        # item 1.5 (automation closure): QueryHistory canónico — UMA
        # instância por run, partilhada por TODO o caminho de aquisição
        # (não repete queries vazias/erradas entre waves).
        from studio.library.requirement_index import QueryHistory, RequirementIndex
        ri = RequirementIndex(db)
        qh = QueryHistory(db)

        # item E/G (closure pass): biblioteca global EXISTENTE primeiro —
        # popula a RequirementIndex com o que a biblioteca já tem (sem
        # re-embed: vectores já armazenados) ANTES de qualquer decisão de
        # aquisição. Depois, remede cada entity via RequirementIndex
        # (matches semanticamente filtrados) em vez do scan CSV por
        # substring — quando a index já tem matches; caso contrário
        # measure_coverage_from_index devolve False e a medida do
        # scan CSV (já feita dentro de build_workset) fica como está.
        from studio.library.requirement_matching import (
            index_existing_shots_against_workset,
        )
        from studio.matching.coverage_plan import (
            is_workset_ready,
            measure_coverage_from_index,
        )

        def _index_existing() -> None:
            stats = index_existing_shots_against_workset(workset_ctx, db, ri)
            log.info("workset=%s: indexed existing library (scanned=%d, "
                     "matches=%d)", workset_result.workset_id,
                     stats["shots_scanned"], stats["matches_written"])
            for ent in plan.ranked_entities:
                if measure_coverage_from_index(ent, workset_ctx, ri, db):
                    ent.deficit_seconds = round(
                        max(0.0, ent.target_seconds - ent.available_seconds), 3)

        _index_existing()

        # Pass 3: cache_prune_by_ttl cleanup periódico no fim de S08.
        # Rows mais antigas que Settings.negative_cache_ttl_days (default
        # 90) são apagadas; restantes ficam intactas. Fail-soft: não
        # bloqueia S08 se LanceDB .delete() não estiver disponível.
        try:
            ttl_days = int(getattr(ctx.settings, "negative_cache_ttl_days",
                                   90) or 90)
            pruned = db.cache_prune_by_ttl(ttl_days)
            if pruned > 0:
                log.info("cache_prune: %d rows removidas (TTL=%dd)",
                         pruned, ttl_days)
        except Exception as exc:
            log.debug("cache_prune_by_ttl falhou (não fatal): %s",
                      exc.__class__.__name__)

        # Fase E — strict_only wiring: cenas com brief.strict_entity=True
        # DEVEM ter confirmação visual antes do assign (lazy confirm); cenas
        # não-strict usam B-roll genérico do Phase C. Confirmação Vision
        # sobre a biblioteca ATUAL (sem rede) — item 14: doutrina trata
        # "progressive local strict confirmation" como parte da preparação
        # da biblioteca, não do matching; corre ANTES do gate (informa a
        # cobertura REAL) e é re-invocada depois de cada wave de aquisição
        # (helper reusável, ver `_run_strict_confirmation` abaixo).
        from studio.library.confirmation import require_entity_confirmation
        warmup_top_k = max(1, int(getattr(ctx.settings,
                                          "s08_warmup_top_k", 4) or 4))
        # item 13: o retorno de require_entity_confirmation() era descartado
        # — confirmed_entities nunca chegava a assign_shots (default None),
        # o gate estrito da Fase F ficava sempre dormant em produção.
        # Construído aqui e passado a TODAS as chamadas de assign_shots
        # abaixo (v1 + todas as rondas de repair).
        confirmed_entities: dict[str, list[dict]] = {}

        def _run_strict_confirmation() -> None:
            for ent in plan.ranked_entities:
                if not ent.strict:
                    continue
                try:
                    # item K/L: progressivo (para assim que target_seconds/
                    # min_distinct_shots forem atingidos — nunca todos os
                    # candidatos numa só chamada) + sync real com a
                    # RequirementIndex (já populada pelo E/G acima).
                    _spec = workset_ctx.req_by_canonical(ent.canonical_name)
                    confirmed = require_entity_confirmation(
                        ent.canonical_name, ent.entity_type, db, ctx.settings,
                        top_k=warmup_top_k, strict_only=True,
                        target_seconds=ent.target_seconds,
                        min_distinct_shots=ent.min_distinct_shots,
                        requirement_id=(_spec.requirement_id if _spec else None),
                        workset_id=workset_ctx.workset_id,
                        requirement_index=ri,
                    )
                    if confirmed:
                        confirmed_entities[ent.canonical_name.strip().lower()] = confirmed
                except (TimeoutError, KeyError, ValueError) as exc:
                    # narrow: S08 não pode bloquear por Vision API fora do ar
                    # nem por schema inválido do meta_json cache pre-Fase E
                    log.warning("warm-up confirmação '%s' falhou: %s — "
                                "strict_only wired (aviso, run prossegue)",
                                ent.canonical_name,
                                exc.__class__.__name__)

        _run_strict_confirmation()
        emit_event(ctx.run_dir, ctx.video_id, self.name,
                  "strict_confirmation_batch",
                  f"{len(confirmed_entities)} entities strict com candidatos "
                  f"confirmados", payload={"n_confirmed": len(confirmed_entities)})

        def _measure_ready():
            confirmed_index_for_gate = {
                canon: [row.get("shot_id") for row in rows if row.get("shot_id")]
                for canon, rows in confirmed_entities.items()
            }
            return is_workset_ready(
                plan, db, ctx.settings, confirmed_index=confirmed_index_for_gate,
                remeasure=False,
            )

        def _covered_deficits_msg(per_status: dict[str, str]) -> tuple[int, str]:
            covered_n = sum(1 for v in per_status.values() if v == "COVERED")
            deficits_msg = ", ".join(
                f"{name}={status}" for name, status in per_status.items()
                if status != "COVERED"
            ) or "sem detalhe"
            return covered_n, deficits_msg

        # item 1.3/1.6 (automation closure): gate ANTES de qualquer
        # aquisição externa — antes, `topup_for_plan_concurrent` corria
        # incondicionalmente aqui, sempre ANTES da decisão humana. Agora:
        # medimos prontidão real primeiro; só chamamos o AcquisitionService
        # (item O — único caminho de aquisição em produção) depois de
        # `auto_acquire_library=True` OU aprovação humana explícita
        # ("acquire", nunca "continuar incompleto" — item 1.6). W é
        # consequência directa: qualquer StageResult que não seja "done"
        # impede o PipelineRunner de avançar para S09.
        ready_for_gate, per_status_gate, _ = _measure_ready()
        _cov_n, _cov_msg = _covered_deficits_msg(per_status_gate)
        emit_event(ctx.run_dir, ctx.video_id, self.name, "library_coverage",
                  f"{_cov_n}/{len(per_status_gate)} requirements cobertos",
                  progress=(_cov_n / len(per_status_gate)) if per_status_gate else None,
                  payload={"covered": _cov_n, "total": len(per_status_gate),
                          "ready": ready_for_gate, "deficits": _cov_msg})
        if not ready_for_gate:
            covered_n, deficits_msg = _covered_deficits_msg(per_status_gate)
            do_acquire = bool(ctx.params.get("auto_acquire_library"))
            if not do_acquire:
                try:
                    # options= omitido: default ["approve","reject"] —
                    # mesmo vocabulário CLI dos outros 3 gates (topic/
                    # script/final; `studio approve <id> <gate>
                    # approve|reject`, argparse `choices=` fixo). O que
                    # muda é a SEMÂNTICA (pergunta + comportamento), não o
                    # nome dos botões: "approve" aqui significa "autorizar
                    # aquisição", nunca "continuar incompleto" (item 1.6).
                    request_gate(
                        ctx.settings, ctx.state, "library",
                        f"Biblioteca insuficiente para '{ctx.state.topic}' "
                        f"({covered_n}/{len(per_status_gate)} requirements "
                        f"cobertos). Deficits: {deficits_msg}. Deseja "
                        f"buscar os assets em falta?",
                    )
                    do_acquire = True  # aprovado -> dispara aquisição abaixo
                except GatePending:
                    return StageResult(
                        status="waiting_approval",
                        outputs=[d / "coverage_plan.json"],
                        notes=f"gate: library ({covered_n}/"
                              f"{len(per_status_gate)} cobertos — {deficits_msg})",
                    )
                except GateRejected:
                    return StageResult(
                        status="failed",
                        outputs=[d / "coverage_plan.json"],
                        notes=f"operador cancelou aquisição de biblioteca "
                              f"({covered_n}/{len(per_status_gate)} "
                              f"cobertos — {deficits_msg})",
                    )

            if do_acquire:
                from studio.library.acquisition import run_acquisition_for_workset
                max_waves = max(1, int(getattr(
                    ctx.settings, "acquisition_max_waves", 3) or 3))
                for wave in range(max_waves):
                    emit_event(ctx.run_dir, ctx.video_id, self.name,
                              "provider_download_started",
                              f"acquisition wave {wave + 1}/{max_waves}",
                              payload={"wave": wave + 1, "max_waves": max_waves})
                    acq_rep = run_acquisition_for_workset(
                        plan, workset_ctx, db, embedder, ctx.settings,
                        requirement_index=ri, query_history=qh,
                    )
                    # item U: media nova entra no workset com matches
                    # REAIS (idempotente via upsert_match).
                    _index_existing()
                    _run_strict_confirmation()
                    ready_for_gate, per_status_gate, _ = _measure_ready()
                    log.info("acquisition wave %d/%d: coverage_ready=%s "
                             "downloads=%d", wave + 1, max_waves,
                             acq_rep.coverage_ready, acq_rep.downloads_succeeded)
                    emit_event(ctx.run_dir, ctx.video_id, self.name,
                              "provider_download_completed",
                              f"wave {wave + 1}: {acq_rep.downloads_succeeded} "
                              f"downloads, coverage_ready={ready_for_gate}",
                              payload={"wave": wave + 1,
                                      "downloads_succeeded": acq_rep.downloads_succeeded,
                                      "coverage_ready": ready_for_gate})
                    if ready_for_gate:
                        emit_event(ctx.run_dir, ctx.video_id, self.name,
                                  "workset_ready", "biblioteca completa")
                        break
                if not ready_for_gate:
                    covered_n, deficits_msg = _covered_deficits_msg(per_status_gate)
                    return StageResult(
                        status="failed",
                        outputs=[d / "coverage_plan.json"],
                        notes=f"aquisição esgotada sem WORKSET_READY "
                              f"({covered_n}/{len(per_status_gate)} "
                              f"cobertos, {max_waves} waves): {deficits_msg}",
                    )
        else:
            emit_event(ctx.run_dir, ctx.video_id, self.name, "workset_ready",
                      "biblioteca já completa (sem aquisição necessária)")

        # Fase G — Entity Alignment Validator + Repair Loop (ARCHITECTURE §1.8)
        # 1ª passagem: assign_shots como antes. Se utilizador pediu keep_v1,
        # gravamos cópia para auditoria antes de qualquer repair.
        excluded_shots: set[str] = set()
        repair_log: list[dict] = []
        result = None  # preenchido na 1ª ronda
        alignment_report = None
        last_exception: Exception | None = None

        max_repair = max(0, int(getattr(
            ctx.settings, "alignment_max_repair_rounds", 2) or 2))
        min_repair = max(1, int(getattr(
            ctx.settings, "alignment_min_rounds_in_repair", 1) or 1))
        keep_v1 = bool(getattr(
            ctx.settings, "alignment_keep_assignment_v1", True))

        # FIX-4 (ALTO code-reviewer): resume-friendly — assignments_v1.json
        # NÃO é reescrito se já existir em disco. Permite `studio resume`
        # avançar sem perder histórico da primeira passagem.
        v1_path = d / "assignments_v1.json"
        v1_exists_already = v1_path.exists() and keep_v1

        # 1ª passagem — v1. FIX-reviewer-MUST-HAVE: se V1 levanta
        # SceneStrictCoverageGap NÃO abortamos o loop — o repair loop
        # recebe a entity do payload da excepção (last_exception) e tenta
        # `_targeted_topup_for_entity` antes de desistir.
        from studio.matching.assigner import SceneStrictCoverageGap
        try:
            result = assign_shots(
                scenes, briefs, db, embedder, ctx.settings,
                run_id=ctx.video_id, topic=ctx.state.topic,
                coverage_plan=plan,
                excluded_shot_ids=excluded_shots or None,
                confirmed_entities=confirmed_entities,
                allow_network_topup=False,  # item O/X: aquisicao ja correu antes (V)
            )
            _attach_segment_metadata(result.segments, db)
            if keep_v1 and not v1_exists_already:
                v1_path.write_text(
                    result.model_dump_json(indent=2), "utf-8")
            repair_log.append({
                "round": 0,
                "phase": "v1",
                "excluded_before": 0,
                "unfilled_scenes": list(result.unfilled_scenes),
            })
        except SceneStrictCoverageGap as exc:
            # V1 SCG: NÃO vamos a break imediato. O repair loop,
            # quando `result is None`, vê `last_exception` (SCG) e
            # tenta `_targeted_topup_for_entity` com payload da exception.
            last_exception = exc
            log.warning("S08 (v1): assign_shots = SceneStrictCoverageGap "
                        "(entity=%s, deficit=%ss) — repair loop tentará "
                        "recuperar via targeted top-up.",
                        getattr(exc, "entity", "?"),
                        getattr(exc, "deficit_seconds", 0.0))
            repair_log.append({
                "round": 0,
                "phase": "v1",
                "status": "scg_gap",
                "entity": getattr(exc, "entity", "") or "",
                "entity_type": getattr(exc, "entity_type", "") or "",
                "deficit_seconds": getattr(exc, "deficit_seconds", 0.0),
            })
        except Exception as exc:
            last_exception = exc
            log.warning("S08 (v1): assign_shots levantou %s — repair "
                        "loop tentará recuperar", exc.__class__.__name__)

        # Repair loop — até max_repair rondas com strict_violations OU gaps.
        from studio.matching.alignment import (
            AlignmentReport, validate_alignment, write_report,
        )

        for rnd in range(1, max_repair + 1):
            # FIX-reviewer-MUST-HAVE: se V1 = SCG (result=None mas
            # last_exception é SCG), fazer 1 ronda de top-up targeted da
            # entity em falta e re-tentar assign_shots. Recuperação
            # transparente antes de desistir.
            if result is None:
                if isinstance(last_exception, SceneStrictCoverageGap):
                    miss_ent = (getattr(last_exception, "entity", "") or "").strip()
                    miss_type = getattr(last_exception, "entity_type", "") or ""
                    if miss_ent:
                        try:
                            targeted_count = _targeted_topup_for_entity(
                                miss_ent, miss_type,
                                plan, db, ctx.settings,
                                embedder=embedder, run_id=ctx.video_id,
                            )
                        except Exception as exc:
                            log.warning("S08 repair V1 SCG: targeted "
                                        "top-up '%s' falhou (%s)",
                                        miss_ent, exc.__class__.__name__)
                            targeted_count = 0
                        repair_log.append({
                            "round": rnd, "phase": "v1_scg_topup",
                            "entity": miss_ent,
                            "topups": targeted_count,
                        })
                        if targeted_count > 0:
                            try:
                                result = assign_shots(
                                    scenes, briefs, db, embedder,
                                    ctx.settings,
                                    run_id=ctx.video_id,
                                    topic=ctx.state.topic,
                                    coverage_plan=plan,
                                    excluded_shot_ids=excluded_shots,
                                    confirmed_entities=confirmed_entities,
                                    allow_network_topup=False,  # item O/X: aquisicao ja correu antes (V)
                                )
                                _attach_segment_metadata(result.segments, db)
                                repair_log.append({
                                    "round": rnd,
                                    "phase": "after_v1_scg_topup",
                                    "status": "recovered",
                                })
                            except SceneStrictCoverageGap as exc3:
                                last_exception = exc3
                                repair_log.append({
                                    "round": rnd, "entity": miss_ent,
                                    "status": "gap_persistent_after_topup",
                                    "error": exc3.__class__.__name__,
                                })
                                break
                        else:
                            break
                    else:
                        break
                # não-SCG exception em V1 → fail-closed via reporting abaixo
                break
            alignment_report = validate_alignment(
                scenes=scenes, briefs=briefs, segments=result.segments,
                entity_spans=spans, coverage_plan=plan,
                settings=ctx.settings,
            )
            strict_v = alignment_report.strict_violations
            if not strict_v:
                break
            if rnd < min_repair:
                pass
            new_excluded = {v.shot_id for v in strict_v if v.shot_id}
            if not new_excluded or new_excluded.issubset(excluded_shots):
                log.info("S08 repair: ronda %d não encontra novos shots "
                         "a excluir — parando", rnd)
                break
            excluded_shots.update(new_excluded)

            try:
                # BUG CORRIGIDO (item 14): assinatura é (strict_violations,
                # plan, db, settings, *, embedder, run_id) — 4 posicionais.
                # A chamada antiga passava 5 posicionais (embedder duplicado
                # como db/settings deslizavam), TypeError sempre engolido
                # pelo except abaixo — este top-up NUNCA corria em produção.
                _maybe_targeted_topup(
                    strict_v, plan, db, ctx.settings,
                    embedder=embedder, run_id=ctx.video_id,
                )
            except Exception as exc:
                log.warning("S08 repair: targeted top-up falhou (%s) — "
                            "prosseguimos sem", exc.__class__.__name__)

            try:
                result = assign_shots(
                    scenes, briefs, db, embedder, ctx.settings,
                    run_id=ctx.video_id, topic=ctx.state.topic,
                    coverage_plan=plan,
                    excluded_shot_ids=excluded_shots,
                    confirmed_entities=confirmed_entities,
                    allow_network_topup=False,  # item O/X: aquisicao ja correu antes (V)
                )
                _attach_segment_metadata(result.segments, db)
                repair_log.append({
                    "round": rnd,
                    "excluded_before": len(excluded_shots),
                    "excluded_added": len(new_excluded),
                    "unfilled_scenes": list(result.unfilled_scenes),
                    "topups": 0,
                    "status": "ok",
                })
            except SceneStrictCoverageGap as exc:
                # FIX-3 + FIX-reviewer-#1: a exception sabe qual é a entity em
                # falta. Disparar UM top-up targeted EXTRA dessa entity antes
                # de desistir; se ainda sem cobertura, fail-closed.
                # IMPORTANTE: usamos `_targeted_topup_for_entity(canonical,
                # type, ...)` que aceita o payload da excepção DIRECTAMENTE
                # (não via lista de violações — a versão antiga passava
                # uma lista vazia e nunca disparava o top-up).
                last_exception = exc
                missing_entity = (getattr(exc, "entity", "") or "").strip()
                missing_entity_type = getattr(exc, "entity_type", "") or ""
                repair_log.append({
                    "round": rnd,
                    "excluded_before": len(excluded_shots),
                    "excluded_added": len(new_excluded),
                    "error": exc.__class__.__name__,
                    "entity": missing_entity,
                    "entity_type": missing_entity_type,
                    "status": "gap_detected",
                    "deficit_seconds": getattr(exc, "deficit_seconds", 0.0),
                })
                if missing_entity:
                    try:
                        targeted_count = _targeted_topup_for_entity(
                            missing_entity, missing_entity_type,
                            plan, db, ctx.settings,
                            embedder=embedder, run_id=ctx.video_id,
                        )
                        if targeted_count > 0:
                            # re-call uma vez mais após top-up targeted
                            try:
                                result = assign_shots(
                                    scenes, briefs, db, embedder, ctx.settings,
                                    run_id=ctx.video_id,
                                    topic=ctx.state.topic,
                                    coverage_plan=plan,
                                    excluded_shot_ids=excluded_shots,
                                    confirmed_entities=confirmed_entities,
                                    allow_network_topup=False,  # item O/X: aquisicao ja correu antes (V)
                                )
                                _attach_segment_metadata(result.segments, db)
                                repair_log.append({
                                    "round": rnd,
                                    "phase": "after_gap_topup",
                                    "topups": targeted_count,
                                    "status": "recovered",
                                })
                            except SceneStrictCoverageGap as exc3:
                                # persistiu gap após top-up
                                last_exception = exc3
                                repair_log.append({
                                    "round": rnd, "entity": missing_entity,
                                    "status": "gap_persistent_after_topup",
                                    "error": exc3.__class__.__name__,
                                })
                                break
                        else:
                            # top-up não correu (sem Pexels key / sem GPU /
                            # sem infra); fail-closed
                            repair_log.append({
                                "round": rnd, "entity": missing_entity,
                                "status": "topup_no_op",
                            })
                            break
                    except Exception as exc2:
                        last_exception = exc2
                        log.warning("S08 repair ronda %d: top-up targeted "
                                    "para '%s' não recuperou (%s)",
                                    rnd, missing_entity or "?",
                                    exc2.__class__.__name__)
                        repair_log.append({
                            "round": rnd, "entity": missing_entity,
                            "status": "gap_persistent_after_topup",
                            "error": exc2.__class__.__name__,
                        })
                        break
                else:
                    # sem entity no payload → fail-closed imediato
                    break
            except Exception as exc:
                last_exception = exc
                log.warning("S08 repair: ronda %d — assign_shots levantou "
                            "%s (entity=%s). Gap persistente.",
                            rnd, exc.__class__.__name__,
                            getattr(exc, "entity", "?"))
                repair_log.append({
                    "round": rnd,
                    "excluded_before": len(excluded_shots),
                    "excluded_added": len(new_excluded),
                    "error": exc.__class__.__name__,
                    "entity": getattr(exc, "entity", ""),
                    "status": "gap_persistent",
                })
                break

        # FIX-reviewer regression: artefacts de auditoria (alignment_report +
        # repair_log) SEMPRE devem ser escritos, mesmo quando result is None
        # (fail-closed). Caso contrário o resume pode perder histórico e o
        # operador não tem visibilidade do que aconteceu.
        if result is not None and alignment_report is None:
            alignment_report = validate_alignment(
                scenes=scenes, briefs=briefs, segments=result.segments,
                entity_spans=spans, coverage_plan=plan, settings=ctx.settings,
            )

        # item B (closure pass): coverage.json REAL do workset — reflecte o
        # que foi de facto confirmado nesta run (não o scaffold vazio do
        # build_workset inicial). confirmed_index vem do warm-up de Fase E
        # (canon_lower -> [shot_id, ...]).
        from studio.matching.coverage_plan import write_workset_readiness
        confirmed_index = {
            canon: [row.get("shot_id") for row in rows if row.get("shot_id")]
            for canon, rows in confirmed_entities.items()
        }
        try:
            write_workset_readiness(
                plan, db, ctx.settings,
                workset_result.workset_dir / "coverage.json",
                confirmed_index=confirmed_index, remeasure=False,
            )
        except Exception as exc:
            log.warning("S08: write_workset_readiness final falhou (não "
                        "fatal, coverage.json fica no estado do build "
                        "inicial): %s", exc.__class__.__name__)

        # item I/J (closure pass): allocação REAL de shots por requirement
        # (nunca mais o scaffold vazio `{"by_entity": {}}`) + selection
        # feasibility — a mesma cobertura medida pode ser inatingível na
        # prática se dois requirements dependessem do MESMO shot; o
        # allocator greedy garante que cada shot só é usado uma vez.
        try:
            from studio.library.selection import allocate_shots
            alloc = allocate_shots(plan, workset_ctx, ri)
            by_canonical: dict[str, list[str]] = {}
            for ent in plan.ranked_entities:
                spec = workset_ctx.req_by_canonical(ent.canonical_name)
                by_canonical[ent.canonical_name] = (
                    alloc.by_requirement.get(spec.requirement_id, [])
                    if spec is not None else [])
            (workset_result.workset_dir / "selected_shots.json").write_text(
                json.dumps({
                    "schema_version": "1.0",
                    "workset_id": workset_result.workset_id,
                    "selection_policy": "greedy: strict CONFIRMED > "
                        "core NOT_REQUIRED/CONFIRMED > filler; "
                        "sem reuso de shot_id; cap por media_sha",
                    "selection_feasible": alloc.selection_feasible,
                    "by_entity": by_canonical,
                }, ensure_ascii=False, indent=2), "utf-8")
            cov_path = workset_result.workset_dir / "coverage.json"
            cov_doc = json.loads(cov_path.read_text("utf-8"))
            cov_doc["selection_feasible"] = alloc.selection_feasible
            cov_doc["overall_ready"] = bool(
                cov_doc.get("is_workset_ready")) and alloc.selection_feasible
            cov_path.write_text(
                json.dumps(cov_doc, ensure_ascii=False, indent=2), "utf-8")
        except Exception as exc:
            log.warning("S08: allocate_shots falhou (não fatal, "
                        "selected_shots.json fica no estado anterior): %s",
                        exc.__class__.__name__)

        # Escreve repair_log.json SEMPRE (audit trail) — mesmo em fail-closed.
        (d / "repair_log.json").write_text(
            json.dumps(repair_log, ensure_ascii=False, indent=2), "utf-8")

        # Validação final: se result é None (fail-closed via exception), ainda
        # escreve alignment_report.json vazio se não foi computado.
        if result is None:
            if alignment_report is None:
                alignment_report = AlignmentReport(
                    total_segments=0, total_strict_scenes=0,
                    summary={
                        "total_violations": 0,
                        "strict_violations": 0,
                        "warnings": 0,
                        "fail_closed_reason": str(last_exception.__class__.__name__
                                                  if last_exception else "Exception"),
                    },
                )
            write_report(alignment_report, d / "alignment_report.json")
            return StageResult(
                status="failed",
                outputs=[d / "coverage_plan.json",
                         d / "alignment_report.json",
                         d / "repair_log.json"],
                notes=f"S08 falhou: assign_shots levantou "
                      f"{last_exception.__class__.__name__ if last_exception else 'Exception'}",
                cost_usd=0.0,
            )

        write_report(alignment_report, d / "alignment_report.json")
        out = d / "assignments.json"
        out.write_text(result.model_dump_json(indent=2), "utf-8")

        # Fail-closed estrito:
        if alignment_report.has_unresolved_strict:
            strict_n = len(alignment_report.strict_violations)
            kinds: dict[str, int] = {}
            for v in alignment_report.strict_violations:
                kinds[v.violation_type.value] = kinds.get(
                    v.violation_type.value, 0) + 1
            return StageResult(
                status="failed",
                outputs=[
                    d / "coverage_plan.json",
                    d / "assignments.json",
                    d / "alignment_report.json",
                    d / "repair_log.json",
                ],
                notes=(f"S08 G-alignment FAIL: {strict_n} strict violations "
                       f"após {len(repair_log)} rondas de repair ({kinds}). "
                       f"S09/S10 não iniciam (fail-closed)."),
            )

        if result.unfilled_scenes:
            return StageResult(
                status="failed",
                outputs=[
                    d / "coverage_plan.json",
                    d / "assignments.json",
                    d / "alignment_report.json",
                ],
                notes=f"cenas sem cobertura: {result.unfilled_scenes} "
                      f"(topups: {result.topups_triggered}) — "
                      f"biblioteca precisa de seed")

        return StageResult(
            status="done",
            outputs=[
                d / "coverage_plan.json",
                d / "assignments.json",
                d / "alignment_report.json",
                d / "repair_log.json",
            ],
            notes=(f"{len(result.segments)} segmentos · "
                   f"coverage={len(plan.ranked_entities)} entities · "
                   f"repair_rounds={max(0, len(repair_log) - 1)} · "
                   f"strict_violations={len(alignment_report.strict_violations)}"),
        )


class S09Timeline:
    name = "09_timeline"

    def run(self, ctx: RunContext) -> StageResult:
        from studio.matching.assigner import AssignmentResult
        from studio.render.timeline import build_timeline

        result = AssignmentResult.model_validate_json(
            (ctx.run_dir / "08_matching" / "assignments.json").read_text("utf-8"))
        scenes = json.loads((ctx.run_dir / "06_scenes" / "scenes.json").read_text("utf-8"))
        timeline = build_timeline(
            video_id=ctx.video_id,
            narration_path=str(ctx.run_dir / "04_tts" / "narration.wav"),
            segments=result.segments,
            scene_texts={s["scene_id"]: s["text"] for s in scenes},
        )
        out = ctx.stage_dir(self.name) / "timeline.json"
        out.write_text(timeline.model_dump_json(indent=2), "utf-8")
        return StageResult(status="done", outputs=[out],
                           notes=f"{len(timeline.entries)} entradas")


class S10RenderProxy:
    name = "10_render_proxy"

    def run(self, ctx: RunContext) -> StageResult:
        from studio.render.captions import build_ass
        from studio.render.renderer import render_video
        from studio.render.timeline import Timeline

        timeline = Timeline.model_validate_json(
            (ctx.run_dir / "09_timeline" / "timeline.json").read_text("utf-8"))
        d = ctx.stage_dir(self.name)
        words = json.loads((ctx.run_dir / "05_timestamps" / "words.json").read_text("utf-8"))
        ass = build_ass(words, d / "captions.ass")
        out = render_video(timeline, d / "proxy_480p.mp4", ctx.settings,
                           proxy=True, ass_path=ass, burn_overlay=True)
        return StageResult(status="done", outputs=[out, ass])


class S11Review:
    name = "11_review"
    MAX_ROUNDS = 2
    # 75 = mínimo aceitável definido pelo operador (2026-07-14); o loop de
    # fixes continua a tentar subir enquanto houver rondas e fixes úteis
    # 75 = mínimo aceitável definido pelo operador (2026-07-14); o loop de
    # fixes continua a tentar subir enquanto houver rondas e fixes úteis.
    # MAX_ROUNDS=3 (era 2) — A1+A2 do assigner (boost +0.20 + landmark +0.10
    # + penalty -0.10) tipicamente já sobem para ~70 em R1; R2/R3 dão margem
    # extra para os apply_fixes encontrarem shots alternativos sem gastar
    # budget em nova re-render do proxy final.
    PASS_SCORE = 75
    MAX_ROUNDS = 2

    def run(self, ctx: RunContext) -> StageResult:
        from studio.render.captions import build_ass
        from studio.render.renderer import render_video
        from studio.render.timeline import Timeline
        from studio.review.fixes import apply_fixes
        from studio.review.reviewer import review_rough_cut
        from studio.review.rubric import ReviewReport

        d = ctx.stage_dir(self.name)
        proxy = ctx.run_dir / "10_render_proxy" / "proxy_480p.mp4"
        ass = ctx.run_dir / "10_render_proxy" / "captions.ass"
        embedder = ctx.params.get("_embedder")
        if embedder is None:
            from studio.library.embed import SiglipEmbedder

            embedder = SiglipEmbedder()

        # reviews de um matching ANTERIOR são lixo: se o 08_matching terminou
        # depois de review_r1 ser escrito, o cache de rondas está obsoleto
        # (aprendido à má maneira: reset manual reaproveitou review velha)
        match_rec = ctx.state.stages.get("08_matching")
        r1 = d / "review_r1.json"
        if match_rec and match_rec.finished_at and r1.exists():
            import datetime as _dt

            match_ts = _dt.datetime.fromisoformat(
                str(match_rec.finished_at)).timestamp()
            if r1.stat().st_mtime < match_ts:
                for stale in list(d.glob("review_r*.json")) + \
                        list(d.glob("fixes_r*.json")) + \
                        [d / "review_summary.json", d / "monotonicity_stop.txt"]:
                    stale.unlink(missing_ok=True)
                log.info("11_review: cache de rondas obsoleto (matching mais "
                         "recente) — limpo")

        # item 17/32: configurável via Settings (era hardcoded na classe).
        pass_score = float(getattr(ctx.settings, "review_pass_score",
                                   self.PASS_SCORE) or self.PASS_SCORE)
        max_rounds = int(getattr(ctx.settings, "review_max_rounds",
                                 self.MAX_ROUNDS) or self.MAX_ROUNDS)

        total_cost, prev_score, report = 0.0, -1, None
        for rnd in range(1, max_rounds + 1):
            round_file = d / f"review_r{rnd}.json"
            if round_file.exists():
                # resume após crash a meio do loop: ronda já paga, não repetir
                # a chamada Gemini (que é a mais cara de todo o pipeline)
                report = ReviewReport.model_validate_json(round_file.read_text("utf-8"))
                cost = 0.0
                log.info("11_review: ronda %d já em disco (resume) — sem nova chamada Gemini", rnd)
            else:
                report, cost = review_rough_cut(proxy, ctx.run_dir, ctx.settings)
                round_file.write_text(report.model_dump_json(indent=2, by_alias=True), "utf-8")
            total_cost += cost
            score = report.overall
            emit_event(ctx.run_dir, ctx.video_id, self.name, "review_score",
                      f"ronda {rnd}: score={score}",
                      progress=min(1.0, score / 100.0) if score else None,
                      payload={"round": rnd, "score": score})
            if score < prev_score:  # monotonicidade: piorou → parar e ir a humano
                (d / "monotonicity_stop.txt").write_text(
                    f"score desceu {prev_score}→{score} na ronda {rnd}\n")
                break
            prev_score = score
            if score >= pass_score or rnd == max_rounds or not report.fixes:
                break
            fixed, unsupported = apply_fixes(report.fixes, ctx.run_dir,
                                             ctx.settings, embedder, ctx.video_id,
                                             topic=ctx.state.topic)
            (d / f"fixes_r{rnd}.json").write_text(json.dumps(
                {"fixed": fixed, "unsupported": unsupported}, ensure_ascii=False), "utf-8")
            if not fixed:
                break
            # re-render do proxy: cache reaproveita segmentos inalterados
            timeline = Timeline.model_validate_json(
                (ctx.run_dir / "09_timeline" / "timeline.json").read_text("utf-8"))
            words = json.loads(
                (ctx.run_dir / "05_timestamps" / "words.json").read_text("utf-8"))
            build_ass(words, ass)
            render_video(timeline, proxy, ctx.settings, proxy=True,
                         ass_path=ass, burn_overlay=True)

        summary = d / "review_summary.json"
        summary.write_text(json.dumps({
            "final_score": report.overall if report else 0,
            "rounds": prev_score >= 0 and rnd or 0,
            "passed": bool(report and report.overall >= pass_score),
        }), "utf-8")

        # gate humano final — SEMPRE, com o relatório (ADR-0005)
        try:
            request_gate(ctx.settings, ctx.state, "final",
                         f"Revisão final: score {report.overall if report else '?'} "
                         f"/100 após {rnd} ronda(s).\nProxy: {proxy}\n"
                         f"Aprovar render final + publicação?")
        except GatePending:
            return StageResult(status="waiting_approval", cost_usd=total_cost,
                               notes="gate: final")
        return StageResult(status="done", outputs=[summary], cost_usd=total_cost,
                           notes=f"score {report.overall if report else 0}")


class S12RenderFinal:
    name = "12_render_final"

    def run(self, ctx: RunContext) -> StageResult:
        from studio.render.renderer import render_video
        from studio.render.timeline import Timeline

        timeline = Timeline.model_validate_json(
            (ctx.run_dir / "09_timeline" / "timeline.json").read_text("utf-8"))
        d = ctx.stage_dir(self.name)
        ass = (ctx.run_dir / "10_render_proxy" / "captions.ass")
        emit_event(ctx.run_dir, ctx.video_id, self.name, "render_started",
                  f"{len(timeline.entries)} entries")
        out = render_video(timeline, d / "final.mp4", ctx.settings,
                           proxy=False,
                           ass_path=ass if ctx.settings.burn_captions else None)
        return StageResult(status="done", outputs=[out])


class S13Package:
    name = "13_package"

    def run(self, ctx: RunContext) -> StageResult:
        from studio.publish.metadata import build_metadata
        from studio.publish.thumbnail import build_thumbnail
        from studio.render.captions import build_srt
        from studio.render.timeline import Timeline

        d = ctx.stage_dir(self.name)
        script = (ctx.run_dir / "03_script" / "script.md").read_text("utf-8")
        scenes = json.loads((ctx.run_dir / "06_scenes" / "scenes.json").read_text("utf-8"))
        words = json.loads((ctx.run_dir / "05_timestamps" / "words.json").read_text("utf-8"))
        timeline = Timeline.model_validate_json(
            (ctx.run_dir / "09_timeline" / "timeline.json").read_text("utf-8"))
        topic, _ = _params(ctx)

        attributions = [e.attribution_text for e in timeline.entries
                        if e.attribution_text]
        meta, cost = build_metadata(script, scenes, topic, attributions, ctx.settings)
        (d / "metadata.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
        srt = build_srt(words, d / "subtitles.srt")
        hook = script.split(".")[0]
        thumb = build_thumbnail(ctx.run_dir / "12_render_final" / "final.mp4",
                                hook, scenes, d / "thumbnail.png")
        return StageResult(status="done",
                           outputs=[d / "metadata.json", srt, thumb], cost_usd=cost)


class S14Upload:
    name = "14_upload"

    def run(self, ctx: RunContext) -> StageResult:
        from studio.publish.youtube import upload_video

        d = ctx.stage_dir(self.name)
        receipt_path = d / "upload_receipt.json"
        if not ctx.params.get("upload"):
            receipt_path.write_text(json.dumps(
                {"skipped": True, "reason": "corre com --upload para publicar"}), "utf-8")
            return StageResult(status="done", outputs=[receipt_path],
                               notes="upload saltado (--upload ausente)")

        pkg = ctx.run_dir / "13_package"
        meta = json.loads((pkg / "metadata.json").read_text("utf-8"))
        receipt = upload_video(
            ctx.run_dir / "12_render_final" / "final.mp4", meta, ctx.settings,
            srt_path=pkg / "subtitles.srt", thumbnail_path=pkg / "thumbnail.png")
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2),
                                "utf-8")
        return StageResult(status="done", outputs=[receipt_path],
                           notes=f"video_id={receipt.get('video_id')}")


def produce_stages() -> list[list]:
    """Pipeline em ondas — REVISITADO pós-Optimização Profunda (Fase 1).

    Cadeia REAL de dependências (auditada 2026-08-08):
        03_script ──► 04_tts ──► 05_timestamps ──► 06_scenes ──► 07_briefs
                                                              │
                                                              ▼
                                                       08_matching ◄── (consome S05 + S06 + S07)
                                                              │
                                                              ▼
        09_timeline ──► 10_proxy ──► 11_review ──► 12_final ──► 13_pkg ──► 14_upload

    S05 + S07 em paralelo era INVÁLIDO (S07Briefs lê 06_scenes/scenes.json
    que sai do S06 — race produzia S07 a ler []  ou [] órfão).
    S04 + S06 em paralelo era INVÁLIDO (S06 lê 05_timestamps/words.json).
    Por isso as cadeias S04→S05→S06→S07 ficam estritamente sequenciais.
    A pequena poupança de ~10s paralelizando S04 + nada-útil foi
    sacrificada em favor da CORRECTNESS + DOUTRINA DG dependências explícitas.

    Nenhuma das stages 03-14 tem subtrabalho verdadeiramente independente:
    manter serial torna o DAG trivial de auditar (1 docstring + 1
    return list) e previne invalidadez sutil como as duas acima.

    DOC: ARCHITECTURE §3 (DAG revisitado Fase 1 Optimização).
    """
    return [
        [S01Topic()],
        [S02Research()],
        [S03Script()],
        [S04Tts()],
        [S05Timestamps()],
        [S06Scenes()],
        [S07Briefs()],
        [S08Matching()],
        [S09Timeline()],
        [S10RenderProxy()],
        [S11Review()],
        [S12RenderFinal()],
        [S13Package()],
        [S14Upload()],
    ]



