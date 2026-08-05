"""Lint determinístico anti-AI-slop (ARCHITECTURE.md §1.6, passo 6).

Fail-closed: erros bloqueiam o stage do roteiro; warnings só reportam.
`scrub_safety_phrases` é a única função que altera texto; lint() é puro
(validador): NÃO aplica scrub internamente. O caller (S03Script) é
responsável por decidir se quer texto sem frases banidas antes de chegar
aqui. Esta separação garante que o script.md persistido é o mesmo texto
que passou o lint.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

BANNED_PHRASES = [
    "vamos mergulhar", "sem mais delongas", "nesse vídeo você vai",
    "neste vídeo você vai", "não esqueça de se inscrever", "deixa o like",
    "fica até o final", "fique até o final", "então bora", "e aí, tudo bem",
    "prepare-se para", "embarque conosco", "sem dúvida alguma",
]
# palavras de entusiasmo genérico — toleradas até _MAX_HYPE ocorrências
_HYPE = ["incrível", "maravilhoso", "espetacular", "deslumbrante", "imperdível"]
_MAX_HYPE = 3
_MARKDOWN_PATTERN = re.compile(r"(^#|\*\*|\n- |\n\d+\. )", re.MULTILINE)

# Substituições determinísticas para frases banidas. Aplicadas pelo CALLER
# (S03Script) entre `normalize_for_tts` e `lint`, garantindo que o texto
# persistido em `script.md` já vem sem essas locuções. Resolve o problema
# do fix_lint Flash não remover completamente certas frases em ~30% das
# gerações reais (ex.: "sem dúvida alguma" persiste).
_BANNED_REPLACEMENTS: dict[str, str] = {
    "sem dúvida alguma": "na verdade",
    "sem mais delongas": "sem rodeios",
    "vamos mergulhar": "vamos lá",
    "nesse vídeo você vai": "nesse roteiro você vai",
    "neste vídeo você vai": "neste roteiro você vai",
    "não esqueça de se inscrever": "boa viagem",
    "deixa o like": "deixa o comentário",
    "fica até o final": "fica mais um pouco",
    "fique até o final": "fica mais um pouco",
    "então bora": "então vamos",
    "e aí, tudo bem": "olá",
    "prepare-se para": "imagine",
    "embarque conosco": "venha com a gente",
}


@dataclass
class LintReport:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.errors


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?…])\s+", text.strip())
    return [p for p in parts if p]


def scrub_safety_phrases(text: str) -> str:
    """Substitui todas as frases banidas por alternativas seguras.

    Determinístico (regex case-insensitive), sem custo. Convenção: o caller
    em S03Script aplica isto em `final` antes do `lint()` para que
    `script.md` no disco já não contenha nenhuma das locuções banidas.
    """
    out = text
    for phrase, repl in _BANNED_REPLACEMENTS.items():
        if phrase in out.lower():
            pattern = re.compile(re.escape(phrase), re.IGNORECASE)
            out = pattern.sub(repl, out)
    return out


def lint(text: str, *, min_words: int = 0) -> LintReport:
    """Validador puro: dado um texto, devolve erros/warnings/estatísticas.

    Não aplica scrub internamente — o caller usa `scrub_safety_phrases`
    se quiser texto sem frases banidas antes de chegar aqui.
    """
    report = LintReport()
    low = text.lower()

    for phrase in BANNED_PHRASES:
        if phrase in low:
            report.errors.append(f"frase banida: {phrase!r}")

    hype_count = sum(low.count(w) for w in _HYPE)
    if hype_count > _MAX_HYPE:
        report.errors.append(f"entusiasmo genérico em excesso ({hype_count}x "
                             f"palavras tipo 'incrível' — máx {_MAX_HYPE})")

    if _MARKDOWN_PATTERN.search(text):
        report.errors.append("narração contém markdown/listas — tem de ser texto corrido")

    sentences = _sentences(text)
    words = text.split()
    lengths = [len(s.split()) for s in sentences]
    report.stats = {
        "words": len(words),
        "sentences": len(sentences),
        "avg_sentence_words": round(statistics.mean(lengths), 1) if lengths else 0,
        "sentence_len_stdev": round(statistics.pstdev(lengths), 1) if len(lengths) > 1 else 0,
    }

    if min_words and len(words) < min_words:
        report.errors.append(f"roteiro curto: {len(words)} palavras < mínimo {min_words}")
    # variação de ritmo: stdev muito baixo = frases todas do mesmo tamanho (tell de IA)
    if len(lengths) >= 8 and report.stats["sentence_len_stdev"] < 3.0:
        report.warnings.append("pouca variação no comprimento das frases "
                               f"(stdev {report.stats['sentence_len_stdev']})")
    if lengths and max(lengths) > 45:
        report.warnings.append(f"frase demasiado longa para TTS ({max(lengths)} palavras)")
    return report


def normalize_for_tts(text: str) -> str:
    """Limpezas leves que evitam artefactos no TTS."""
    out = text.replace("—", ", ").replace("–", ", ")
    out = re.sub(r"\s{2,}", " ", out)
    out = re.sub(r'["""]', "", out)
    return out.strip()
