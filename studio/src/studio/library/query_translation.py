"""query_translation.py — traduz canonical entities (PT ou qualquer língua)
para frases de busca EN genéricas antes de consultar stock providers.

Descoberto na primeira run de produção real (porto-24h-001, 2026-08-13):
`query_hierarchy()` sempre usou `canonical_entity` tal como vem do roteiro
(ex.: "Sé do Porto", "Ponte Dom Luís I") directamente como query de busca
em Pexels/Pixabay — providers que indexam metadata em inglês. Nomes
próprios em português quase nunca batem com tags EN, mesmo quando a
biblioteca tem footage genérico relevante (catedral gótica, ponte de ferro,
etc.) — resultado: 0 candidatos úteis, mesmo com API key válida e milhares
de shots disponíveis no Pexels.

`canonical_entity` continua intocado em todo o resto do pipeline (script,
matching, RequirementIndex, Vision) — só a STRING usada como query externa
de stock passa por aqui. SigLIP text-tower já tolera nomes latinizados
(ver workset_context.py::_build_requirement_prompts); esta tradução é
apenas para motores de busca por keyword (Pexels/Pixabay/etc.), que não são
semânticos.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from studio.config import Settings

log = logging.getLogger("studio.query_translation")

_MEM_CACHE: dict[str, str] = {}


def _cache_path(settings: Settings) -> Path:
    return settings.library_root / "query_translations_en.json"


def _cache_key(canonical: str, entity_type: str, location: str) -> str:
    return (f"{canonical.strip().lower()}|{(entity_type or '').strip().lower()}"
            f"|{(location or '').strip().lower()}")


def _load_disk_cache(settings: Settings) -> dict[str, str]:
    p = _cache_path(settings)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception as exc:
        log.debug("query_translation: cache read falhou (não fatal): %s",
                  exc.__class__.__name__)
        return {}


def _save_disk_cache(settings: Settings, cache: dict[str, str]) -> None:
    p = _cache_path(settings)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(cache, ensure_ascii=False, indent=2), "utf-8")
    except Exception as exc:
        log.debug("query_translation: cache write falhou (não fatal): %s",
                  exc.__class__.__name__)


def translate_query_en(canonical: str, entity_type: str, location: str,
                       settings: Settings | None) -> str:
    """canonical -> frase de busca EN genérica para stock providers.

    1 chamada Gemini por entity ÚNICA (cache em disco, persistente entre
    runs/waves/resume, + memória do processo). mock_mode ou sem
    `gemini_api_key` (ou `settings=None`): fallback determinístico
    (canonical + type + location concatenados) — nunca bloqueia testes
    nem produção sem credencial; nunca lança excepção para o caller
    (fail-soft: pior caso é voltar ao comportamento anterior à tradução).
    """
    canonical = str(canonical) if canonical else ""
    entity_type = str(entity_type) if entity_type else ""
    location = str(location) if location else ""
    fallback = " ".join(
        p for p in (canonical, entity_type, location) if p).strip() or canonical
    if settings is None:
        return fallback

    key = _cache_key(canonical, entity_type, location)
    if key in _MEM_CACHE:
        return _MEM_CACHE[key]
    disk_cache = _load_disk_cache(settings)
    if key in disk_cache:
        _MEM_CACHE[key] = disk_cache[key]
        return disk_cache[key]

    if settings.mock_mode or not settings.gemini_api_key:
        _MEM_CACHE[key] = fallback
        return fallback

    prompt = (
        "You generate short English stock-footage search queries. "
        f"Landmark/subject (may be in Portuguese or another language): "
        f"\"{canonical}\"\n"
        f"Type: {entity_type or 'unknown'}\n"
        f"City/location: {location or 'unknown'}\n"
        "Reply with ONLY a 3-6 word English search phrase that a stock "
        "video site (Pexels/Pixabay) would return good visual matches "
        "for. Describe the VISUAL subject generically (e.g. \"gothic "
        "cathedral facade Porto\", \"iron arch bridge Porto\") rather "
        "than the literal proper noun, since stock libraries rarely tag "
        "specific local landmark names. No quotes, no punctuation "
        "besides spaces, no explanation — just the phrase."
    )
    try:
        from studio.llm.gemini import generate
        text, _cost = generate(prompt, settings, temperature=0.2,
                               tag="query_translation_en")
        phrase = " ".join(text.strip().split())[:120]
        if not phrase:
            phrase = fallback
    except Exception as exc:
        log.warning(
            "query_translation: Gemini falhou para '%s' (%s) — fallback "
            "determinístico (query original, sem tradução)",
            canonical, exc.__class__.__name__)
        phrase = fallback

    _MEM_CACHE[key] = phrase
    disk_cache[key] = phrase
    _save_disk_cache(settings, disk_cache)
    return phrase
