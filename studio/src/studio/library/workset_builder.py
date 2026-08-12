"""workset_builder.py — item 4 do master task.

Materializa `data/library/worksets/<workset_id>/` GENERICAMENTE a partir de
ThemeSpec + script + Scene/EntitySpan do run activo — substitui o hand-
authoring manual (só existia para `porto-essencia-001`) por um builder que
qualquer tema/vídeo pode usar.

NÃO copia media fisicamente — os requirements referenciam a library global
por `canonical_entity`/`media_sha` (via `CoveragePlan`/`RequirementIndex`);
`selected_shots.json` é preenchido pela camada de selecção (item 10), não
por este builder.

Ficheiros escritos (schema compatível com o workset hand-authored existente,
`data/library/worksets/porto-essencia-001/`, para não criar uma 3ª
arquitectura de schema):
    theme.json, script.md, topics.json, visual_requirements.json,
    coverage.json, selected_shots.json, search_history.json,
    acquisition_report.json, performance.json
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.matching.coverage_plan import (
    CoveragePlan,
    EntityCoverage,
    build_coverage_plan,
    build_query_hierarchy,
    measure_coverage,
    write_workset_readiness,
)
from studio.script.entities import EntitySpan
from studio.script.scenes import Scene
from studio.script.validate_topics import is_topic_present
from studio.theme import ThemeSpec


class MandatoryTopicUnresolvedError(RuntimeError):
    """item D (closure pass): fail-closed — um `mandatory_topic` do
    ThemeSpec não foi resolvido a nenhum EntityCoverage NEM a nenhuma
    Scene do script (nada no run para ancorar duração/queries). Runs
    reais NUNCA devem silenciosamente perder um tópico obrigatório."""

    def __init__(self, topics: list[str]):
        self.topics = topics
        super().__init__(
            f"mandatory_topics sem cobertura no script/scenes: {topics}")

_SCAFFOLD_DEFAULTS = {
    "selected_shots.json": lambda wid: {
        "schema_version": "1.0",
        "workset_id": wid,
        "selection_policy": "logical-only — referencia media_sha da library "
                            "global; nunca duplica ficheiros.",
        "by_entity": {},
    },
    "search_history.json": lambda wid: {
        "schema_version": "1.0",
        "workset_id": wid,
        "queries": [],
    },
    "acquisition_report.json": lambda wid: {
        "schema_version": "1.0",
        "workset_id": wid,
        "waves": [],
    },
    "performance.json": lambda wid: {
        "schema_version": "1.0",
        "workset_id": wid,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "totals": {
            "gemini_calls_total": 0,
            "gemini_batches_total": 0,
            "wall_clock_total_s": 0.0,
            "cost_usd_total": 0.0,
        },
        "stop_condition_history": [],
    },
}


def compute_workset_id(theme_spec: ThemeSpec, script_text: str) -> str:
    """Identidade estável: mesmo ThemeSpec + mesma versão de script produz
    o mesmo workset_id (item 5 do master task — reuse em vez de recriar)."""
    slug = re.sub(r"[^a-z0-9]+", "-", theme_spec.theme.lower()).strip("-")[:40] or "video"
    digest = hashlib.sha256(
        f"{theme_spec.model_dump_json()}|{script_text}".encode("utf-8")
    ).hexdigest()[:10]
    return f"{slug}-{digest}"


def workset_dir(settings: Settings, workset_id: str) -> Path:
    return settings.library_root / "worksets" / workset_id


def _ensure_mandatory_topics(
    plan: CoveragePlan,
    mandatory_topics: list[str],
    scenes: list[Scene],
    db: LibraryDB,
    settings: Settings,
) -> None:
    """item D: `mandatory_topics` do ThemeSpec NUNCA podem desaparecer do
    workset — mesmo quando o extractor de entidades os perdeu (miss real,
    já observado em produção). Para cada tópico sem EntityCoverage
    correspondente, procura Scenes cujo `.text` o cita (mesmo matcher
    accent/case-insensitive de `validate_topics.is_topic_present`) e
    ancora a duração nessas janelas. Sintético, strict=True por defeito —
    conteúdo visual nomeado explicitamente pelo operador é conservador.

    Fail-closed: se NENHUMA Scene cita o tópico, não há nada no run para
    ancorar duração/queries — levanta `MandatoryTopicUnresolvedError` em
    vez de silenciosamente perder o tópico obrigatório.
    """
    if not mandatory_topics:
        return
    existing = {ent.canonical_name.strip().lower() for ent in plan.ranked_entities}
    unresolved: list[str] = []
    for topic in mandatory_topics:
        key = topic.strip().lower()
        if not key or key in existing:
            continue
        matching_scenes = [sc for sc in scenes if is_topic_present(sc.text, topic)]
        if not matching_scenes:
            unresolved.append(topic)
            continue
        required_s = round(
            sum(max(0.0, sc.t_out - sc.t_in) for sc in matching_scenes), 3)
        ent = EntityCoverage(
            canonical_name=topic, entity_type="place",
            priority_score=1.0, mention_count=len(matching_scenes),
            required_seconds=required_s, target_seconds=0.0,
            min_distinct_shots=0, strict=True,
        )
        ent = measure_coverage(ent, db)
        # mesmo cálculo de buffer/min_shots de build_coverage_plan (§3
        # acima) — mantém o schema idêntico entre entities extraídas e
        # entities sintéticas de mandatory_topic.
        ent.target_seconds = round(ent.required_seconds * settings.coverage_buffer, 3)
        ent.min_distinct_shots = max(
            1, -(-int(ent.target_seconds)
                 // int(max(1.0, settings.min_shots_by_duration))))
        ent.deficit_seconds = round(
            max(0.0, ent.target_seconds - ent.available_seconds), 3)
        ent.queries = build_query_hierarchy(
            ent.canonical_name, location="", entity_type=ent.entity_type,
            features=[], levels=max(1, settings.query_levels - 1),
        )
        ent.notes.append(
            "mandatory_topic sem EntitySpan — ancorado por texto de Scene "
            "(item D closure pass)")
        plan.ranked_entities.append(ent)
        existing.add(key)
    if unresolved:
        raise MandatoryTopicUnresolvedError(unresolved)


def _topic_id(index: int, canonical: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", canonical.lower()).strip("-")[:24] or "topic"
    return f"T{index + 1:02d}-{slug}"


@dataclass
class WorksetResult:
    workset_id: str
    workset_dir: Path
    reused: bool
    plan: CoveragePlan
    is_workset_ready: bool
    per_requirement_status: dict[str, str]


def build_workset(
    theme_spec: ThemeSpec,
    script_text: str,
    scenes: list[Scene],
    entity_spans: list[EntitySpan],
    db: LibraryDB,
    settings: Settings,
    *,
    workset_id: str | None = None,
) -> WorksetResult:
    """Constrói (ou reutiliza) o workset — SSoT persistente do vídeo activo.

    `theme.json`/`script.md` só são escritos na primeira vez (identidade
    estável); `topics.json`/`visual_requirements.json`/`coverage.json` são
    sempre remedidos contra o estado actual da library (podem mudar entre
    chamadas — aquisição em curso).
    """
    wid = workset_id or compute_workset_id(theme_spec, script_text)
    wdir = workset_dir(settings, wid)
    theme_path = wdir / "theme.json"
    reused = theme_path.exists()
    wdir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()

    if not reused:
        theme_path.write_text(json.dumps({
            "workset_id": wid,
            "schema_version": "1.0",
            "theme": theme_spec.theme,
            "language": theme_spec.language,
            "location": theme_spec.location,
            "duration_minutes_target": theme_spec.target_duration_minutes,
            "mandatory_topics": theme_spec.mandatory_topics,
            "optional_topics": theme_spec.optional_topics,
            "created_at": now,
        }, ensure_ascii=False, indent=2), "utf-8")
        (wdir / "script.md").write_text(script_text, "utf-8")

    total_script_seconds = max((sc.t_out for sc in scenes), default=None)
    plan = build_coverage_plan(
        entity_spans, db, settings,
        topic=theme_spec.theme,
        total_script_seconds=total_script_seconds,
        scenes=scenes,
        include_filler=True,
    )
    _ensure_mandatory_topics(plan, theme_spec.mandatory_topics, scenes, db, settings)

    topic_ids = [_topic_id(i, ent.canonical_name)
                for i, ent in enumerate(plan.ranked_entities)]

    topics_doc = {
        "schema_version": "1.0",
        "workset_id": wid,
        "topics": [
            {
                "topic_id": tid,
                "canonical_entity": ent.canonical_name,
                "entity_type": ent.entity_type,
                "strict": ent.strict,
                "required_seconds": ent.required_seconds,
            }
            for tid, ent in zip(topic_ids, plan.ranked_entities)
        ],
    }
    (wdir / "topics.json").write_text(
        json.dumps(topics_doc, ensure_ascii=False, indent=2), "utf-8")

    visual_requirements_doc = {
        "schema_version": "1.1",
        "workset_id": wid,
        "coverage_buffer": settings.coverage_buffer,
        "min_shots_by_duration_s": settings.min_shots_by_duration,
        "requirements": [
            {
                "requirement_id": tid,
                "canonical_entity": ent.canonical_name,
                "entity_type": ent.entity_type,
                "strict": ent.strict,
                "required_seconds": ent.required_seconds,
                "target_seconds": ent.target_seconds,
                "min_distinct_shots": ent.min_distinct_shots,
                "available_seconds": ent.available_seconds,
                "available_distinct_shots": ent.available_distinct_shots,
                "deficit_seconds": ent.deficit_seconds,
                "visual_prompts_en": ent.queries,
            }
            for tid, ent in zip(topic_ids, plan.ranked_entities)
        ],
    }
    (wdir / "visual_requirements.json").write_text(
        json.dumps(visual_requirements_doc, ensure_ascii=False, indent=2), "utf-8")

    ready, per_status = write_workset_readiness(
        plan, db, settings, wdir / "coverage.json",
        confirmed_index={}, remeasure=False,
    )

    for filename, factory in _SCAFFOLD_DEFAULTS.items():
        p = wdir / filename
        if not p.exists():
            p.write_text(json.dumps(factory(wid), ensure_ascii=False, indent=2), "utf-8")

    return WorksetResult(
        workset_id=wid,
        workset_dir=wdir,
        reused=reused,
        plan=plan,
        is_workset_ready=ready,
        per_requirement_status=per_status,
    )
