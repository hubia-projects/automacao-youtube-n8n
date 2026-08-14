"""provider_policy.py — waterfall de providers por tipo de requirement
(itens 4/5/6/30 do fecho de cobertura multi-provider).

Decisão única, sem espalhar por vários módulos: strict landmark/place
prioriza fontes exactas (Wikimedia — nomes próprios, categorias reais)
ANTES de stock genérico; food/filler priorizam stock (Pexels/Pixabay
indexam melhor comida/vida urbana genérica que Wikimedia). Sem hardcode de
nome de entidade/cidade — só `entity_type`/`strict` (já disponíveis em
`EntityCoverage`/`RequirementSpec`), arquitectura funciona para qualquer
tema (Roma, Paris, Tóquio, ...), não só Porto.

Wikimedia devolve vídeo E imagem misturados numa única query
(`sources/wikimedia.py::search()` auto-classifica por `mime`) — não há
"passo video" e "passo image" separados por provider aqui; a preferência
"vídeo exacto > imagem exacta" (item 24) é aplicada na selecção/ranking
(Fase 4), não nesta waterfall.
"""
from __future__ import annotations

from studio.matching.coverage_plan import FILLER_ENTITY_TYPE

_FOOD_TYPES = frozenset({"food", "dish", "drink"})

# strict landmark/place: fonte exacta primeiro (Wikimedia — nomes próprios,
# categorias reais), stock genérico como fallback.
_STRICT_PLACE_WATERFALL = ("wikimedia", "pexels", "pixabay")
# food/filler: stock genérico indexa melhor comida/vida urbana do que
# Wikimedia (que tende a ter fotos de pratos específicos, não B-roll).
_STOCK_FIRST_WATERFALL = ("pexels", "pixabay", "wikimedia")


def provider_policy(entity_type: str, strict: bool) -> list[str]:
    """entity_type/strict -> ordem de providers a tentar (nomes válidos
    para `_load_provider_module`/`make_provider_resolver`). Nunca inclui
    'manual' nem 'openverse' (deferred) — esses são geridos fora desta
    waterfall (Fase 6 / secção 28)."""
    et = (entity_type or "").strip().lower()
    if et == FILLER_ENTITY_TYPE or et in _FOOD_TYPES:
        return list(_STOCK_FIRST_WATERFALL)
    if not strict:
        # core não-estrito: CS_NOT_REQUIRED aceita similaridade razoável
        # sem exigir confirmação Vision exacta — footage genérico plausível
        # já serve, sem precisar de pagar o custo de tentar a fonte exacta
        # primeiro.
        return list(_STOCK_FIRST_WATERFALL)
    # strict landmark/place: fonte exacta primeiro — Vision vai exigir
    # confirmação precisa, por isso vale tentar Wikimedia (nomes próprios,
    # categorias reais) antes do stock genérico.
    return list(_STRICT_PLACE_WATERFALL)
