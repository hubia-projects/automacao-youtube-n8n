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

from pydantic import BaseModel, Field, PrivateAttr

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.library.requirement_index import CS_CONFIRMED, CS_NOT_REQUIRED
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
    revocações). Todos os shots semanticamente compatíveis — INCLUI
    genéricos para strict entities."""
    available_seconds: float = 0.0
    """Shots distintos (media_sha únicos) que carregam a entity."""
    available_distinct_shots: int = 0
    """UPSTREAM-FIX 2026-08-11 (code-reviewer #3): conjunto de shot_ids
    medidos para esta entity. Crucial para `is_workset_ready` validar
    OVERLAP com confirmed_index (em vez de só checar `len(confirmed)>0`,
    que aceita qualquer shot_id)."""
    available_shot_ids: set[str] = Field(default_factory=set)
    """UPSTREAM-FIX 2026-08-11 §P1: subconjunto dos available_shot_ids que
    foram CONFIRMADOS pelo Vision/DetectedEntity para esta entity.
    Vazio até o gate de coverage correr contra confirmed_index. Para
    entities strict, APENAS estes shots contam para secs/distinct."""
    strict_shot_ids: set[str] = Field(default_factory=set)
    """UPSTREAM-FIX 2026-08-11 §P1: soma da duração (t_out-t_in) apenas
    dos shot_ids em strict_shot_ids. Para entities strict, falhar este
    número < target significa PARTIAL/UNCONFIRMED mesmo que shots
    semanticamente compatíveis existam em quantidade."""
    strict_available_seconds: float = 0.0
    """UPSTREAM-FIX 2026-08-11 §P1: len(strict_shot_ids)."""
    strict_available_distinct_shots: int = 0
    """Ficheiros físicos (media_sha únicos)."""
    available_files: int = 0
    """déficit = max(target_seconds - available_seconds, 0).
    NOTA: para strict entities, esta coluna é SEMÂNTICA (não inclui
    strict_available_seconds separados). Ver strict_available_seconds."""
    deficit_seconds: float = 0.0
    """item PORTO/dedup (search+confirmation calibration): nomes
    alternativos da MESMA entidade (união de `EntitySpan.aliases` de
    todas as menções do bucket) — sem isto, `_ensure_mandatory_topics`
    não conseguia detectar que "Galerias de Paris" e "Rua Galeria de
    Paris" já eram a mesma entidade (o extractor já sabia, via
    EntityMention.aliases, mas o campo nunca chegava aqui), criando um
    requirement duplicado. Também alimenta a expansão de queries
    (variantes de busca por entidade, sem hardcode)."""
    aliases: tuple[str, ...] = ()
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
    """Runtime-only cache (PrivateAttr). Não serializa para JSON.
    Mapa shot_id -> duração efectiva (t_out capped per media_sha).
    Populado por measure_coverage e usado em is_workset_ready para
    calcular strict_available_seconds a partir de strict_shot_ids."""
    _per_shot_durations: dict[str, float] = PrivateAttr(default_factory=dict)


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
    scenes: list | None = None,
) -> list[EntityCoverage]:
    """Ordena entity_spans por prioridade (45% duração + 25% frequência
    + 20% importance + 10% specificity). Determinístico.

    `scenes` (item 6 — required_seconds correcto): quando fornecido, a
    duração REQUERIDA de cada entity vem da soma das janelas de `Scene`
    (`Scene.t_in`/`t_out`) cujo `primary_entity` é essa entity — a janela
    narrativa COMPLETA dedicada à entidade — em vez da duração do
    `EntitySpan` (que é só o alinhamento da FRASE que a nomeia, ex.:
    "Livraria Lello" dura ~1-2s de fala, mesmo dentro de uma cena de 15s
    sobre a livraria). Sem `scenes`, mantém o fallback por EntitySpan
    (retrocompatibilidade com chamadas antigas/testes sem Scene)."""
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

    scene_seconds: dict[str, float] = {}
    for sc in (scenes or []):
        pe = (getattr(sc, "primary_entity", "") or "").strip().lower()
        if not pe:
            continue
        scene_seconds[pe] = scene_seconds.get(pe, 0.0) + max(
            0.0, float(sc.t_out) - float(sc.t_in))

    out: list[EntityCoverage] = []
    for key, spans in buckets.items():
        canon = meta[key].canonical_name
        etype = meta[key].entity_type
        importance = float(meta[key].importance)
        strict = bool(meta[key].strict_visual)
        if key in scene_seconds:
            required_s = round(scene_seconds[key], 3)
        else:
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
        # item PORTO/dedup: união de aliases de TODAS as menções deste
        # bucket (dedup case-insensitive, preserva a 1ª grafia vista;
        # nunca inclui o próprio canonical_name como alias de si mesmo).
        seen_lower = {canon.strip().lower()}
        aliases: list[str] = []
        for sp in spans:
            for a in sp.aliases:
                a_norm = a.strip()
                if a_norm and a_norm.lower() not in seen_lower:
                    seen_lower.add(a_norm.lower())
                    aliases.append(a_norm)
        out.append(EntityCoverage(
            canonical_name=canon,
            entity_type=etype,
            priority_score=priority,
            mention_count=len(spans),
            required_seconds=required_s,
            target_seconds=0.0,    # preenchido depois com buffer
            min_distinct_shots=0,  # preenchido depois com shots_by_duration
            strict=strict,
            aliases=tuple(aliases),
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


def _union_seconds(intervals: list[tuple[float, float]]) -> float:
    """União de intervalos [t_in, t_out) — soma segundos SEM contar
    overlap duas vezes. Ex.: [(0,5),(4,9),(20,25)] → (0,9)+(20,25) = 14s,
    NÃO 25s (item 9 — max(t_out) por media_sha sobrestimava sempre que um
    media_sha tinha múltiplos shots disjuntos)."""
    ivs = sorted((lo, hi) for lo, hi in intervals if hi > lo)
    if not ivs:
        return 0.0
    total = 0.0
    cur_lo, cur_hi = ivs[0]
    for lo, hi in ivs[1:]:
        if lo <= cur_hi:
            cur_hi = max(cur_hi, hi)
        else:
            total += cur_hi - cur_lo
            cur_lo, cur_hi = lo, hi
    total += cur_hi - cur_lo
    return total


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
    # code-reviewer item #1+#2: API pública + união de intervalos por media_sha
    rows = db.iter_rows(clause, limit=20_000)
    if not rows:
        coverage.notes.append("sem shots na biblioteca — top-up obrigatório")
    dist_shots: set[str] = set()
    dist_files: set[str] = set()
    intervals_by_media: dict[str, list[tuple[float, float]]] = defaultdict(list)
    per_shot_dur: dict[str, float] = {}
    for r in rows:
        t_in = float(r.get("t_in", 0.0))
        t_out = float(r.get("t_out", 0.0))
        dur = max(0.0, t_out - t_in)
        shot_id = r.get("shot_id")
        if shot_id:
            dist_shots.add(shot_id)
            # item 9: preencher de facto (bug anterior: dict nunca escrito,
            # deixava strict_available_seconds sempre 0 em is_workset_ready).
            per_shot_dur[shot_id] = per_shot_dur.get(shot_id, 0.0) + dur
        sha = r.get("media_sha")
        if sha:
            dist_files.add(sha)
            intervals_by_media[sha].append((t_in, t_out))
    # segundos reais = união de intervalos por media_sha (não max(t_out) —
    # sobrestimava; não soma simples de shots — ignorava overlap).
    real_secs = sum(_union_seconds(ivs) for ivs in intervals_by_media.values())
    coverage.available_seconds = round(real_secs, 3)
    coverage.available_distinct_shots = len(dist_shots)
    coverage.available_files = len(dist_files)
    # UPSTREAM-FIX 2026-08-11: persiste o SET de shot_ids para validação
    # overlap em is_workset_ready() (code-reviewer #3). Sem este set,
    # gate aceita qualquer shot_id no confirmed_index, mesmo que esse
    # shot NÃO corresponda entity medida. Também cache por-shot dur
    # (PrivateAttr) para calcular strict_available_seconds.
    coverage.available_shot_ids = dist_shots
    coverage._per_shot_durations = per_shot_dur

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


def measure_coverage_from_index(
    coverage: "EntityCoverage",
    workset_ctx,
    ri,
    db: LibraryDB,
) -> bool:
    """item E/F/G (closure pass): RequirementIndex como fonte primária de
    coverage — em vez de rescanear a biblioteca por LIKE textual
    (`measure_coverage`, sujeito a falsos positivos/negativos de
    substring), usa os matches JÁ persistidos e semanticamente filtrados
    por `requirement_matching.matches_for_shot` (cosine contra
    requirement_embeddings/visual_prompt_embeddings).

    Só aplica quando o workset tem uma RequirementSpec para esta entity
    (`workset_ctx.req_by_canonical`) E a RequirementIndex já tem pelo
    menos 1 match para essa requirement — caso contrário (workset
    novo/frio, ainda sem `index_existing_shots_against_workset` corrido)
    devolve False e o caller mantém `measure_coverage()` (scan CSV) como
    fallback — nunca regride para pior que o comportamento anterior.

    Muta `coverage` in-place (mesmo contrato de `measure_coverage`).
    Devolve True se aplicou, False se fallback é necessário.
    """
    if workset_ctx is None or ri is None:
        return False
    spec = workset_ctx.req_by_canonical(coverage.canonical_name)
    if spec is None:
        return False
    matches = ri.list_for_requirement(workset_ctx.workset_id, spec.requirement_id)
    if not matches:
        return False

    eligible_statuses = ({CS_CONFIRMED} if coverage.strict
                         else {CS_CONFIRMED, CS_NOT_REQUIRED})
    eligible = [m for m in matches if m.confirmation_status in eligible_statuses]
    if not eligible:
        # há matches (PENDING/REJECTED) mas nenhum elegível ainda — 0
        # disponível é uma resposta VÁLIDA do índice (não um "sem dados"
        # que justificasse cair no fallback CSV, que ignoraria o gate de
        # confirmação estrito).
        coverage.available_seconds = 0.0
        coverage.available_distinct_shots = 0
        coverage.available_files = 0
        coverage.available_shot_ids = set()
        coverage._per_shot_durations = {}
        return True

    dist_shots = {m.shot_id for m in eligible}
    intervals_by_media: dict[str, list[tuple[float, float]]] = defaultdict(list)
    per_shot_dur: dict[str, float] = {}
    dist_files: set[str] = set()
    for shot_id in dist_shots:
        row = db.get_shot(shot_id)
        if not row:
            continue
        t_in = float(row.get("t_in", 0.0))
        t_out = float(row.get("t_out", 0.0))
        per_shot_dur[shot_id] = max(0.0, t_out - t_in)
        sha = row.get("media_sha")
        if sha:
            dist_files.add(sha)
            intervals_by_media[sha].append((t_in, t_out))
    real_secs = sum(_union_seconds(ivs) for ivs in intervals_by_media.values())
    coverage.available_seconds = round(real_secs, 3)
    coverage.available_distinct_shots = len(dist_shots)
    coverage.available_files = len(dist_files)
    coverage.available_shot_ids = dist_shots
    coverage._per_shot_durations = per_shot_dur
    return True


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


# ----------------- item 7 — contextual filler -----------------
FILLER_ENTITY_TYPE = "filler"


def measure_filler_coverage(
    coverage: EntityCoverage,
    db: LibraryDB,
    *,
    min_quality: int = 4,
    exclude_shot_ids: set[str] | None = None,
    location: str = "",
) -> EntityCoverage:
    """Mede cobertura GENÉRICA (sem match por nome de entity) — candidatos
    para preencher janelas narrativas sem anchor strict. `exclude_shot_ids`
    evita que o filler "reclame" para si shots já candidatos de uma
    requirement core (não impede reuse — a feasibility final é decidida na
    camada de selecção, item 10 — mas evita medir cobertura inflada aqui).

    `location` (item H — closure pass): quando não vazio, restringe a
    genérico à mesma geografia do vídeo (places_csv OU landmarks_csv) —
    sem isto, filler "contextual" aceitava QUALQUER shot não-revogado,
    incluindo b-roll de outra cidade/país. Vazio = sem filtro (retro-compat
    com chamadas antigas/testes sem ThemeSpec.location)."""
    clause = f"quality >= {int(min_quality)} AND revoked = false"
    if location:
        # escapa aspas (quebra de string — o único vector de injecção real
        # neste dialecto DataFusion/LanceDB, que não trata `\` como escape
        # LIKE sem uma clause ESCAPE explícita). `location` vem de
        # ThemeSpec/CLI — mesmo trust boundary (operador, não input remoto
        # não confiável) que os outros WHERE clauses desta camada
        # (`_entity_match_clause`, negative-cache lens abaixo).
        loc_safe = location.strip().replace("'", "''")
        clause += (f" AND (places_csv LIKE '%{loc_safe}%' "
                   f"OR landmarks_csv LIKE '%{loc_safe}%')")
    rows = db.iter_rows(clause, limit=20_000)
    exclude = exclude_shot_ids or set()
    if not rows:
        coverage.notes.append("sem shots na biblioteca — top-up obrigatório")
    dist_shots: set[str] = set()
    dist_files: set[str] = set()
    intervals_by_media: dict[str, list[tuple[float, float]]] = defaultdict(list)
    per_shot_dur: dict[str, float] = {}
    for r in rows:
        shot_id = r.get("shot_id")
        if shot_id and shot_id in exclude:
            continue
        t_in = float(r.get("t_in", 0.0))
        t_out = float(r.get("t_out", 0.0))
        dur = max(0.0, t_out - t_in)
        if shot_id:
            dist_shots.add(shot_id)
            per_shot_dur[shot_id] = per_shot_dur.get(shot_id, 0.0) + dur
        sha = r.get("media_sha")
        if sha:
            dist_files.add(sha)
            intervals_by_media[sha].append((t_in, t_out))
    real_secs = sum(_union_seconds(ivs) for ivs in intervals_by_media.values())
    coverage.available_seconds = round(real_secs, 3)
    coverage.available_distinct_shots = len(dist_shots)
    coverage.available_files = len(dist_files)
    coverage.available_shot_ids = dist_shots
    coverage._per_shot_durations = per_shot_dur
    return coverage


def build_filler_requirement(
    ranked_entities: list[EntityCoverage],
    total_script_seconds: float,
    settings: Settings,
    *,
    topic: str = "",
    location: str = "",
) -> EntityCoverage | None:
    """Requirement sintético que cobre `target_duration - core_seconds`
    (soma dos required_seconds das entities core). `None` se o core já
    cobre toda a timeline (nada a preencher).

    NUNCA satisfaz requirement strict (strict=False sempre) e tem
    priority_score mínimo — core antes de filler em qualquer alocação
    (item 10, greedy determinístico: strict/core primeiro)."""
    core_seconds = sum(e.required_seconds for e in ranked_entities)
    filler_seconds = round(max(0.0, total_script_seconds - core_seconds), 3)
    if filler_seconds <= 0.0:
        return None
    target = round(filler_seconds * settings.coverage_buffer, 3)
    min_shots = max(
        1, -(-int(target) // int(max(1.0, settings.min_shots_by_duration))))
    canon = f"filler:{topic}".strip(":") or "filler"
    ent = EntityCoverage(
        canonical_name=canon,
        entity_type=FILLER_ENTITY_TYPE,
        priority_score=-1.0,
        mention_count=0,
        required_seconds=filler_seconds,
        target_seconds=target,
        min_distinct_shots=min_shots,
        strict=False,
        location=location,
    )
    ent.notes.append("contextual filler — preenche o tempo restante da "
                     "timeline; nunca satisfaz requirement strict")
    loc_q = f"{location or 'Portugal'} b-roll cityscape street scene".strip()
    ent.queries = [loc_q, "generic b-roll cityscape street scene"]
    return ent


# ----------------- write_plan -----------------
def build_coverage_plan(
    entity_spans: list[EntitySpan],
    db: LibraryDB,
    settings: Settings,
    *,
    topic: str = "",
    total_script_seconds: float | None = None,
    extra_features_by_entity: dict[str, list[str]] | None = None,
    scenes: list | None = None,
    include_filler: bool = False,
    location: str = "",
) -> CoveragePlan:
    """Constroi o CoveragePlan completo: ranking + measure + queries.

    `scenes` (item 6): ver `rank_entity_importance` — quando fornecido,
    required_seconds usa a janela narrativa da Scene, não a duração da
    frase do EntitySpan.

    `include_filler` (item 7): quando True, acrescenta ao fim de
    `ranked_entities` uma EntityCoverage sintética (`FILLER_ENTITY_TYPE`)
    cobrindo o tempo da timeline não atribuído a nenhuma entity core.
    Default False para não alterar o shape do plano em chamadas antigas.

    Idempotente — sem estado partilhado. Determinístico byte-equality
    se entidades e library forem iguais (sem uso de GPU/timestamps).
    """
    # 1) obter duração do script se não foi passada (soma t_out spans)
    if total_script_seconds is None:
        if scenes:
            total_script_seconds = max(sc.t_out for sc in scenes)
        elif entity_spans:
            total_script_seconds = max(s.t_out for s in entity_spans)
        else:
            total_script_seconds = 0.0
    total_script_seconds = round(total_script_seconds, 3)

    # 2) ranking base (sem measure)
    ranked = rank_entity_importance(
        entity_spans,
        total_script_seconds=total_script_seconds,
        topic=topic,
        scenes=scenes,
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
        # BUG CORRIGIDO (item H closure pass): esta variável chamava-se
        # `location` — colidia com o parâmetro `location` da função
        # (ThemeSpec.location, item H), sobrescrevendo-o silenciosamente a
        # cada iteração. O bloco `include_filler` abaixo lia sempre o
        # `location` da ÚLTIMA entity iterada (tipicamente "") em vez do
        # `location` do vídeo passado pelo caller.
        ent_location = _loc_index.get(ent.canonical_name.strip().lower(), "")
        # code-reviewer item #3: entity strict NÃO recebe nível 4
        # (contexto genérico sem entity) — top-up futuro cai em tentação de
        # buscar "Porto food dish" quando precisamos Francesinha explícita.
        query_levels = (settings.query_levels - 1) if ent.strict else settings.query_levels
        ent.location = ent_location  # Fase D fix-2: persiste location no plano
        ent.queries = build_query_hierarchy(
            ent.canonical_name,
            location=ent_location,
            entity_type=ent.entity_type,
            features=(extra_features_by_entity or {}).get(ent.canonical_name, []),
            levels=query_levels,
        )

    # 3b) filler contextual (item 7) — opt-in, sempre depois das entities
    # core já medidas (precisa dos required_seconds finais para saber o
    # deficit de timeline).
    if include_filler:
        # item H (closure pass): location REAL do ThemeSpec (ex.: "Porto")
        # em vez do genérico "Portugal" — sem isto, o filler não tinha
        # nenhum viés geográfico e podia devolver b-roll de outra cidade.
        #
        # BUG REAL CORRIGIDO (item 1.7-bis, automation closure): a versão
        # anterior tinha um fallback "usa a location de QUALQUER entity
        # core" quando `location` (ThemeSpec) vinha vazio. Isso criava um
        # ciclo vicioso quando a única entity core partilhava a MESMA
        # location inferida: o filler ficava geo-filtrado exactamente aos
        # MESMOS shots já reclamados por essa entity (`exclude_ids`),
        # zerando `available_seconds` do filler mesmo com biblioteca
        # abundante (45 shots livres, todos excluídos por engano). Filler
        # só deve usar a location do OPERADOR (ThemeSpec.location); sem
        # ela, fica sem filtro geográfico (comportamento explícito, não um
        # palpite por entity).
        filler_location = location
        filler_ent = build_filler_requirement(
            ranked, total_script_seconds, settings, topic=topic,
            location=filler_location)
        if filler_ent is not None:
            exclude_ids: set[str] = set()
            for e in ranked:
                exclude_ids |= e.available_shot_ids
            measure_filler_coverage(filler_ent, db, exclude_shot_ids=exclude_ids,
                                    location=filler_location)
            filler_ent.deficit_seconds = round(
                max(0.0, filler_ent.target_seconds - filler_ent.available_seconds), 3)
            ranked.append(filler_ent)

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

    # UPSTREAM-FIX §P1: para strict, populamos strict_shot_ids /
    # strict_available_seconds / strict_available_distinct_shots fazendo
    # overlap entre confirmed_index e available_shot_ids. summary_secs
    # vem do cache privado _per_shot_durations.
    if confirmed_index is not None:
        for ent in plan.ranked_entities:
            if not ent.strict:
                ent.strict_shot_ids = set()
                ent.strict_available_seconds = 0.0
                ent.strict_available_distinct_shots = 0
                continue
            canon_low = ent.canonical_name.strip().lower()
            confirmed = confirmed_index.get(canon_low, [])
            confirmed_set = {str(s) for s in confirmed}
            strict_set = confirmed_set & ent.available_shot_ids
            ent.strict_shot_ids = strict_set
            ent.strict_available_distinct_shots = len(strict_set)
            ent.strict_available_seconds = round(
                sum(ent._per_shot_durations.get(sid, 0.0)
                    for sid in strict_set), 3
            )

    per_status: dict[str, str] = {}
    strict_uncovered: list[str] = []

    for ent in plan.ranked_entities:
        # UPSTREAM-FIX §P1 (2026-08-11, re-aplicado após teste falhar):
        # strict e non-strict têm ramos TOTALMENTE separados. Spec §P1
        # diz: para entities strict, o estado é SEMPRE UNCONFIRMED até
        # strict_overlap >= min_shots E strict_secs >= target. Apenas
        # NOT_FOUND se nem houver candidatos semânticos disponíveis
        # (biblioteca realmente vazia para esta entity).
        if ent.strict:
            if ent.available_seconds <= 0:
                per_status[ent.canonical_name] = _RSTATUS_NOT_FOUND
            elif confirmed_index is None:
                # sem oráculo Vision: strict é sempre UNCONFIRMED
                per_status[ent.canonical_name] = _RSTATUS_UNCONFIRMED
                strict_uncovered.append(ent.canonical_name)
            else:
                secs = ent.strict_available_seconds
                shots = ent.strict_available_distinct_shots
                if secs >= ent.target_seconds and shots >= ent.min_distinct_shots:
                    per_status[ent.canonical_name] = _RSTATUS_COVERED
                else:
                    # confirmou existe mas insuficiente: UNCONFIRMED
                    per_status[ent.canonical_name] = _RSTATUS_UNCONFIRMED
                    strict_uncovered.append(ent.canonical_name)
        else:
            # non-strict: matching semântico (SigLIP-compatible)
            secs = ent.available_seconds
            shots = ent.available_distinct_shots
            if secs >= ent.target_seconds and shots >= ent.min_distinct_shots:
                per_status[ent.canonical_name] = _RSTATUS_COVERED
            elif secs <= 0:
                per_status[ent.canonical_name] = _RSTATUS_NOT_FOUND
            else:
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
        # UPSTREAM-CHANGE 2026-08-11 (code-reviewer #2): strict entities
        # nunca caem em PARTIAL no novo branch; são COVERED ou
        # UNCONFIRMED. Contamos UNCONFIRMED separado para que o
        # operador continue a ver o deficit strict sem ser ignorado pelo
        # "partial_count" legacy.
        "unconfirmed_count": sum(1 for v in per_status.values()
                                  if v == _RSTATUS_UNCONFIRMED),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2),
                         "utf-8")
    return ready, per_status
