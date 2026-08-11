"""Coverage Plan — Fase C do Sprint Optimização.

O pipeline "olha para a frente" antes de fazer matching:

1. `rank_entity_importance()` põe as entities em ordem (PRIORIDADE).
2. `measure_coverage()` diz quanto de cada entity TEMOS na biblioteca
   (segundos úteis + shots distintos + ficheiros distintos).
3. `build_query_hierarchy()` gera queries hierárquicas em 4 níveis
   (entity+features → entity+location → entity → contexto genérico).
4. `write_plan()` gera `08_matching/coverage_plan.json` — artefacto
   consumível pelo top-up (Fase D) e pelo alignment validator (Fase G).

Fórmula de prioridade (FIXA e TESTÁVEL):
    priority = 0.45·duration_rel
             + 0.25·frequency_rel
             + 0.20·importance
             + 0.10·specificity

  - duration_rel: duração acumulada da narração dedicada à entity /
    duração total do script (peso de quanto TEMPO a entity está em
    cena — regra nº1 de cobertura).
  - frequency_rel: nº de menções da entity / nº da entity mais citada
    (teto relativo para não saturar Francesinha com 8 menções vs 2).
  - importance: narrative_importance devolvido pelo extractor
    da Fase A (0..1, mantém-se como factor estável).
  - specificity: 1 - overlap lexical entre canonical_name e topic
    (quanto MENOS overlap, mais específica → Francesinha em "Porto"
    é mais específica que "Rua do Porto" em "Porto").

DOC: ARCHITECTURE §1.7.3.
"""

from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, Field

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.perf import Profiler
from studio.script.entities import EntitySpan

log = logging.getLogger("studio.coverage")

# --- pesos da fórmula (NÃO MAGIC NUMBERS — DETERMINÍSTICOS, TESTÁVEIS) ---
W_DURATION = 0.45
W_FREQUENCY = 0.25
W_IMPORTANCE = 0.20
W_SPECIFICITY = 0.10


# ----------------- modelos -----------------
class EntityCoverage(BaseModel):
    canonical_name: str
    entity_type: str
    """Peso 45/25/20/10 já fundido em priority_score."""
    priority_score: float
    mention_count: int
    """Duração total do áudio dedicado à entity (segundos já alinhados)."""
    required_seconds: float
    """Buffer de edição (default 1.25×)."""
    target_seconds: float
    """Shots distintos mínimos para cobrir target_seconds."""
    min_distinct_shots: int
    """Segundos úteis disponíveis na biblioteca (considera t_out-t_in e
    revocações)."""
    available_seconds: float = 0.0
    """Shots distintos (media_sha únicos) que carregam a entity."""
    available_distinct_shots: int = 0
    """UPSTREAM-FIX 2026-08-11 (code-reviewer #3): conjunto de shot_ids
    medidos para esta entity. Crucial para `is_workset_ready` validar
    OVERLAP com confirmed_index (em vez de só checar `len(confirmed)>0`,
    que aceita qualquer shot_id)."""
    available_shot_ids: set[str] = Field(default_factory=set)
    """Ficheiros físicos (media_sha únicos)."""
    available_files: int = 0
    """déficit = max(target_seconds - available_seconds, 0)."""
    deficit_seconds: float = 0.0
    """strict_visual ⇒ entity NÃO pode cair para genérico em cobertura
    insuficiente; top-up é obrigatório."""
    strict: bool = True
    """Queries hierárquicas prontas para o top-up (Fase D)."""
    queries: list[str] = Field(default_factory=list)
    """Localização (Porto/Lisboa/...) capturada via groupby na Fase C;
    code-reviewer Fase D fix-2: permite topup_for_plan construir queries
    hierárquicas nível 2 (entity+location) em vez de saltar para N3."""
    location: str = ""
    """Notas (sem mismatch, entity inexistente na biblioteca, etc.)."""
    notes: list[str] = Field(default_factory=list)
    """Soma das age_seconds das rows provider_cache rejected que mencionam
    esta entity (lens diagnóstico: quanto tempo de "esforço desperdiçado"
    em queries rejeitadas para esta entity — orienta decisões de
    cobertura manual)."""
    negative_cache_age_seconds: float = 0.0


class CoveragePlan(BaseModel):
    schema_version: str = "1.0"
    topic: str = ""
    total_script_seconds: float = 0.0
    """Plano ordenado por priority_score decrescente (mais prioritário 1º)."""
    ranked_entities: list[EntityCoverage]
    """Settings estáticos deste plano (replicados para auditoria)."""
    settings_snapshot: dict = Field(default_factory=dict)
    """Sumário legível pelo operador (15 linhas)."""
    summary_lines: list[str] = Field(default_factory=list)


# ----------------- ranking -----------------
def _specificity_score(canonical: str, topic: str) -> float:
    """1.0 - lexical_overlap(canonical, topic). canonical=Porto,
    topic=Porto → 0.0 (genérico). canonical=Francesinha, topic=Porto →
    ~1.0 (específico). canonical=Lello, topic=... → ~1.0."""
    if not topic:
        return 0.5
    a = set(re.findall(r"\w+", canonical.lower()))
    b = set(re.findall(r"\w+", topic.lower()))
    if not a:
        return 0.5
    overlap = len(a & b) / len(a)
    return max(0.0, min(1.0, round(1.0 - overlap, 3)))


def rank_entity_importance(
    entity_spans: list[EntitySpan],
    *,
    total_script_seconds: float,
    topic: str,
) -> list[EntityCoverage]:
    """Ordena entity_spans por prioridade (45% duração + 25% frequência
    + 20% importance + 10% specificity). Determinístico."""
    if not entity_spans:
        return []

    # agrega por canonical_name (case-insensitive)
    buckets: dict[str, list[EntitySpan]] = defaultdict(list)
    meta: dict[str, EntitySpan] = {}
    for sp in entity_spans:
        key = sp.canonical_name.strip().lower()
        buckets[key].append(sp)
        # meta mais recente (última iteração); todas têm os mesmos campos
        # quando vêm do mesmo extractor.
        meta[key] = sp

    max_mentions = max(len(v) for v in buckets.values()) or 1

    out: list[EntityCoverage] = []
    for key, spans in buckets.items():
        canon = meta[key].canonical_name
        etype = meta[key].entity_type
        importance = float(meta[key].importance)
        strict = bool(meta[key].strict_visual)
        required_s = round(sum(max(0.0, s.t_out - s.t_in) for s in spans), 3)
        duration_rel = (required_s / total_script_seconds) if total_script_seconds > 0 else 0.0
        frequency_rel = len(spans) / max_mentions
        spec = _specificity_score(canon, topic)
        priority = round(
            W_DURATION * duration_rel
            + W_FREQUENCY * frequency_rel
            + W_IMPORTANCE * importance
            + W_SPECIFICITY * spec,
            4,
        )
        out.append(EntityCoverage(
            canonical_name=canon,
            entity_type=etype,
            priority_score=priority,
            mention_count=len(spans),
            required_seconds=required_s,
            target_seconds=0.0,    # preenchido depois com buffer
            min_distinct_shots=0,  # preenchido depois com shots_by_duration
            strict=strict,
        ))
    out.sort(key=lambda e: e.priority_score, reverse=True)
    return out


# ----------------- measure coverage -----------------
# mapeamento EntityType → coluna CSV de metadados (mesmo padrão de search.py)
_ENTITY_TYPE_TO_COLUMN = {
    "food": "food_csv",
    "landmark": "landmarks_csv",
    "building": "landmarks_csv",
    "attraction": "landmarks_csv",
    "place": "places_csv",
    # "other_visual" e desconhecidos usam 3-caminho (places|landmarks|food)
}


def _entity_match_clause(canonical: str, entity_type: str) -> str:
    """Gera cláusula LanceDB WHERE para encontrar shots da entity.
    entity_type conhecido ⇒ LIKE directo na coluna certa; senão tenta
    nas 3 colunas (places|landmarks|food). Match por substring case-
    insensitive (places_csv/landmarks_csv/food_csv são lowercase já)."""
    safe = canonical.replace("'", "").strip().lower()
    if not safe:
        return "1 = 0"  # canonical vazio → nada (fail-closed)
    col = _ENTITY_TYPE_TO_COLUMN.get(entity_type)
    if col:
        return f"{col} LIKE '%{safe}%'"
    # 3-caminho
    return (f"places_csv LIKE '%{safe}%' OR "
            f"landmarks_csv LIKE '%{safe}%' OR "
            f"food_csv LIKE '%{safe}%'")


def measure_coverage(
    coverage: EntityCoverage,
    db: LibraryDB,
    *,
    min_quality: int = 4,
) -> EntityCoverage:
    """Mede segundos úteis / shots distintos / ficheiros distintos
    para uma entity. Não bloqueante — usa search_vec com vec dummy ou
    conta via scan directo. Para Fase C usa scan via tabela para
    simplicidade/LanceDB não-vector-searchable nativamente."""
    clause = (f"({_entity_match_clause(coverage.canonical_name, coverage.entity_type)})"
              f" AND quality >= {int(min_quality)} AND revoked = false")
    # code-reviewer item #1+#2: API pública + cap por media_sha real duração
    rows = db.iter_rows(clause, limit=20_000)
    if not rows:
        coverage.notes.append("sem shots na biblioteca — top-up obrigatório")
    secs = 0.0
    dist_shots: set[str] = set()
    dist_files: set[str] = set()
    media_max_out: dict[str, float] = {}  # cap real duração por media_sha
    for r in rows:
        secs += max(0.0, float(r.get("t_out", 0.0)) - float(r.get("t_in", 0.0)))
        if r.get("shot_id"):
            dist_shots.add(r["shot_id"])
        sha = r.get("media_sha")
        if sha:
            dist_files.add(sha)
            media_max_out[sha] = max(media_max_out.get(sha, 0.0),
                                     float(r.get("t_out", 0.0)))
    # segundos reais = soma do t_out máximo por media (não soma de shots,
    # porque 3 shots do mesmo vídeo não podem render mais que sua duração).
    real_secs = sum(media_max_out.values()) if media_max_out else secs
    coverage.available_seconds = round(real_secs, 3)
    coverage.available_distinct_shots = len(dist_shots)
    coverage.available_files = len(dist_files)
    # UPSTREAM-FIX 2026-08-11: persiste o SET de shot_ids para validação
    # overlap em is_workset_ready() (code-reviewer #3). Sem este set,
    # gate aceita qualquer shot_id no confirmed_index, mesmo que esse
    # shot NÃO corresponda entity medida.
    coverage.available_shot_ids = dist_shots

    # Pass 3: negative cache lens — soma das ages das rows provider_cache
    # rejected que mencionam `canonical_name` no reason (heurística:
    # LIKE sobre lower(entity) para performance em tables grandes).
    try:
        from datetime import datetime, timezone as _tz
        canon_safe = coverage.canonical_name.strip().lower().replace("'", "")
        if canon_safe:
            cache_clause = (
                f"status = 'rejected' AND reason LIKE '%{canon_safe}%'"
            )
            cache_rows = db.cache_iter_rows(cache_clause, limit=2000)
            now = datetime.now(_tz.utc)
            age_total = 0.0
            for r in cache_rows:
                created_at = r.get("created_at")
                if not created_at:
                    continue
                try:
                    c_at = datetime.fromisoformat(created_at)
                    age_total += (now - c_at).total_seconds()
                except (ValueError, TypeError):
                    pass
            coverage.negative_cache_age_seconds = round(age_total, 3)
    except Exception as exc:
        log.debug("measure_coverage: negative_cache_age failed (não fatal): %s",
                  exc.__class__.__name__)

    return coverage


# ----------------- query hierarchy -----------------
def build_query_hierarchy(
    canonical: str,
    *,
    location: str = "",
    entity_type: str = "",
    features: list[str] | None = None,
    levels: int = 4,
) -> list[str]:
    """Gera queries ordenadas do mais específico para o mais genérico.

    Níveis (até `levels`):
      1) entity + features distintivas
      2) entity + location
      3) entity isolada
      4) contexto genérico (apenas se entity_type não for strict / nada
         aplicável; ALWAYS devolve string para o caller saber onde ir).

    Strings são devolvidas em inglês (ADR-0003 — query do embedder é EN).
    """
    canon = (canonical or "").strip()
    feat = list(features or [])
    loc = (location or "").strip()

    # traduções muito curtas (PT→EN) para entities PT-comuns — extensão
    # poderia carregar um dict; aqui stays compacta.
    type_en = {
        "food": "food dish meal",
        "landmark": "landmark monument building",
        "building": "building architecture",
        "place": "city region area",
        "attraction": "tourist attraction sight",
        "other_visual": "scene",
    }.get(entity_type.lower() if entity_type else "", "scene")

    out: list[str] = []
    if levels >= 1 and canon:
        f = " ".join(feat[:2]).strip()
        out.append(f"{canon} {type_en} {f}".replace("  ", " ").strip())
    if levels >= 2 and canon and loc:
        out.append(f"{canon} {loc} {type_en}".strip())
    if levels >= 3 and canon:
        out.append(f"{canon} Portugal".strip())
    if levels >= 4 and canon:
        # contexto genérico: cai na cidade/tipo; útil apenas se a entity
        # tem pouca cobertura (Fase D top-up pondera utilidade)
        out.append(f"{loc or 'Portugal'} {type_en}".strip())

    # dedupe mantendo ORDEM (1º match é o mais prioritário)
    seen: set[str] = set()
    deduped: list[str] = []
    for q in out:
        key = q.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(q)
    return deduped


# ----------------- write_plan -----------------
def build_coverage_plan(
    entity_spans: list[EntitySpan],
    db: LibraryDB,
    settings: Settings,
    *,
    topic: str = "",
    total_script_seconds: float | None = None,
    extra_features_by_entity: dict[str, list[str]] | None = None,
) -> CoveragePlan:
    """Constroi o CoveragePlan completo: ranking + measure + queries.

    Idempotente — sem estado partilhado. Determinístico byte-equality
    se entidades e library forem iguais (sem uso de GPU/timestamps).
    """
    # 1) obter duração do script se não foi passada (soma t_out spans)
    if total_script_seconds is None:
        if entity_spans:
            total_script_seconds = max(s.t_out for s in entity_spans)
        else:
            total_script_seconds = 0.0
    total_script_seconds = round(total_script_seconds, 3)

    # 2) ranking base (sem measure)
    ranked = rank_entity_importance(
        entity_spans,
        total_script_seconds=total_script_seconds,
        topic=topic,
    )

    # 3) measure de cobertura (LibraryDB scan)
    for ent in ranked:
        ent = measure_coverage(ent, db)
        # buffer de edição + min_distinct_shots
        ent.target_seconds = round(ent.required_seconds * settings.coverage_buffer, 3)
        ent.min_distinct_shots = max(
            1, -(-int(ent.target_seconds) // int(max(1.0, settings.min_shots_by_duration)))
        )
        ent.deficit_seconds = round(
            max(0.0, ent.target_seconds - ent.available_seconds), 3)
        # code-reviewer item M (Fase C): groupby uma vez → O(N + G) em vez
        # de O(N·M). indexa por canonical_name.lower() e pega primeira
        # location_context não-vazia do grupo.
        _loc_index: dict[str, str] = {}
        for sp in entity_spans:
            k = sp.canonical_name.strip().lower()
            if k in _loc_index:
                continue
            if sp.location_context:
                _loc_index[k] = sp.location_context
        location = _loc_index.get(ent.canonical_name.strip().lower(), "")
        # code-reviewer item #3: entity strict NÃO recebe nível 4
        # (contexto genérico sem entity) — top-up futuro cai em tentação de
        # buscar "Porto food dish" quando precisamos Francesinha explícita.
        query_levels = (settings.query_levels - 1) if ent.strict else settings.query_levels
        ent.location = location  # Fase D fix-2: persiste location no plano
        ent.queries = build_query_hierarchy(
            ent.canonical_name,
            location=location,
            entity_type=ent.entity_type,
            features=(extra_features_by_entity or {}).get(ent.canonical_name, []),
            levels=query_levels,
        )

    # 4) summary legível
    lines = [
        f"coverage: topic='{topic}' script={total_script_seconds:.1f}s "
        f"entities={len(ranked)}",
    ]
    for ent in ranked[:10]:  # top-10
        status = "OK" if ent.deficit_seconds <= 0 else f"deficit={ent.deficit_seconds:.1f}s"
        lines.append(
            f"coverage: {ent.canonical_name} type={ent.entity_type} "
            f"req={ent.required_seconds:.1f}s tgt={ent.target_seconds:.1f}s "
            f"had={ent.available_seconds:.1f}s shots={ent.available_distinct_shots} "
            f"strict={ent.strict} priority={ent.priority_score} status={status}"
        )
    # snapshot Settings (auditoria)
    snap = {
        "coverage_buffer": settings.coverage_buffer,
        "min_shots_by_duration": settings.min_shots_by_duration,
        "query_levels": settings.query_levels,
        "W_DURATION": W_DURATION,
        "W_FREQUENCY": W_FREQUENCY,
        "W_IMPORTANCE": W_IMPORTANCE,
        "W_SPECIFICITY": W_SPECIFICITY,
    }
    return CoveragePlan(
        topic=topic,
        total_script_seconds=total_script_seconds,
        ranked_entities=ranked,
        settings_snapshot=snap,
        summary_lines=lines,
    )


def write_plan(plan: CoveragePlan, out_path: Path) -> Path:
    out_path.write_text(plan.model_dump_json(indent=2), "utf-8")
    return out_path


# ----------------- readiness gate (ÚNICA FONTE AUTORITATIVA) -----------------
# Substitui buckets.py:topic_topics.json["is_ready"] como gate de produção.
# buckets.py continua como tracker binário cheap (>=1 hit por tópico) só para
# observability operacional; a decisão de STOP ACTIVE VIDEO PREPARATION passa
# exclusivamente por is_workset_ready() abaixo.
#
# UPSTREAM-CHANGE §B 2026-08-11:
#   - Para uma requirement R estar COVERED precisamos:
#       R.available_seconds   >= R.target_seconds
#       AND
#       R.available_distinct_shots >= R.min_distinct_shots
#   - Para R.strict=True, ACIMA + pelo menos 1 shot CONFIRMADO pelo Vision
#     (DetectedEntity.confidence >= entity_confirm_min_confidence) presente em
#     confirmed_index[canonical_lower].
#   - Sem isso, requirement fica PARTIAL (counter fail-closed).
#   - global: READY = SEM TODOS os requirements principais estão COVERED.

# Constantes de status — alinhadas com studio.library.models.CoverageState.
# (Aqui usamos strings para serializar sem import circular models↔coverage.)
_RSTATUS_NOT_FOUND = "NOT_FOUND"
_RSTATUS_PARTIAL = "PARTIAL"
_RSTATUS_COVERED = "COVERED"
_RSTATUS_OVER_COVERED = "OVER_COVERED"
_RSTATUS_UNCONFIRMED = "UNCONFIRMED"


def _apply_remeasure_buffer(
    plan: CoveragePlan, settings: Settings,
) -> None:
    """Aplica Settings: coverage_buffer + min_shots_by_duration a entidades
    sem target/min_distinct_shots (ex.: plano parcial importado)."""
    for ent in plan.ranked_entities:
        if ent.target_seconds <= 0:
            ent.target_seconds = round(
                ent.required_seconds * settings.coverage_buffer, 3)
        if ent.min_distinct_shots <= 0:
            ent.min_distinct_shots = max(
                1, -(-int(ent.target_seconds)
                     // int(max(1.0, settings.min_shots_by_duration))))
        ent.deficit_seconds = round(
            max(0.0, ent.target_seconds - ent.available_seconds), 3)


def is_workset_ready(
    plan: CoveragePlan,
    db: LibraryDB,
    settings: Settings,
    *,
    confirmed_index: dict[str, list[str]] | None = None,
    remeasure: bool = True,
) -> tuple[bool, dict[str, str], list[str]]:
    """ÚNICA FONTE AUTORITATIVA de READY (par task 2026-08-11, §B).

    Para cada requirement do plano, calcula:
      - secs_ok = available_seconds >= target_seconds
      - shots_ok = available_distinct_shots >= min_distinct_shots
    - Se ambos passam:
        * strict + confirmed_index fornecido + shot confirmado presente ⇒ COVERED
        * strict + sem confirmação (confirmed_index vazio OR None) ⇒ UNCONFIRMED
          (strict_uncovered += canonical)
        * não-strict ⇒ COVERED
    - Senão, available==0 ⇒ NOT_FOUND; senão PARTIAL.

    Args:
        plan: CoveragePlan (já construído via build_coverage_plan)
        db: LibraryDB (para remeasure opcional)
        settings: Settings (coverage_buffer + min_shots_by_duration)
        confirmed_index: {canonical_lower: [shot_id, ...]} shots confirmados
            pelo Vision (DetectedEntity.confidence >= threshold). None =
            "não ainda confirmado" → strict vira PARTIAL conservativamente.
        remeasure: True = releitura DB (custo I/O) antes do gate.

    Returns:
        (overall_ready, per_requirement_status, strict_uncovered_list)

    overall_ready = True ↔ TODOS os requirements estão "COVERED".
    Deve ser a ÚNICA fonte de "STOP ACTIVE VIDEO PREPARATION".
    """
    if remeasure:
        for ent in plan.ranked_entities:
            measure_coverage(ent, db)
        _apply_remeasure_buffer(plan, settings)

    per_status: dict[str, str] = {}
    strict_uncovered: list[str] = []

    for ent in plan.ranked_entities:
        secs_ok = ent.available_seconds >= ent.target_seconds
        shots_ok = ent.available_distinct_shots >= ent.min_distinct_shots
        if secs_ok and shots_ok:
            if ent.strict:
                if confirmed_index is None:
                    # conservador: não confirmar = não cobrir
                    per_status[ent.canonical_name] = _RSTATUS_UNCONFIRMED
                    strict_uncovered.append(ent.canonical_name)
                else:
                    canon_low = ent.canonical_name.strip().lower()
                    confirmed = confirmed_index.get(canon_low, [])
                    if confirmed:
                        # UPSTREAM-FIX (code-reviewer #3): validação real de
                        # confirmação — o shot_id confirmado TEM de estar
                        # nos shots medidos da entity. Sem este overlap,
                        # gate mente (passaria se confirmed_index apontasse
                        # para shot de outra entity).
                        confirmed_set = {str(s) for s in confirmed}
                        if confirmed_set & ent.available_shot_ids:
                            per_status[ent.canonical_name] = _RSTATUS_COVERED
                        else:
                            # confirmado existe mas NÃO é desta entity
                            per_status[ent.canonical_name] = _RSTATUS_UNCONFIRMED
                            strict_uncovered.append(ent.canonical_name)
                    else:
                        per_status[ent.canonical_name] = _RSTATUS_UNCONFIRMED
                        strict_uncovered.append(ent.canonical_name)
            else:
                # strict check não aplicável
                per_status[ent.canonical_name] = _RSTATUS_COVERED
        elif ent.available_seconds <= 0:
            per_status[ent.canonical_name] = _RSTATUS_NOT_FOUND
        else:
            # algum progresso, mas insuficiente — distingamos target>=req para
            # mostrar onde estámos
            per_status[ent.canonical_name] = _RSTATUS_PARTIAL

    overall_ready = bool(per_status) and all(
        v == _RSTATUS_COVERED for v in per_status.values()
    )
    return overall_ready, per_status, strict_uncovered


def write_workset_readiness(
    plan: CoveragePlan,
    db: LibraryDB,
    settings: Settings,
    out_path: Path,
    *,
    confirmed_index: dict[str, list[str]] | None = None,
    remeasure: bool = True,
) -> tuple[bool, dict[str, str]]:
    """Conveniência: re-mede + is_workset_ready + escreve coverage.json
    no path. Caller compara dict com última snapshot para delta."""
    ready, per_status, strict_uncovered = is_workset_ready(
        plan, db, settings,
        confirmed_index=confirmed_index, remeasure=remeasure,
    )
    overall_required = sum(e.required_seconds for e in plan.ranked_entities)
    overall_target = sum(e.target_seconds for e in plan.ranked_entities)
    overall_available = sum(e.available_seconds for e in plan.ranked_entities)
    out = {
        "schema_version": "1.0",
        "video_id": getattr(plan, "video_id", ""),
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "overall_required_seconds": round(overall_required, 3),
        "overall_target_seconds": round(overall_target, 3),
        "overall_available_seconds": round(overall_available, 3),
        "overall_deficit_seconds": round(
            max(0.0, overall_target - overall_available), 3),
        "is_workset_ready": ready,
        "per_requirement_status": per_status,
        "strict_uncovered": strict_uncovered,
        "covered_count": sum(1 for v in per_status.values()
                              if v == _RSTATUS_COVERED),
        "partial_count": sum(1 for v in per_status.values()
                              if v == _RSTATUS_PARTIAL),
        "not_found_count": sum(1 for v in per_status.values()
                                if v == _RSTATUS_NOT_FOUND),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2),
                         "utf-8")
    return ready, per_status
