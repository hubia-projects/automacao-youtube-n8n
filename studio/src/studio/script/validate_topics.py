"""validate_topics.py — item 3 do master task.

Valida deterministicamente que os `mandatory_topics` do operador (ThemeSpec)
aparecem no script gerado. A biblioteca visual NUNCA condiciona isto —
esta validação só olha para o texto do script.

Match em duas camadas (favorece recall sobre precisão, mas continua
determinístico):
  1. substring exata (normalizada: lowercase + sem acentos) do tópico
     completo no texto.
  2. fallback: todas as "palavras de conteúdo" do tópico (exclui stopwords
     PT curtas) aparecem no texto, mesmo que não contíguas — cobre casos
     como "Ponte Dom Luís I" citada como "a ponte de Dom Luís".
"""
from __future__ import annotations

import re
import unicodedata

_STOPWORDS = {
    "de", "da", "do", "das", "dos", "e", "a", "o", "as", "os",
    "em", "com", "no", "na", "nos", "nas", "um", "uma",
}


def _normalize(text: str) -> str:
    text = text.lower()
    text = unicodedata.normalize("NFKD", text)
    return "".join(c for c in text if not unicodedata.combining(c))


def _content_words(topic: str) -> list[str]:
    words = re.findall(r"[a-zA-Z]+", _normalize(topic))
    return [w for w in words if w not in _STOPWORDS and len(w) > 2]


def is_topic_present(script_text: str, topic: str) -> bool:
    norm_text = _normalize(script_text)
    norm_topic = _normalize(topic)
    if norm_topic and norm_topic in norm_text:
        return True
    words = _content_words(topic)
    if not words:
        return False
    return all(w in norm_text for w in words)


def find_missing_topics(script_text: str, mandatory_topics: list[str]) -> list[str]:
    """Devolve a sublista de `mandatory_topics` que NÃO aparece no script,
    preservando a ordem original."""
    return [t for t in mandatory_topics if not is_topic_present(script_text, t)]
