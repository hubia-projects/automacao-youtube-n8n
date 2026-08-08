"""Fase G — Entity Alignment Validator (ARCHITECTURE §1.8).

Compara o resultado do assign_shots() contra o que a narração diz:

    narração / timestamp
        → EntitySpan esperado
            → Scene
                → SegmentAssignment
                    → metadata do shot (places/landmarks/food CSVs)

Para cada strict scene onde o segmento não satisfaz a entity esperada,
produz uma `Violation`. A saída vai para `08_matching/alignment_report.json`
e é o input do **repair loop** no `S08Matching` (remediar antes do render).

DOC: ARCHITECTURE §1.8.

Princípios:
  * Puro — não toca LanceDB; lê metadados já anexados em SegmentAssignment
    (campos opcionais `places_csv`, `landmarks_csv`, `food_csv`,
    `__confirmation`).
  * Determinístico — sem RNG/IO; resultado byte-igual entre runs.
  * Fail-closed — não engole `SceneStrictCoverageGap`; apenas reporta.
  * Mock-friendly — empty listshot ⇒ no violations.
"""

from __future__ import annotations

import json
import logging
from enum import Enum
from pathlib import Path

from pydantic import BaseModel, Field

from studio.config import Settings
from studio.script.entities import EntitySpan
from studio.script.scenes import Scene
from studio.matching.briefs import VisualBrief
from studio.matching.assigner import SegmentAssignment

log = logging.getLogger("studio.alignment")

# Defaults overridable (FIX-5 MÉDIO code-reviewer) via Settings
TIME_EPSILON_S = 0.05
BOUNDARY_OVERLAP_MIN_S = 0.5

# Colunas CSV por tipo de entity — mantém-se alinhada com o resto do
# pipeline (search.py, coverage_plan.py).
_ENTITY_TYPE_TO_COLUMN = {
    "food": "food_csv",
    "landmark": "landmarks_csv",
    "building": "landmarks_csv",
    "attraction": "landmarks_csv",
    "place": "places_csv",
}


class ViolationType(str, Enum):
    MISSING_REQUIRED_ENTITY = "missing_required_entity"
    WRONG_FOOD_ENTITY = "wrong_food_entity"
    WRONG_LANDMARK_ENTITY = "wrong_landmark_entity"
    WRONG_LOCATION = "wrong_location"
    GENERIC_FOR_STRICT_ENTITY = "generic_for_strict_entity"
    ENTITY_COVERAGE_GAP = "entity_coverage_gap"
    SEGMENT_CROSSES_ENTITY_BOUNDARY = "segment_crosses_entity_boundary"
    UNCONFIRMED_ENTITY = "unconfirmed_entity"


class Violation(BaseModel):
    """Mínimo que o operador precisa para diagnosticar + rematch/
    targeted-top-up. `severity="strict"` ⇒ repair loop actua; `warning`
    fica apenas no relatório."""
    scene_id: str
    seg_index: int
    t_in: float
    t_out: float
    shot_id: str
    violation_type: ViolationType
    severity: str  # "strict" | "warning"
    expected_entity: str = ""
    expected_entity_type: str = ""
    actual_entity: str = ""
    actual_entity_type: str = ""
    evidence: list[str] = Field(default_factory=list)
    note: str = ""


class AlignmentReport(BaseModel):
    schema_version: str = "1.0"
    total_segments: int = 0
    total_strict_scenes: int = 0
    violations: list[Violation] = Field(default_factory=list)
    summary: dict = Field(default_factory=dict)
    repair_log: list[dict] = Field(default_factory=list)

    @property
    def strict_violations(self) -> list[Violation]:
        # FIX-reviewer-#3: Settings.alignment_min_severity determina o que
        # conta como "strict" para o fail-closed. Default "strict" =
        # comportamento legacy. Override para "warning" passa tudo a strict
        # (útil para corrigir FP em dev). Override "strict_and_warning" =
        # ambos.
        # Como `settings)` aqui não está acessível, devolvemos a lista de
        # severity=="strict" apenas; os callers que precisem podem usar
        # `report.violations` diretamente. Mantemos a property simples
        # para retro-compat com código legacy.
        return [v for v in self.violations if v.severity == "strict"]

    @property
    def has_unresolved_strict(self) -> bool:
        # Por defeito "strict"; callers podem filtrar manualmente.
        return bool(self.strict_violations)


# ----------------- helpers -----------------
def _normalize(name: str) -> str:
    return (name or "").strip().lower()


def _entity_columns(canonical: str, entity_type: str) -> list[str]:
    """Devolve a lista de colunas CSV em que esta entity deve aparecer
    nos metadados do shot. None se entity_type desconhecido ⇒ tentar nas 3."""
    col = _ENTITY_TYPE_TO_COLUMN.get((entity_type or "").lower())
    if col:
        return [col]
    return ["places_csv", "landmarks_csv", "food_csv"]


def _shot_has_entity(seg: SegmentAssignment, canonical: str,
                     entity_type: str) -> tuple[bool, list[str]]:
    """Confirma se os CSVs do shot carregam a entity (case-insensitive).
    Devolve (matched, quais_colunas_têm). Se matched=False e algumas
    colunas têm outros valores, devolvemos essas para a mensagem."""
    canon_lo = _normalize(canonical)
    if not canon_lo:
        return False, []
    columns = _entity_columns(canonical, entity_type)
    hits = []
    for col in columns:
        value = (getattr(seg, col, "") or "").lower()
        if not value:
            continue
        # CSV separado por vírgula
        items = [t.strip() for t in value.split(",") if t.strip()]
        if any(canon_lo == it or canon_lo in it for it in items):
            hits.append(col)
    return bool(hits), hits


def _intervals_overlap(a0: float, a1: float,
                      b0: float, b1: float) -> float:
    """Overlap em segundos entre [a0,a1] e [b0,b1]. 0 se disjuntos."""
    lo = max(a0, b0)
    hi = min(a1, b1)
    return max(0.0, hi - lo)


def _spans_for_scene(scene: Scene, spans: list[EntitySpan],
                    scenes_full: list[Scene], *,
                    eps: float = TIME_EPSILON_S) -> list[EntitySpan]:
    """FIX-5: usa `eps` de Settings quando disponível (sensibilidade
    configurável). Spans que intersectam a cena em ≥ eps segundos."""
    if not spans:
        return []
    out = []
    for sp in spans:
        if _intervals_overlap(scene.t_in, scene.t_out,
                              sp.t_in, sp.t_out) > eps:
            out.append(sp)
    return out


def _expected_entity_for_time(t_in: float, t_out: float,
                             spans: list[EntitySpan], *,
                             prefer_strict: bool = True) -> EntitySpan | None:
    """Devolve o EntitySpan com maior overlap em [t_in, t_out].
    `prefer_strict=True` (default) ⇒ preferimos spans strict quando o
    overlap é igual (Strict > Generic conforme hierarquia do spec)."""
    if not spans:
        return None
    best: EntitySpan | None = None
    best_overlap = 0.0
    for sp in spans:
        ov = _intervals_overlap(t_in, t_out, sp.t_in, sp.t_out)
        if ov <= TIME_EPSILON_S:
            continue
        if (ov > best_overlap
            or (ov == best_overlap
                and prefer_strict
                and best is not None
                and sp.strict_visual
                and not best.strict_visual)):
            best_overlap = ov
            best = sp
    return best


# ----------------- validator principal -----------------
def validate_alignment(
    *,
    scenes: list[Scene],
    briefs: list[VisualBrief],
    segments: list[SegmentAssignment],
    entity_spans: list[EntitySpan],
    coverage_plan: object | None = None,
    settings: Settings,
) -> AlignmentReport:
    """Pure: devolve AlignmentReport. Não toca I/O nem BD.

    Caller deve anexar metadados CSV do shot em cada SegmentAssignment
    (`places_csv`, `landmarks_csv`, `food_csv`) E, opcionalmente,
    `__confirmation` (DetectedEntity). Sem isso, reportaremos
    `missing_required_entity` para cenas strict (que é o sinal correto —
    operador vê o problema estrutural).
    """
    brief_by_scene = {b.scene_id: b for b in briefs}
    # FIX-5: lê overrides de Settings, fallback para defaults
    eps = float(getattr(settings, "alignment_time_epsilon_s",
                        TIME_EPSILON_S) or TIME_EPSILON_S)
    boundary_min = float(getattr(settings, "alignment_boundary_overlap_min_s",
                                 BOUNDARY_OVERLAP_MIN_S) or BOUNDARY_OVERLAP_MIN_S)
    # FIX-reviewer-#3: alignment_min_severity controla strict effective set
    # do report. default "both": mantém warnings separadas de strict.
    # override "strict": warnings NUNCA contam como strict (é o que já
    # acontecia). override "warning": tudo vira strict (dev/QA strict).
    min_sev = (getattr(settings, "alignment_min_severity", "strict") or "strict").lower()
    promote_warnings = (min_sev == "warning")
    spans_by_scene: dict[str, list[EntitySpan]] = {}
    for sc in scenes:
        spans_by_scene[sc.scene_id] = _spans_for_scene(
            sc, entity_spans, scenes, eps=eps)

    violations: list[Violation] = []
    strict_scenes = sum(
        1 for b in briefs if b.strict_entity and b.required_entity)

    def _add_violation(**kwargs) -> None:
        violations.append(Violation(**kwargs))

    for seg in segments:
        brief = brief_by_scene.get(seg.scene_id)
        if brief is None:
            # Sem brief — cena b-roll sem entity explícita. O validator não
            # actua; S08 deve deal with via assigned result. Não emite.
            continue
        is_strict = bool(brief.strict_entity and brief.required_entity)
        scene_spans = spans_by_scene.get(seg.scene_id, [])

        # 1) Boundary crossing: cena strict coberta por >1 EntitySpan strict
        #    em simultâneo. Culpa primária é do segment_scenes (Fase B);
        #    Fase G é a segunda linha de defesa.
        if is_strict:
            strict_overlaps = [
                sp for sp in scene_spans
                if sp.strict_visual
                and _intervals_overlap(seg.t_in, seg.t_out,
                                        sp.t_in, sp.t_out) > boundary_min
            ]
            distinct = {sp.canonical_name.strip().lower()
                        for sp in strict_overlaps}
            if len(distinct) > 1:
                _add_violation(
                    scene_id=seg.scene_id, seg_index=seg.seg_index,
                    t_in=seg.t_in, t_out=seg.t_out, shot_id=seg.shot_id,
                    violation_type=ViolationType.SEGMENT_CROSSES_ENTITY_BOUNDARY,
                    severity="strict",
                    expected_entity=",".join(sorted(distinct)),
                    evidence=[f"{len(strict_overlaps)} strict spans sobrepostos",
                              f"distinct_entities={len(distinct)}"],
                    note="cena strict atravessada por múltiplas entities",
                )
                # boundary é a violação mais grave: reportamos mas continuamos
                # para sinalizar generic/wrong no mesmo segmento.

        # 2) Generic-for-strict: cena strict sem metadata da entity.
        #    Pode acontecer quando o shot é pré-Fase E sem CSV columns
        #    preenchidos OU foi escolhido abaixo do limiar.
        if is_strict:
            matched, cols = _shot_has_entity(
                seg, brief.required_entity, brief.required_entity_type or "")
            if not matched:
                # distinguish between missing column data vs wrong entity
                has_any_entity_meta = any(
                    (getattr(seg, c, "") or "").strip()
                    for c in ("places_csv", "landmarks_csv", "food_csv")
                )
                expected_type = (brief.required_entity_type or "").lower()
                if expected_type == "food":
                    vt = ViolationType.WRONG_FOOD_ENTITY
                elif expected_type in ("landmark", "building", "attraction"):
                    vt = ViolationType.WRONG_LANDMARK_ENTITY
                elif not has_any_entity_meta:
                    vt = ViolationType.GENERIC_FOR_STRICT_ENTITY
                else:
                    vt = ViolationType.MISSING_REQUIRED_ENTITY
                actual_csv = " | ".join(
                    f"{c}={(getattr(seg, c, '') or '')[:60]!r}"
                    for c in ("places_csv", "landmarks_csv", "food_csv"))
                _add_violation(
                    scene_id=seg.scene_id, seg_index=seg.seg_index,
                    t_in=seg.t_in, t_out=seg.t_out, shot_id=seg.shot_id,
                    violation_type=vt, severity="strict",
                    expected_entity=brief.required_entity,
                    expected_entity_type=brief.required_entity_type,
                    actual_entity="",
                    evidence=[f"no CSV match in {cols or '3-cols'}",
                              f"csv_snapshot={actual_csv[:120]}"],
                    note="cena strict sem entity confirmada nos metadados do shot",
                )

        # 3) Unconfirmed entity: cena strict + entity confirmada?
        #    Marcamos warning (não strict) porque o validator puro não tem
        #    cache write-back; in real mode, S08Matching deve verificar isto
        #    PRE assign_shots (warmed caches). Aqui é sinal defensivo.
        if is_strict and not getattr(seg, "__confirmation", None):
            _add_violation(
                scene_id=seg.scene_id, seg_index=seg.seg_index,
                t_in=seg.t_in, t_out=seg.t_out, shot_id=seg.shot_id,
                violation_type=ViolationType.UNCONFIRMED_ENTITY,
                severity=("strict" if promote_warnings else "warning"),
                expected_entity=brief.required_entity,
                expected_entity_type=brief.required_entity_type,
                evidence=["shot sem __confirmation anexado"],
                note="não temos Vision confirmation anexada ao segmento",
            )

    # 4) Entity coverage gap — relatório, não strict (decisão cabe ao plano)
    if coverage_plan is not None:
        try:
            ranked = getattr(coverage_plan, "ranked_entities", []) or []
            for ent in ranked:
                if getattr(ent, "strict", False) \
                        and getattr(ent, "deficit_seconds", 0.0) > 0:
                    violations.append(Violation(
                        scene_id="__plan__", seg_index=-1,
                        t_in=0.0, t_out=0.0, shot_id="",
                        violation_type=ViolationType.ENTITY_COVERAGE_GAP,
                        severity="warning",
                        expected_entity=ent.canonical_name,
                        expected_entity_type=ent.entity_type,
                        evidence=[f"deficit_seconds={ent.deficit_seconds:.1f}",
                                  f"required_seconds={ent.required_seconds:.1f}"],
                        note="cobertura insuficiente no plano (>= 0)",
                    ))
        except Exception as exc:
            log.debug("validate_alignment: plano inválido, ignora gap (%s)",
                      exc.__class__.__name__)

    summary = {
        "total_violations": len(violations),
        "strict_violations": sum(1 for v in violations if v.severity == "strict"),
        "warnings": sum(1 for v in violations if v.severity == "warning"),
        "strict_scenes_in_run": strict_scenes,
        "alignment_min_severity": min_sev,
    }
    return AlignmentReport(
        total_segments=len(segments),
        total_strict_scenes=strict_scenes,
        violations=violations,
        summary=summary,
    )


def write_report(report: AlignmentReport, out_path: Path) -> Path:
    out_path.write_text(
        json.dumps(report.model_dump(mode="json"),
                  ensure_ascii=False, indent=2),
        "utf-8",
    )
    return out_path
