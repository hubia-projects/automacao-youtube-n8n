"""Atribuição cena→shots com constraints editoriais (ARCHITECTURE §1.4/§8).

- must_not é filtro DURO (feito na busca);
- shot usado ≤1× por vídeo; ficheiro fonte ≤3× por vídeo;
- penalização por uso em vídeos anteriores (cooldown);
- cenas longas são preenchidas com vários segmentos, duração por beat;
- pool vazio → top-up JIT (Pexels → ingestão → re-busca) ou PoolExhausted.
"""

from __future__ import annotations

import concurrent.futures
import logging
import math

from pydantic import BaseModel, Field

from studio.config import Settings
from studio.library.db import LibraryDB
from studio.library.embed import Embedder
from studio.library.search import search_shots
from studio.matching.briefs import VisualBrief
from studio.script.scenes import Scene

log = logging.getLogger("studio.assigner")

# SPRINT B: limite para pre-flight top-up batch (não usar mais de 4 sweeps
# em paralelo — combina com o _DOWNLOAD_MAX_WORKERS dentro de sweep).
_PREFLIGHT_MAX_WORKERS = 4

# bandas de duração de shot por beat narrativo (segundos)
BEAT_BANDS: dict[str, tuple[float, float]] = {
    "hook": (1.8, 2.8), "context": (4.0, 6.0), "reveal": (3.0, 5.0),
    "detail": (3.0, 5.0), "transition": (2.0, 4.0), "payoff": (4.0, 7.0),
    "cta": (3.0, 6.0),
}
MAX_USES_PER_FILE = 3
MIN_SEGMENT_S = 0.75
POOL_K = 40

# grupos regionais conhecidos na biblioteca (ver LIBRARY_POLICY.md). Um vídeo
# sobre um grupo nunca deve receber shots etiquetados noutro grupo — a busca
# ANN sozinha confunde "estação de trem" ou "rua com pessoas" entre países.
REGION_GROUPS: dict[str, list[str]] = {
    "portugal": ["Lisbon", "Lisboa", "Porto", "Sintra", "Douro", "Algarve",
                 "Madeira", "Almada", "Óbidos", "Coimbra", "Azores",
                 "Câmara de Lobos", "Belém", "Portugal", "Portuguese"],
    "brazil": ["Rio de Janeiro", "São Paulo", "Salvador", "Bahia", "Iguazu",
               "Brazil", "Brazilian", "Brasil"],
    "other_foreign": ["Budapest", "Seoul", "Barcelona", "Paris", "Berlin",
                      "German", "Hungary", "France", "Spain", "Korea",
                      "Greece", "Greek", "Athens", "New York", "NYC",
                      "USA", "America", "Asia", "Asian", "China", "Japan",
                      "Italy", "Rome", "London", "England",
                      # vazamentos confirmados pelo revisor no run 20260714-102323
                      "Moscow", "Russia", "Russian", "Shanghai", "Beijing",
                      "Cape Town", "South Africa", "Table Mountain",
                      "United Kingdom", "Britain", "British", "Scotland",
                      "Ireland", "Meteora", "Thessaly", "Santorini",
                      "Istanbul", "Turkey", "Dubai", "India", "Thailand",
                      "Vietnam", "Bali", "Indonesia", "Mexico", "Argentina",
                      "Peru", "Amsterdam", "Netherlands", "Vienna", "Austria",
                      "Switzerland", "Prague", "Czech"],
}

# Duas cidades do MESMO grupo regional (ex: Lisboa e Porto são ambas
# "portugal") não se distinguem pelo REGION_GROUPS — precisam do seu próprio
# filtro quando a cena/brief nomeia uma delas especificamente.
CITY_GROUPS: dict[str, list[str]] = {
    "lisbon": ["Lisbon", "Lisboa", "Belém", "Alfama", "Sintra", "Jerónimos",
              "Rossio", "Baixa", "Chiado", "Alcântara", "25 de Abril",
              "Praça do Comércio", "Castelo de São Jorge", "Rua Augusta",
              "Padrão dos Descobrimentos", "Santa Justa"],
    "porto": ["Porto", "Ribeira", "Vila Nova de Gaia", "Douro", "Foz",
             "Clérigos", "São Bento", "Bolhão", "Dom Luís", "Luís I",
             "Livraria Lello", "Palácio da Bolsa"],
}


def _region_exclude_terms(topic: str) -> list[str]:
    """Termos de lugar a EXCLUIR (filtro duro) por deteção do grupo do tema.
    Sem grupo detetado → sem exclusão (não estreita pool de vídeos fora do
    nicho PT/BR mapeado)."""
    low = topic.lower()
    active = next((g for g, terms in REGION_GROUPS.items()
                  if any(t.lower() in low for t in terms)), None)
    if not active:
        return []
    return [t for g, terms in REGION_GROUPS.items() if g != active for t in terms]


def _city_exclude_terms(*texts: str) -> list[str]:
    """Dentro do mesmo país, distingue cidade (ex: cena fala de Lisboa →
    exclui shots etiquetados Porto, e vice-versa). Ambígua/sem menção → []."""
    blob = " ".join(texts).lower()
    mentioned = [city for city, terms in CITY_GROUPS.items()
                if any(t.lower() in blob for t in terms)]
    if len(mentioned) != 1:
        return []
    active = mentioned[0]
    return [t for city, terms in CITY_GROUPS.items() if city != active for t in terms]


class PoolExhausted(RuntimeError):
    def __init__(self, scene_id: str):
        super().__init__(f"pool esgotado para cena {scene_id} — biblioteca precisa de seed/top-up")


class SceneStrictCoverageGap(RuntimeError):
    """Fase F — fail-closed: cena strict (entity visual obrigatória) sem shots
    confirmados pelo oráculo Vision (DetectedEntity >= threshold).

    Nunca degrada para B-roll genérico: a causa-raiz do score baixo era
    mostrar "francesinha" quando a narração dizia "Livraria Lello". Uma cena
    strict só pode ser preenchida com footage cuja identidade foi confirmada.
    """

    def __init__(self, *, scene_id: str, entity: str, entity_type: str = "",
                 deficit_seconds: float = 0.0, ranked_plan: str = ""):
        self.scene_id = scene_id
        self.entity = entity
        self.deficit_seconds = deficit_seconds
        super().__init__(
            f"SceneStrictCoverageGap: cena {scene_id} exige a entity "
            f"'{entity}' (type={entity_type or '?'}) confirmada visualmente, "
            f"mas nenhum shot foi confirmado (deficit={deficit_seconds:.1f}s). "
            f"Plano ranqueado: {ranked_plan or '(vazio)'}")


def _ranked_plan_summary(coverage_plan) -> str:
    """Resumo legível do coverage_plan (top-5 por prioridade) para a
    mensagem de SceneStrictCoverageGap — o operador vê o ranking completo
    sem abrir o JSON do plano."""
    if coverage_plan is None or not coverage_plan.ranked_entities:
        return "(plano vazio)"
    top = coverage_plan.ranked_entities[:5]
    return "; ".join(
        f"{e.canonical_name}(prio={e.priority_score:.2f}, "
        f"deficit={e.deficit_seconds:.1f}s)" for e in top)


class SegmentAssignment(BaseModel):
    scene_id: str
    beat: str
    seg_index: int
    t_in: float          # tempo absoluto no vídeo (narração)
    t_out: float
    shot_id: str
    media_path: str
    media_sha: str
    source_in: float     # janela dentro do media original
    source_out: float
    shot_type: str = ""
    camera_motion: str = ""
    summary: str = ""
    has_food: bool = False
    has_landmark: bool = False
    attribution_text: str = ""
    # Fase G (FIX-1 CRÍTICO code-reviewer): colunas de CSV do shot
    # LINKADAS AQUI para que `validate_alignment()` possa comparar entity
    # sem voltar à BD. Defaults = "" garante retro-compat com runs/lances
    # da Fase F (não-preenchidos). Preenchido por
    # `_attach_segment_metadata()` no S08Matching (módulos strict, pydantic-
    # safe via `model_copy(update=...)`).
    places_csv: str = ""
    landmarks_csv: str = ""
    food_csv: str = ""

    model_config = {"extra": "allow"}


class AssignmentResult(BaseModel):
    segments: list[SegmentAssignment]
    unfilled_scenes: list[str] = Field(default_factory=list)
    topups_triggered: int = 0
    # política de degradação nomeada (doutrina fail-closed): cenas onde o pool
    # só encheu com relaxamento. must_not NUNCA é relaxado.
    relaxations: dict[str, str] = Field(default_factory=dict)


def _jit_topup(brief: VisualBrief, db: LibraryDB, embedder: Embedder,
               settings: Settings, query: str | None = None) -> int:
    """Busca dirigida → mesma ingestão → biblioteca cresce. Devolve shots novos.
    `query` sobrepõe o assunto do brief (usado para top-up por entidade)."""
    if settings.mock_mode or not settings.pexels_api_key:
        return 0
    # P3 (2026-08-11): migrate assigner de ingest_file → ingest_asset.
    # import lazy: ingestar é caminho cold (raro chamado em --workflow mode).
    from studio.library.ingest_asset import ingest_asset
    from studio.library.sources.pexels import sweep

    q = query or brief.visual_subject_en
    added = 0
    dest = settings.library_root / "downloads"
    try:
        for path, lic in sweep(q, 3, settings, dest):
            src_url = ((lic or {}).get("source_url", "")
                       if isinstance(lic, dict) else
                       getattr(lic, "source_url", "") or path.name)
            r, _ = ingest_asset(
                path, lic, db, settings, embedder,
                source_id=src_url,
                video_id=None,
            )
            added += r.shots_added
    except Exception as exc:  # top-up é best-effort; a falha dura é PoolExhausted
        log.warning("top-up JIT falhou (%s): %s", q, exc)
    return added


def _preflight_topups(missing_queries: set[str], db: LibraryDB,
                      embedder: Embedder, settings: Settings) -> int:
    """SPRINT B Fase 2: top-ups em batch com pre-flight dedupe.

    Em vez de cada cena fazer o seu próprio `_jit_topup` sequencialmente
    (que se traduz em ~15-20 sweeps × ~30-100s cada = horas), agrupamos
    AS QUERIES ÚNICAS em falta, lançamos sweeps em paralelo (apenas
    I/O de rede, GIL-livre), e fazemos a INGESTÃO SEQUENCIALMENTE a
    seguir (GPU SigLIP + LanceDB não são thread-safe).

    Devolve o nº total de topups despoletados (para contabilidade no
    AssignmentResult.topups_triggered).
    """
    if settings.mock_mode or not settings.pexels_api_key or not missing_queries:
        return 0

    # P3 (2026-08-11): migrate assigner pre-flight de ingest_file → ingest_asset.
    from studio.library.ingest_asset import ingest_asset
    from studio.library.sources.pexels import sweep

    dest = settings.library_root / "downloads"
    workers = min(_PREFLIGHT_MAX_WORKERS, len(missing_queries))
    log.info("pre-flight: top-up em batch para %d entidades: %s (workers=%d)",
             len(missing_queries), sorted(missing_queries), workers)

    # Downloads paralelos por query (sweep() já é paralelo internamente — Fase 1)
    all_paths_lics: list[tuple[Path, dict, str]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(sweep, q, 3, settings, dest): q for q in missing_queries}
        for fut in concurrent.futures.as_completed(futs):
            q = futs[fut]
            try:
                results = fut.result()  # list[(Path, lic)] NA ORDEM
            except Exception as exc:
                log.warning("pre-flight sweep '%s' falhou: %s", q, exc)
                continue
            for p, lic in results:
                all_paths_lics.append((p, lic, q))
            log.info("pre-flight: '%s' devolveu %d vídeos", q, len(results))

    # Ingestão SEQUENCIAL — protege SigLIP CUDA (4 GB VRAM) e LanceDB.
    # P3 (2026-08-11): ingest_asset (canonical) — DB verify + state machine.
    # O dedupe SHA em ingest_asset torna isto idempotente (re-entradas viram
    # skipped_duplicate sem inserir nada).
    log.info("pre-flight: a ingerir %d ficheiros sequencialmente...", len(all_paths_lics))
    for path, lic, q in all_paths_lics:
        try:
            src_url = ((lic or {}).get("source_url", "")
                       if isinstance(lic, dict) else
                       getattr(lic, "source_url", "") or path.name)
            ingest_asset(
                path, lic, db, settings, embedder,
                source_id=src_url,
                video_id=None,
            )
        except Exception as exc:
            log.warning("pre-flight ingest de '%s' (%s) falhou: %s",
                        path.name, q, exc)
    return len(missing_queries)  # contagem = queries tentadas (não ficheiros)


def _score(cand: dict, used_files: dict[str, int],
          entity_terms: list[str] | None = None, *,
          settings: Settings | None = None,
          confirmed_ids: set[str] | None = None,
          geography_terms: list[str] | None = None) -> float:
    """Score de ranking do pool. Fase F: pesos lidos de Settings (SSoT);
    `confirmed_ids` (shots confirmados por Vision) recebem confirmation_bonus;
    `geography_terms` (termos de lugar excluídos) aplicam geography_penalty
    como segunda linha de defesa atrás do filtro duro do search."""
    if settings is None:
        w_sim, w_quality = 1.0, 0.02
        w_usage, w_diversity = 0.15, 0.10
        w_land, w_place, w_miss = 0.20, 0.15, 0.10
        w_conf, w_geo = 0.15, 0.30
    else:
        w_sim = settings.assign_score_similarity
        w_quality = settings.assign_score_quality_bonus
        w_usage = settings.assign_score_usage_cooldown
        w_diversity = settings.assign_score_source_diversity
        w_land = settings.assign_score_entity_match_bonus
        w_place = settings.assign_score_entity_match_place_bonus
        w_miss = settings.assign_score_entity_miss_penalty
        w_conf = settings.assign_score_confirmation_bonus
        w_geo = settings.assign_score_geography_penalty

    score = (w_sim * cand["similarity"]
             + w_quality * cand["quality"]
             - w_usage * cand.get("usage_count", 0)          # cooldown entre vídeos
             - w_diversity * used_files.get(cand["media_sha"], 0))  # variedade de fonte
    # Entity-match bonus (A1+A2, mutuamente exclusivos pós code-reviewer):
    # A entity em landmarks_csv vale +0.20 (mais raro/preciso); só em
    # places_csv vale +0.15; sem match → -0.10 explícita. Nunca cumulativo
    # (dupla etiqueta "Casa da Música" em ambos os campos no seed PT).
    if entity_terms and any(e.strip() for e in entity_terms):
        places = (cand.get("places_csv", "") or "").lower()
        landmarks = (cand.get("landmarks_csv", "") or "").lower()
        in_place = any(e.lower() in places for e in entity_terms)
        in_land = any(e.lower() in landmarks for e in entity_terms)
        if in_land:
            score += w_land
        elif in_place:
            score += w_place
        else:
            # Penalty explícita A1: cena com entity estrita não pode cair
            # num genérico compatível com SigLIP.
            score -= w_miss
    # Fase F — ground-truth Vision: shot confirmado fica acima de qualquer
    # genérico, mesmo com similarity ligeiramente inferior.
    if confirmed_ids and cand["shot_id"] in confirmed_ids:
        score += w_conf
    # Fase F — geografia vence entity: metadados citam lugar excluído
    # (ex: Lisbon num vídeo do Porto) → penalidade explícita.
    if geography_terms:
        blob = ((cand.get("places_csv", "") or "") + ","
                + (cand.get("landmarks_csv", "") or "")).lower()
        if any(t.strip().lower() in blob for t in geography_terms):
            score -= w_geo
    return score


def assign_shots(scenes: list[Scene], briefs: list[VisualBrief], db: LibraryDB,
                 embedder: Embedder, settings: Settings, run_id: str,
                 excluded_shot_ids: set[str] | None = None,
                 topic: str = "",
                 coverage_plan=None,
                 confirmed_entities: dict[str, list[dict]] | None = None,
                 ) -> AssignmentResult:
    """Fase F: `confirmed_entities` = {canonical_lower: [shot rows com
    `__confirmation` DetectedEntity]} gerado em S08Matching via
    require_entity_confirmation(strict_only=True). Quando fornecido (não
    None), cenas strict (brief.strict_entity + required_entity) são
    fail-closed: pool = busca (geografia + categorias) ∩ confirmados;
    sem confirmação → SceneStrictCoverageGap. Continuidade: nunca degrada
    para B-roll a meio da cena strict. None (legacy) = comportamento
    idêntico pré-Fase F."""

    from studio.library.inventory import entity_vocab, resolve_entity

    brief_by_scene = {b.scene_id: b for b in briefs}
    exclude_places = _region_exclude_terms(topic)
    vocab = entity_vocab(db)
    hard_excluded: set[str] = set(excluded_shot_ids or set())  # nunca voltam (fixes)
    used_shots: set[str] = set(hard_excluded)
    used_files: dict[str, int] = {}
    segments: list[SegmentAssignment] = []
    unfilled: list[str] = []
    topups = 0

    relaxations: dict[str, str] = {}

    # === SPRINT B Fase 2 — PRE-FLIGHT TOP-UP BATCH ========================
    # Antes de iterar cenas, recolhe TODAS as `required_entity` em falta e
    # despoleta UMA ronda de sweeps únicos em paralelo (Fase 1 já paraleliza
    # os downloads dentro de cada sweep). Isso transforma o padrão "6 cenas
    # pedem 'Livraria Lello' → 6× search + 6× download" em "1× search +
    # download em paralelo". Poupa-se ~6× em vídeos com muitas entidades
    # repetidas e mantém determinismo (vocab refresh 1× no fim).
    # Fase D FIX-1: pre-construir deficit_by_entity para W contextual
    # por cena durante o assign. Quando uma cena cita entity com deficit
    # estrutural no plano E o pool fica vazio depois de top-up JIT,
    # o warning deixa o operador ver o sinal (não muda lógica do match).
    _deficit_by_entity: dict[str, float] = {}
    if coverage_plan is not None:
        for _ec in coverage_plan.ranked_entities:
            if _ec.deficit_seconds > 0 and _ec.canonical_name:
                _deficit_by_entity[_ec.canonical_name.strip().lower()] = (
                    _ec.deficit_seconds)
    missing_q: set[str] = set()
    for scene in scenes:
        b = brief_by_scene.get(scene.scene_id)
        if b and b.required_entity and not resolve_entity(b.required_entity, vocab):
            missing_q.add(b.required_entity)
    if missing_q:
        topups += _preflight_topups(missing_q, db, embedder, settings)
        vocab = entity_vocab(db)  # refresh 1× — todas as cenas partem deste vocab
    # =========================================================================

    # FIX 3 (code-reviewer Fase D): info log ANTES do loop para cada
    # cena cuja required_entity tem deficit estrutural no plano. Operador
    # vê no dashboard mesmo quando _preflight_topups fecha o gap.
    # FIX-3 W: construir dict lookup 1× para evitar double lookup no loop.
    _per_scene_deficit: dict[str, float] = {}
    if coverage_plan is not None:
        for scene in scenes:
            _b = brief_by_scene.get(scene.scene_id)
            if _b and _b.required_entity:
                _key = _b.required_entity.strip().lower()
                _per_scene_deficit[scene.scene_id] = (
                    _deficit_by_entity.get(_key, 0.0))
                if _per_scene_deficit[scene.scene_id] > 0:
                    log.info("assigner: cena %s entidade '%s' tinha "
                             "deficit=%.1fs no plano (Phase G alignment "
                             "validator vai validar pós-match)",
                             scene.scene_id, _b.required_entity,
                             _per_scene_deficit[scene.scene_id])

    for scene in scenes:
        brief = brief_by_scene[scene.scene_id]
        band_min, band_max = BEAT_BANDS.get(scene.beat, (3.0, 5.0))
        # geografia da cena: exclusão de região (vídeo todo) + exclusão de
        # cidade (também do TÓPICO do vídeo — cenas sem nomear cidade não
        # fogem do âncora principal, ex: tema "Porto" não aceita shots Lisboa)
        scene_exclude = exclude_places + _city_exclude_terms(
            scene.text, brief.visual_subject_en, topic)

        # Fase F — Strict Matching: cena strict (entity visual obrigatória)
        # só aceita shots CONFIRMADOS pelo oráculo Vision (DetectedEntity).
        # confirmed_ids = ground-truth resolvido em S08Matching.
        entity_key = (brief.required_entity or "").strip().lower()
        is_strict = bool(brief.strict_entity and brief.required_entity
                         and confirmed_entities is not None)
        confirmed_ids: set[str] = set()
        if is_strict:
            confirmed_ids = {c["shot_id"]
                             for c in confirmed_entities.get(entity_key, [])}
            if not confirmed_ids:
                # fail-closed: sem confirmação visual não há matching.
                raise SceneStrictCoverageGap(
                    scene_id=scene.scene_id, entity=brief.required_entity,
                    entity_type=brief.required_entity_type,
                    deficit_seconds=_deficit_by_entity.get(entity_key, 0.0),
                    ranked_plan=_ranked_plan_summary(coverage_plan))

        # entidade nomeada pela narração: TEM de aparecer nos metadados do
        # shot. Se a biblioteca não a tem, top-up dirigido (Pexels pela
        # entidade); se continuar sem ela, degrada para genérico REGISTADO.
        entity_terms: list[str] = []
        if brief.required_entity and not is_strict:
            entity_terms = resolve_entity(brief.required_entity, vocab)
            if not entity_terms and not settings.mock_mode:
                topups += 1
                if _jit_topup(brief, db, embedder, settings,
                              query=brief.required_entity) > 0:
                    vocab = entity_vocab(db)
                    entity_terms = resolve_entity(brief.required_entity, vocab)
            if not entity_terms:
                relaxations[scene.scene_id] = \
                    f"entity_unavailable:{brief.required_entity}"
                # Fase D FIX-1: warning contextual quando coverage_plan já
                # indicava deficit estrutural — operador vê o sinal claro.
                # FIX-3 W: usa cache _per_scene_deficit (sem double lookup).
                _d = _per_scene_deficit.get(scene.scene_id, 0.0)
                if _d and _d > 0:
                    log.warning("assigner: cena %s requerida '%s' mas "
                                "coverage_plan apontava deficit=%.1fs — "
                                "top-up JIT não fechou", scene.scene_id,
                                brief.required_entity, _d)
        elif brief.required_entity:
            # strict: o termo de busca é o canonical (lower) — os shots
            # confirmados carregam-no no CSV por construção do confirmation.
            entity_terms = [entity_key]

        # escada de relaxamento: must_not (a guarda anti-mismatch) nunca cede;
        # a entidade cai apenas no degrau drop_must_have (registada);
        # último degrau permite REUTILIZAR shots (cold start de biblioteca)
        primary_have = [c for c in brief.must_have if c != "people"]
        ladder: list[tuple[str, list[str], int, bool, list[str]]] = [
            ("base", brief.must_have, 4, False, entity_terms),
            ("drop_people", primary_have, 4, False, entity_terms),
            ("quality_3", primary_have, 3, False, entity_terms),
            ("entity_quality_2", primary_have, 2, False, entity_terms),
            # ENTIDADE > CATEGORIA: Livraria Lelo tem de entrar antes de
            # desistirmos da entidade (causa do mismatch de ontem)
            ("entity_drop_must_have", [], 3, False, entity_terms),
            ("drop_must_have", [], 3, False, []),
            ("reuse", primary_have or [], 3, True, []),
        ] if entity_terms else [
            ("base", brief.must_have, 4, False, []),
            ("drop_people", primary_have, 4, False, []),
            ("quality_3", primary_have, 3, False, []),
            ("drop_must_have", [], 3, False, []),
            ("reuse", primary_have or [], 3, True, []),
        ]

        def _pool(must_have: list[str], min_q: int, reuse: bool,
                  entities: list[str] | None = None) -> list[dict]:
            cands = search_shots(db, embedder, brief.visual_subject_en,
                                 must_have=must_have, must_not=brief.must_not,
                                 min_quality=min_q, k=POOL_K,
                                 exclude_places=scene_exclude,
                                 entity_terms=entities or [])
            if reuse:
                # exclusões de fixes são duras mesmo em modo reuse
                return [c for c in cands if c["shot_id"] not in hard_excluded]
            return [c for c in cands
                    if c["shot_id"] not in used_shots
                    and used_files.get(c["media_sha"], 0) < MAX_USES_PER_FILE]

        if is_strict:
            # Fase F — sem escada de relaxamento: pool = busca (geografia +
            # categorias + canonical) ∩ confirmados. O filtro geográfico
            # (exclude_places) continua a valer — geografia vence entity.
            pool = [c for c in search_shots(
                        db, embedder, brief.visual_subject_en,
                        must_have=brief.must_have, must_not=brief.must_not,
                        min_quality=4, k=POOL_K,
                        exclude_places=scene_exclude,
                        entity_terms=entity_terms)
                    if c["shot_id"] in confirmed_ids
                    and c["shot_id"] not in used_shots]
            level = "strict_confirmed"
            active_reuse = False
            active_entities = entity_terms
            if not pool:
                # confirmados existem mas nenhum passa geografia/categorias
                # → fail-closed (não desce para genérico)
                raise SceneStrictCoverageGap(
                    scene_id=scene.scene_id, entity=brief.required_entity,
                    entity_type=brief.required_entity_type,
                    deficit_seconds=_deficit_by_entity.get(entity_key, 0.0),
                    ranked_plan=_ranked_plan_summary(coverage_plan))
            active_have, active_q = brief.must_have, 4
        else:
            pool, level, active_reuse, active_entities = [], "base", False, entity_terms
            for level, must_have, min_q, allow_reuse, lvl_entities in ladder:
                pool = _pool(must_have, min_q, allow_reuse, lvl_entities)
                if not pool and level == "base":
                    topups += 1
                    if _jit_topup(brief, db, embedder, settings) > 0:
                        pool = _pool(must_have, min_q, allow_reuse, lvl_entities)
                if pool:
                    active_reuse = allow_reuse
                    active_entities = lvl_entities
                    if entity_terms and not lvl_entities:
                        # entidade caiu na escada — degradação nomeada
                        relaxations[scene.scene_id] = \
                            f"entity_dropped:{brief.required_entity}"
                    break
            if not pool and settings.veo_enabled and topups <= settings.veo_max_per_video:
                # ÚLTIMO recurso: gerar o clip (Veo). Entra pela ingestão normal
                # com license=owned + ai_generated no meta (disclosure YouTube).
                try:
                    # P3 (2026-08-11): Veo fallback migrado para ingest_asset.
                    from studio.library.ingest_asset import ingest_asset
                    from studio.library.veo import generate_clip

                    dest = settings.library_root / "generated" / f"veo_{scene.scene_id}.mp4"
                    clip, _cost = generate_clip(
                        f"{brief.visual_subject_en}, cinematic b-roll, no people faces",
                        dest, settings)
                    ingest_asset(
                        clip, {"source": "owned", "source_url": "",
                               "license": "owned", "author": "veo-ai",
                               "verified_by": "manual"},
                        db, settings, embedder,
                        source_id=f"veo:{scene.scene_id}",
                        video_id=None,
                    )
                    pool = _pool([], 0, False)
                    level = "veo_generated"
                except Exception as exc:
                    log.warning("Veo fallback falhou (%s): %s", scene.scene_id, exc)
            if not pool:
                unfilled.append(scene.scene_id)
                continue
            if level != "base":
                prior_note = relaxations.get(scene.scene_id)
                relaxations[scene.scene_id] = (f"{prior_note}+{level}"
                                               if prior_note else level)
                log.info("cena %s preenchida com relaxamento %s", scene.scene_id, level)
            active_have, active_q = must_have, min_q  # combinação vencedora da escada

        # preencher a cena com segmentos dentro da banda do beat
        # n_segmentos: para hook/transition forçamos band_min (anti-"riscado"
        # do intro); outros beats mantêm band_max (não over-segmente cenas
        # longas como payoff 20s que não provocam freeze).
        remaining = scene.t_out - scene.t_in
        cursor = scene.t_in
        if scene.beat in ("hook", "transition"):
            n_target = max(1, math.ceil(remaining / band_min))
        else:
            n_target = max(1, math.ceil(remaining / band_max))
        seg = 0
        while remaining > MIN_SEGMENT_S:
            if not pool:
                if is_strict:
                    # continuidade strict: pool confirmado esgotou a meio da
                    # cena → fail-closed, NUNCA completa com B-roll
                    raise SceneStrictCoverageGap(
                        scene_id=scene.scene_id, entity=brief.required_entity,
                        entity_type=brief.required_entity_type,
                        deficit_seconds=_deficit_by_entity.get(entity_key, 0.0),
                        ranked_plan=_ranked_plan_summary(coverage_plan))
                pool = _pool(active_have, active_q, active_reuse, active_entities)
                if not pool and active_entities:
                    # entidade esgotou a meio da cena → completa com genérico
                    active_entities = []
                    pool = _pool(active_have, active_q, active_reuse)
                if not pool and not active_reuse:
                    # esgotou a meio da cena → sobe para reutilização controlada
                    active_reuse = True
                    relaxations[scene.scene_id] = "reuse"
                    pool = _pool(active_have, active_q, True)
                if not pool:
                    unfilled.append(scene.scene_id)
                    break
            pool.sort(key=lambda c: _score(
                c, used_files, active_entities, settings=settings,
                confirmed_ids=confirmed_ids if is_strict else None,
                geography_terms=scene_exclude), reverse=True)
            cand = pool.pop(0)
            shot_len = cand["t_out"] - cand["t_in"]
            ideal = remaining / max(n_target - seg, 1)
            seg_len = min(remaining, shot_len, max(band_min, min(ideal, band_max)))
            # reutilização: deslocar a janela dentro do shot para não repetir
            # os mesmos frames (offset por nº de usos anteriores neste vídeo)
            src_offset = 0.0
            if cand["shot_id"] in {s.shot_id for s in segments}:
                prior = sum(1 for s in segments if s.shot_id == cand["shot_id"])
                src_offset = min(prior * seg_len, max(0.0, shot_len - seg_len))
            segments.append(SegmentAssignment(
                scene_id=scene.scene_id, beat=scene.beat, seg_index=seg,
                t_in=round(cursor, 3), t_out=round(cursor + seg_len, 3),
                shot_id=cand["shot_id"], media_path=cand["media_path"],
                media_sha=cand["media_sha"],
                source_in=round(cand["t_in"] + src_offset, 3),
                source_out=round(cand["t_in"] + src_offset + seg_len, 3),
                shot_type=cand.get("shot_type", ""),
                camera_motion=cand.get("camera_motion", ""),
                summary=cand.get("summary", ""),
                has_food=cand.get("has_food", False),
                has_landmark=cand.get("has_landmark", False),
                attribution_text=cand.get("attribution_text", "") if
                    cand.get("attribution_required") else "",
            ))
            used_shots.add(cand["shot_id"])
            used_files[cand["media_sha"]] = used_files.get(cand["media_sha"], 0) + 1
            db.register_usage(cand["shot_id"], run_id)
            cursor += seg_len
            remaining -= seg_len
            seg += 1

    return AssignmentResult(segments=segments, unfilled_scenes=sorted(set(unfilled)),
                            topups_triggered=topups, relaxations=relaxations)
