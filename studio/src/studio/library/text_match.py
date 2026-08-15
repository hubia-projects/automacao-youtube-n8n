"""text_match.py — item PORTO (search+confirmation calibration): match de
palavras DISTINTIVAS entre uma entidade (canonical/aliases) e um texto
livre (OCR, título de provider, categoria Wikimedia).

Extraído de `confirmation.py` para ser partilhado com
`library/sources/wikimedia.py` (ranking local de candidatos por
canonical_hints) sem duplicar a lista de palavras genéricas em dois
sítios — mesma definição de "distintivo" em toda a busca+confirmação.
"""
from __future__ import annotations

import re

# palavras genéricas de tipo-de-edifício/localização — filtradas do match
# de palavras distintivas para evitar falso positivo por coincidência de
# palavra comum (ex: "Torre" sozinho não corrobora "Torre dos Clérigos"
# contra qualquer outra torre; "Porto" sozinho não corrobora nenhuma
# entity específica do Porto). Lista genérica de linguagem, não
# específica de nenhuma entidade.
GENERIC_NAME_WORDS = frozenset({
    "rua", "avenida", "praca", "praça", "ponte", "torre", "capela",
    "catedral", "se", "sé", "igreja", "estacao", "estação", "miradouro",
    "galeria", "galerias", "livraria", "casa", "palacio", "palácio",
    "mercado", "jardim", "praia", "forte", "castelo", "museu", "teatro",
    "mosteiro", "convento", "porto", "lisboa", "portugal", "dom", "dona",
    "santo", "santa", "sao", "são", "view", "exterior", "interior",
    "category", "file", "commons", "wikimedia",
})


def distinctive_words(text: str) -> set[str]:
    words = re.findall(r"[a-zà-öø-ÿ]+", (text or "").lower())
    return {w for w in words if len(w) >= 4 and w not in GENERIC_NAME_WORDS}
