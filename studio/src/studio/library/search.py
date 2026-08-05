"""Busca híbrida — ANN SigLIP + filtros simbólicos (ARCHITECTURE.md §7).

`must_not` é FILTRO DURO, não peso: um monumento não entra numa cena de
comida por construção. Rerank multilingual (e5) entra na Fase 4.
"""

from __future__ import annotations

from studio.library.db import LibraryDB
from studio.library.embed import Embedder

# Categorias simbólicas suportadas em must_have / must_not
_CATEGORY_FLAGS = {
    "food": "has_food",
    "landmark": "has_landmark",
    "monument": "has_landmark",
    "people": "people_present",
}


def _build_where(must_have: list[str], must_not: list[str],
                 min_quality: int, include_restricted: bool,
                 exclude_places: list[str] | None = None,
                 entity_terms: list[str] | None = None) -> str:
    clauses = [f"quality >= {int(min_quality)}", "revoked = false"]
    if not include_restricted:
        clauses.append("restricted = false")
    for cat in must_have:
        flag = _CATEGORY_FLAGS.get(cat.lower())
        if flag:
            clauses.append(f"{flag} = true")
    for cat in must_not:
        flag = _CATEGORY_FLAGS.get(cat.lower())
        if flag:
            clauses.append(f"{flag} = false")
    # geografia é filtro duro tal como must_not de categoria (ver assigner._region_exclude_terms):
    # shot etiquetado com país/cidade errada nunca entra, mesmo em relaxamento
    for term in exclude_places or []:
        safe = term.replace("'", "")
        clauses.append(f"NOT (places_csv LIKE '%{safe}%' OR landmarks_csv LIKE '%{safe}%')")
    # entidade nomeada pela narração: o shot TEM de a ter nos metadados
    # (qualquer um dos termos resolvidos contra o vocabulário da biblioteca)
    if entity_terms:
        ors = []
        for term in entity_terms:
            safe = term.replace("'", "")
            ors.append(f"places_csv LIKE '%{safe}%' OR landmarks_csv LIKE '%{safe}%' "
                       f"OR food_csv LIKE '%{safe}%'")
        clauses.append("(" + " OR ".join(ors) + ")")
    return " AND ".join(clauses)


def search_shots(
    db: LibraryDB,
    embedder: Embedder,
    query_en: str,
    *,
    must_have: list[str] | None = None,
    must_not: list[str] | None = None,
    min_quality: int = 4,
    k: int = 40,
    include_restricted: bool = False,
    exclude_places: list[str] | None = None,
    entity_terms: list[str] | None = None,
) -> list[dict]:
    """query_en TEM de estar em inglês (ADR-0003)."""
    vec = embedder.embed_text(query_en)
    where = _build_where(must_have or [], must_not or [], min_quality,
                         include_restricted, exclude_places, entity_terms)
    return db.search_vec(vec, where=where, limit=k)
