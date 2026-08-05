"""Inventário visual da biblioteca — a ponte guião↔biblioteca.

Causa raiz do score baixo (run 20260714-102323): o guião nomeava monumentos
e pratos que a biblioteca não tinha (Livraria Lello, Santa Justa, Francesinha),
e o matching entregava o vizinho visual mais parecido — de outro país.
Regra nova: o guião só pode NOMEAR o que este inventário lista; o resto fica
genérico. O matching usa o mesmo vocabulário para filtro por entidade.
"""

from __future__ import annotations

from studio.library.db import LibraryDB

# termos com menos shots que isto não sustentam uma cena nomeada
MIN_SHOTS_FOR_CLAIM = 2


def inventory_text(db: LibraryDB, top: int = 30) -> str:
    """Resumo legível por LLM do que a biblioteca cobre de facto."""
    counts = db.term_counts()

    def _fmt(bucket: dict[str, int]) -> str:
        items = sorted(((t, n) for t, n in bucket.items()
                        if n >= MIN_SHOTS_FOR_CLAIM),
                       key=lambda x: -x[1])[:top]
        return ", ".join(f"{t} ({n})" for t, n in items) or "(nada com cobertura suficiente)"

    return (
        f"Monumentos/locais específicos COM imagens: {_fmt(counts['landmarks'])}\n"
        f"Cidades/regiões COM imagens: {_fmt(counts['places'])}\n"
        f"Comidas/bebidas COM imagens: {_fmt(counts['foods'])}"
    )


def entity_vocab(db: LibraryDB) -> dict[str, str]:
    """Vocabulário plano {termo_lower: termo_original} de landmarks+foods+
    places — o assigner resolve required_entity contra isto; o termo original
    (com maiúsculas) é o que entra no filtro LIKE dos metadados."""
    counts = db.term_counts()
    vocab: dict[str, str] = {}
    for bucket in counts.values():
        for term in bucket:
            vocab.setdefault(term.lower(), term)
    return vocab


def resolve_entity(entity: str, vocab: dict[str, str]) -> list[str]:
    """Resolve uma entidade do brief contra o vocabulário da biblioteca.
    Containment nos dois sentidos e caso-insensível ("Dom Luís I Bridge"
    casa com "Dom Luís I Bridge" e com "Luís I"). Devolve os termos
    ORIGINAIS da biblioteca que casam (para o filtro LIKE)."""
    e = entity.strip().lower()
    if len(e) < 4:  # curto demais = falso positivo garantido em containment
        return []
    return [orig for low, orig in vocab.items() if e in low or low in e]
