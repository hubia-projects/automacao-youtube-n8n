"""text_match.py — identidade canónica partilhada de uma entidade
(canonical + aliases PT + aliases EN) usada por TODOS os pontos que
precisam de decidir "este texto livre refere-se a esta entidade?":
`require_entity_confirmation` (candidatos via landmarks_csv/places_csv/
food_csv), ranking Wikimedia (título/categoria), corroboração
(OCR/título do provider). Um único módulo evita que cada sítio reinvente
a sua própria noção de "match" (bug B2, PORTO FINAL ASSET TEST: foto real
e correcta da Sé do Porto ficava invisível porque `landmarks_csv` tinha
"porto cathedral" — inglês, escrito pelo classificador de ingest — e a
comparação usava só o canonical em português, literal, sem normalização
nem aliases EN).
"""
from __future__ import annotations

import re
import unicodedata

# palavras genéricas de tipo-de-edifício/localização — filtradas do match
# de palavras distintivas para evitar falso positivo por coincidência de
# palavra comum (ex: "Torre" sozinho não corrobora "Torre dos Clérigos"
# contra qualquer outra torre; "Porto" sozinho não corrobora nenhuma
# entity específica do Porto). Lista genérica de linguagem, não
# específica de nenhuma entidade.
GENERIC_NAME_WORDS = frozenset({
    # português
    "rua", "avenida", "praca", "praça", "ponte", "torre", "capela",
    "catedral", "se", "sé", "igreja", "estacao", "estação", "miradouro",
    "galeria", "galerias", "livraria", "casa", "palacio", "palácio",
    "mercado", "jardim", "praia", "forte", "castelo", "museu", "teatro",
    "mosteiro", "convento", "porto", "lisboa", "portugal", "dom", "dona",
    "santo", "santa", "sao", "são",
    # inglês — bug B2 (PORTO FINAL ASSET TEST): `aliases_en` agora entra
    # no mesmo matcher de palavras distintivas; sem estas, "Cathedral"
    # sozinho corroboraria QUALQUER catedral (ex.: "Viseu Cathedral"
    # corroborando "Sé do Porto" via alias_en "Porto Cathedral" — falso
    # positivo real que este pedido explicitamente proíbe).
    "cathedral", "bridge", "station", "railway", "train", "tower",
    "church", "chapel", "palace", "museum", "market", "garden", "beach",
    "fort", "castle", "theater", "theatre", "monastery", "convent",
    "viewpoint", "bookstore", "gallery", "library", "square", "street",
    "avenue", "house", "building", "monument", "cafe", "restaurant",
    "shop", "store", "hall", "plaza", "view", "exterior", "interior",
    "category", "file", "commons", "wikimedia",
})


def distinctive_words(text: str) -> set[str]:
    words = re.findall(r"[a-zà-öø-ÿ]+", (text or "").lower())
    return {w for w in words if len(w) >= 4 and w not in GENERIC_NAME_WORDS}


# === identidade canónica (bug B2, PORTO FINAL ASSET TEST) ==================


def normalize_text(text: str) -> str:
    """lowercase + remove acentos (NFKD) + normaliza pontuação/whitespace
    para 1 espaço. "Sé do Porto" e "SE DO PORTO!!" normalizam igual;
    "Porto Cathedral" e "porto   cathedral" também. Preserva as palavras
    (nunca colapsa para menos texto do que o necessário para decidir
    especificidade — ver `is_specific_alias`)."""
    if not text:
        return ""
    nfkd = unicodedata.normalize("NFKD", text)
    no_accents = "".join(c for c in nfkd if not unicodedata.combining(c))
    lowered = no_accents.lower()
    cleaned = re.sub(r"[^a-z0-9\s]", " ", lowered)
    return " ".join(cleaned.split())


def is_specific_alias(name: str) -> bool:
    """>=2 palavras (após normalização) — nunca aceitar um alias genérico
    de 1 palavra sozinho como prova de identidade (ex.: "Cathedral"
    sozinho corresponderia a QUALQUER catedral; "Porto Cathedral" é
    específico). Regra geral por contagem de palavras, não por lista de
    palavras proibidas — funciona em qualquer língua/tema sem hardcode."""
    return len(normalize_text(name).split()) >= 2


def candidate_match_names(
    canonical: str, aliases: tuple[str, ...] = (),
    aliases_en: tuple[str, ...] = (),
) -> list[str]:
    """canonical + aliases (PT) + aliases_en -> lista deduplicada de nomes
    USÁVEIS para identidade: o canonical entra sempre (é a verdade
    fundamental, mesmo que curto); aliases só entram se `is_specific_alias`
    (>=2 palavras) — nunca um alias genérico sozinho."""
    raw = [canonical, *aliases, *aliases_en]
    out: list[str] = []
    seen: set[str] = set()
    canon_norm = normalize_text(canonical)
    for n in raw:
        n = (n or "").strip()
        if not n:
            continue
        norm = normalize_text(n)
        if not norm or norm in seen:
            continue
        if norm != canon_norm and not is_specific_alias(n):
            continue
        seen.add(norm)
        out.append(n)
    return out


def candidate_matches_entity(
    csv_value: str, canonical: str, aliases: tuple[str, ...] = (),
    aliases_en: tuple[str, ...] = (),
) -> bool:
    """True se `csv_value` (ex.: `landmarks_csv`/`places_csv`/`food_csv`
    de 1 shot, ou output livre do classificador Vision) contém, como
    substring normalizada, o canonical OU algum alias específico (PT ou
    EN) da entidade. Pura, sem DB — testável directamente (bug B2:
    "Sé do Porto" + landmarks_csv="Porto Cathedral" -> True;
    "Sé do Porto" + landmarks_csv="Viseu Cathedral" -> False, porque
    "cathedral" sozinho nunca é um alias válido — só "Porto Cathedral"
    completo, que não é substring de "Viseu Cathedral")."""
    csv_norm = normalize_text(csv_value)
    if not csv_norm:
        return False
    for name in candidate_match_names(canonical, aliases, aliases_en):
        if normalize_text(name) in csv_norm:
            return True
    return False


_LOCATION_LIKE_TYPES = frozenset({"place", "landmark", "building", "attraction"})
_FOOD_LIKE_TYPES = frozenset({"food", "dish", "drink"})


def csv_columns_for_entity_type(entity_type: str) -> list[str]:
    """Colunas CSV a pesquisar para este entity_type. Bug B1 side-effect:
    a fronteira entre "place"/"landmark"/"building"/"attraction" é
    inconsistente a montante (classificação heurística/LLM, nunca
    perfeita) — em vez de depender de UMA coluna exacta, os 4 tipos
    "tipo-localização" pesquisam AMBAS landmarks_csv/places_csv (união,
    nunca perde candidatos por um type ligeiramente errado). food/dish/
    drink continuam isolados em food_csv (comida nunca aparece marcada
    como landmark/place no ingest)."""
    et = (entity_type or "").strip().lower()
    if et in _FOOD_LIKE_TYPES:
        return ["food_csv"]
    if et in _LOCATION_LIKE_TYPES or not et:
        return ["landmarks_csv", "places_csv"]
    return ["landmarks_csv", "places_csv", "food_csv"]


def build_candidate_where_clause(
    entity_type: str, canonical: str, aliases: tuple[str, ...] = (),
    aliases_en: tuple[str, ...] = (),
) -> str:
    """WHERE SQL (LanceDB) para o SQL recall inicial — BROAD de propósito
    (substring simples, sem normalização de acentos, que o SQL engine não
    tem); a precisão real vem depois, em Python, via
    `candidate_matches_entity()` sobre os candidatos devolvidos. Nunca
    devolve "1=1" (full scan) — se não houver nomes usáveis, devolve
    "1=0" (fail-closed, 0 candidatos em vez de todos)."""
    names = candidate_match_names(canonical, aliases, aliases_en)
    cols = csv_columns_for_entity_type(entity_type)
    safe_names = [n.replace("'", "").strip().lower() for n in names]
    safe_names = [n for n in safe_names if n]
    if not safe_names:
        return "1=0"
    conds = [f"{col} LIKE '%{n}%'" for col in cols for n in safe_names]
    return " OR ".join(conds)
