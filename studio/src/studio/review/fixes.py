"""Executor de fixes — patches mecânicos à timeline (ADR-0005).

replace_shot: re-corre o matching SÓ da cena afetada, excluindo os shots
atuais, e reconstrói a timeline. Ações não suportadas ficam registadas e
sobem ao gate humano — nunca são improvisadas.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.matching.assigner import AssignmentResult, assign_shots
from studio.matching.briefs import VisualBrief
from studio.render.timeline import build_timeline
from studio.review.rubric import Fix
from studio.script.scenes import Scene

log = logging.getLogger("studio.fixes")


def _metadata_score(segments, brief: VisualBrief, scene: Scene, db: LibraryDB,
                    topic: str) -> float:
    """Compatibilidade metadados↔brief de um conjunto de segmentos.
    +2 por segmento cujos metadados contêm a entidade exigida;
    -3 por segmento etiquetado com cidade errada (dentro do país);
    -5 por segmento etiquetado com região/país errado.
    Usado para NUNCA trocar por algo comprovadamente pior (a ronda 2 do run
    20260714-102323 desceu 65→45 por trocas às cegas)."""
    from studio.library.inventory import entity_vocab, resolve_entity
    from studio.matching.assigner import (
        _city_exclude_terms,
        _region_exclude_terms,
    )

    region_bad = [t.lower() for t in _region_exclude_terms(topic)]
    city_bad = [t.lower() for t in
                _city_exclude_terms(scene.text, brief.visual_subject_en)]
    entity_terms = [t.lower() for t in
                    resolve_entity(brief.required_entity, entity_vocab(db))] \
        if brief.required_entity else []

    score = 0.0
    for seg in segments:
        row = db.get_shot(seg.shot_id) or {}
        blob = " ".join(str(row.get(c, "") or "") for c in
                        ("places_csv", "landmarks_csv", "food_csv", "summary")).lower()
        if entity_terms and any(t in blob for t in entity_terms):
            score += 2.0
        if any(t in blob for t in city_bad):
            score -= 3.0
        if any(t in blob for t in region_bad):
            score -= 5.0
    return score


def apply_fixes(fixes: list[Fix], run_dir: Path, settings: Settings,
                embedder, video_id: str, topic: str = "") -> tuple[list[str], list[str]]:
    """Devolve (cenas corrigidas, fixes não suportados)."""
    scenes = [Scene.model_validate(s) for s in json.loads(
        (run_dir / "06_scenes" / "scenes.json").read_text("utf-8"))]
    briefs = [VisualBrief.model_validate(b) for b in json.loads(
        (run_dir / "07_briefs" / "briefs.json").read_text("utf-8"))]
    result = AssignmentResult.model_validate_json(
        (run_dir / "08_matching" / "assignments.json").read_text("utf-8"))

    db = LibraryDB(settings.library_root)
    fixed: list[str] = []
    unsupported: list[str] = []

    for fix in fixes:
        if fix.action != "replace_shot":
            unsupported.append(f"{fix.scene_id}:{fix.action}")
            continue
        scene = next((s for s in scenes if s.scene_id == fix.scene_id), None)
        brief = next((b for b in briefs if b.scene_id == fix.scene_id), None)
        if not scene or not brief:
            unsupported.append(f"{fix.scene_id}:desconhecida")
            continue
        if fix.brief_override:
            brief = brief.model_copy(update={
                k: v for k, v in fix.brief_override.items()
                if k in VisualBrief.model_fields})
        # excluir os shots atuais da cena no re-match (senão volta a escolhê-los)
        bad_shots = {s.shot_id for s in result.segments if s.scene_id == fix.scene_id}
        sub = assign_shots([scene], [brief], db, embedder, settings,
                           run_id=f"{video_id}-fix", excluded_shot_ids=bad_shots,
                           topic=topic)
        new_segments = sub.segments
        if not new_segments:
            unsupported.append(f"{fix.scene_id}:sem alternativa no pool")
            continue
        # guarda anti-regressão: só troca se os metadados do novo conjunto
        # forem pelo menos tão compatíveis com o brief quanto os do atual
        old_segments = [s for s in result.segments if s.scene_id == fix.scene_id]
        old_score = _metadata_score(old_segments, brief, scene, db, topic)
        new_score = _metadata_score(new_segments, brief, scene, db, topic)
        if new_score < old_score:
            unsupported.append(f"{fix.scene_id}:alternativa pior "
                               f"({new_score:.0f}<{old_score:.0f}) — mantido")
            log.info("fix %s recusado: novo conjunto pior (%.0f < %.0f)",
                     fix.scene_id, new_score, old_score)
            continue
        result.segments = ([s for s in result.segments if s.scene_id != fix.scene_id]
                           + new_segments)
        fixed.append(fix.scene_id)
        log.info("fix replace_shot aplicado a %s (%d segmentos novos)",
                 fix.scene_id, len(new_segments))

    if fixed:
        (run_dir / "08_matching" / "assignments.json").write_text(
            result.model_dump_json(indent=2), "utf-8")
        scene_texts = {s.scene_id: s.text for s in scenes}
        timeline = build_timeline(
            video_id=video_id,
            narration_path=str(run_dir / "04_tts" / "narration.wav"),
            segments=result.segments, scene_texts=scene_texts)
        (run_dir / "09_timeline" / "timeline.json").write_text(
            timeline.model_dump_json(indent=2), "utf-8")
    return fixed, unsupported
