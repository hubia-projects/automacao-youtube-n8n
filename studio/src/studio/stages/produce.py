"""Stages s01-s06 do pipeline de produção (Fase 3).

Cada stage é fino: lê artefactos anteriores do disco, chama o módulo de
domínio, escreve outputs + devolve custo. Fail-closed em tudo.
"""

from __future__ import annotations

import json
import logging

from studio.approvals.gates import GatePending, request_gate
from studio.orchestrator.stage import RunContext, StageResult
from studio.script.lint import lint, normalize_for_tts, scrub_safety_phrases
from studio.script.scenes import segment_scenes
from studio.script.writer import (
    Outline,
    build_outline,
    critique_and_revise,
    humanize,
    research_pack,
    write_draft,
)

log = logging.getLogger("studio.produce")


def _params(ctx: RunContext) -> tuple[str, float]:
    topic = ctx.params.get("topic") or ctx.state.topic
    duration = float(ctx.params.get("duration_minutes", 12.0))
    return topic, duration


class S01Topic:
    name = "01_topic"

    def run(self, ctx: RunContext) -> StageResult:
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
        d = ctx.stage_dir(self.name)
        research = (ctx.run_dir / "02_research" / "research_pack.md").read_text("utf-8")
        total = 0.0

        # grounding: o guião só pode NOMEAR o que a biblioteca cobre — evita
        # cenas impossíveis de ilustrar (causa nº1 do score baixo do revisor)
        inventory = inventory_text(LibraryDB(ctx.settings.library_root))
        (d / "visual_inventory.txt").write_text(inventory, "utf-8")

        outline, c = build_outline(topic, research, duration, ctx.settings,
                                   visual_inventory=inventory)
        total += c
        (d / "outline.json").write_text(outline.model_dump_json(indent=2), "utf-8")

        draft, c = write_draft(outline, research, duration, ctx.settings,
                               visual_inventory=inventory)
        total += c
        (d / "draft.md").write_text(draft, "utf-8")

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

        script_md = d / "script.md"
        script_md.write_text(final, "utf-8")

        if ctx.params.get("gate_script"):
            try:
                request_gate(ctx.settings, ctx.state, "script",
                             f"Aprovar roteiro? ({report.stats['words']} palavras)\n\n"
                             f"{final[:800]}…")
            except GatePending:
                return StageResult(status="waiting_approval", cost_usd=total,
                                   notes="gate: script")
        return StageResult(status="done", outputs=[script_md], cost_usd=total)


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
    name = "06_scenes"

    def run(self, ctx: RunContext) -> StageResult:
        script = (ctx.run_dir / "03_script" / "script.md").read_text("utf-8")
        words = json.loads((ctx.run_dir / "05_timestamps" / "words.json").read_text("utf-8"))
        outline_path = ctx.run_dir / "03_script" / "outline.json"
        outline = Outline.model_validate_json(outline_path.read_text("utf-8")) \
            if outline_path.exists() else None

        scenes = segment_scenes(script, words, outline)
        if not scenes:
            return StageResult(status="failed", notes="segmentação produziu 0 cenas")
        out = ctx.stage_dir(self.name) / "scenes.json"
        out.write_text(json.dumps([s.model_dump() for s in scenes],
                                  ensure_ascii=False, indent=2), "utf-8")
        return StageResult(status="done", outputs=[out],
                           notes=f"{len(scenes)} cenas")


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
        from studio.script.scenes import Scene

        scenes = [Scene.model_validate(s) for s in json.loads(
            (ctx.run_dir / "06_scenes" / "scenes.json").read_text("utf-8"))]
        briefs = [VisualBrief.model_validate(b) for b in json.loads(
            (ctx.run_dir / "07_briefs" / "briefs.json").read_text("utf-8"))]

        embedder = ctx.params.get("_embedder")  # injetável nos testes
        if embedder is None:
            from studio.library.embed import SiglipEmbedder

            embedder = SiglipEmbedder()
        db = LibraryDB(ctx.settings.library_root)

        result = assign_shots(scenes, briefs, db, embedder, ctx.settings,
                              run_id=ctx.video_id, topic=ctx.state.topic)
        out = ctx.stage_dir(self.name) / "assignments.json"
        out.write_text(result.model_dump_json(indent=2), "utf-8")
        if result.unfilled_scenes:
            return StageResult(status="failed", outputs=[out],
                               notes=f"cenas sem cobertura: {result.unfilled_scenes} "
                                     f"(topups: {result.topups_triggered}) — "
                                     f"biblioteca precisa de seed")
        return StageResult(status="done", outputs=[out],
                           notes=f"{len(result.segments)} segmentos")


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
    MAX_ROUNDS = 3

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

        total_cost, prev_score, report = 0.0, -1, None
        for rnd in range(1, self.MAX_ROUNDS + 1):
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
            if score < prev_score:  # monotonicidade: piorou → parar e ir a humano
                (d / "monotonicity_stop.txt").write_text(
                    f"score desceu {prev_score}→{score} na ronda {rnd}\n")
                break
            prev_score = score
            if score >= self.PASS_SCORE or rnd == self.MAX_ROUNDS or not report.fixes:
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
            "passed": bool(report and report.overall >= self.PASS_SCORE),
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


def produce_stages() -> list:
    return [S01Topic(), S02Research(), S03Script(), S04Tts(),
            S05Timestamps(), S06Scenes(), S07Briefs(), S08Matching(),
            S09Timeline(), S10RenderProxy(), S11Review(), S12RenderFinal(),
            S13Package(), S14Upload()]
