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


# === translate_query_variants_en (Porto: search+confirmation calibration) ===
#
# `translate_query_en` devolve 1 SÓ frase genérica — bom para o nível "core"
# da hierarquia, mas insuficiente para recall real (facade vs interior vs
# staircase, ou aliases PT/EN da mesma entidade nunca chegam a ser tentados
# como queries distintas). Esta função gera VÁRIAS variantes numa única
# chamada Gemini (nunca 1 chamada por variante), derivadas SEMPRE de
# canonical/aliases/location/visual_prompts_en — zero hardcode por entidade.

_VARIANTS_MEM_CACHE: dict[str, tuple[str, ...]] = {}


def _variants_cache_path(settings: Settings) -> Path:
    return settings.library_root / "query_variants_en.json"


def _variants_cache_key(canonical: str, entity_type: str, location: str,
                        aliases: tuple[str, ...],
                        visual_prompts_en: tuple[str, ...]) -> str:
    return "|".join([
        canonical.strip().lower(),
        (entity_type or "").strip().lower(),
        (location or "").strip().lower(),
        ",".join(sorted(a.strip().lower() for a in aliases if a and a.strip())),
        ",".join(sorted(v.strip().lower() for v in visual_prompts_en
                        if v and v.strip()))[:200],
    ])


def _dedup_preserve_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        norm = (it or "").strip()
        if norm and norm.lower() not in seen:
            seen.add(norm.lower())
            out.append(norm)
    return out


def _fallback_variants(canonical: str, location: str,
                       aliases: tuple[str, ...]) -> list[str]:
    """Sem rede/mock_mode: variantes determinísticas a partir do que já
    temos (canonical, cada alias, canonical+location) — nunca inventa
    descrições visuais que dependeriam de Gemini."""
    variants = [canonical, *aliases]
    if location:
        variants.append(f"{canonical} {location}")
    return _dedup_preserve_order(variants)


def translate_query_variants_en(
    canonical: str, entity_type: str, location: str,
    aliases: tuple[str, ...], visual_prompts_en: tuple[str, ...],
    settings: Settings | None,
) -> list[str]:
    """canonical + aliases + visual_prompts_en -> várias frases de busca EN
    (facade/interior/exterior/aliases PT+EN), 1 chamada Gemini por entidade
    ÚNICA (cache em disco próprio, separado de `translate_query_en`).

    mock_mode / sem `gemini_api_key` / `settings=None`: fallback
    determinístico via `_fallback_variants` — nunca bloqueia, nunca inventa.
    """
    canonical = str(canonical) if canonical else ""
    entity_type = str(entity_type) if entity_type else ""
    location = str(location) if location else ""
    aliases = tuple(a for a in (aliases or ()) if a)
    visual_prompts_en = tuple(v for v in (visual_prompts_en or ()) if v)
    fallback = _fallback_variants(canonical, location, aliases)
    if not canonical:
        return fallback
    if settings is None:
        return fallback

    key = _variants_cache_key(canonical, entity_type, location, aliases,
                              visual_prompts_en)
    if key in _VARIANTS_MEM_CACHE:
        return list(_VARIANTS_MEM_CACHE[key])
    disk_cache = _load_disk_cache_variants(settings)
    if key in disk_cache:
        _VARIANTS_MEM_CACHE[key] = tuple(disk_cache[key])
        return list(disk_cache[key])

    if settings.mock_mode or not settings.gemini_api_key:
        _VARIANTS_MEM_CACHE[key] = tuple(fallback)
        return fallback

    hints = "\n".join(f"- {v}" for v in visual_prompts_en[:6]) or "(none)"
    alias_str = ", ".join(aliases) or "(none)"
    prompt = (
        "You generate short English stock-footage search phrases for a "
        "video B-roll search engine (Pexels/Pixabay/Wikimedia Commons).\n"
        f"Subject (may be in Portuguese or another language): \"{canonical}\"\n"
        f"Known aliases/alternate names: {alias_str}\n"
        f"Type: {entity_type or 'unknown'}\n"
        f"City/location: {location or 'unknown'}\n"
        f"Known visual descriptions of this subject:\n{hints}\n\n"
        "Reply with 4 to 8 DIFFERENT short English search phrases (3-7 "
        "words each), one per line, no numbering, no quotes, no "
        "explanation. Cover different angles: exterior/facade, interior "
        "(if applicable), the exact proper name in English (if it has a "
        "conventional English name), and a generic visual description of "
        "the subject type + location. Do not invent details not implied "
        "by the inputs above."
    )
    try:
        from studio.llm.gemini import generate
        text, _cost = generate(prompt, settings, temperature=0.3,
                               tag="query_translation_variants_en")
        lines = [" ".join(ln.strip().split())[:120] for ln in text.splitlines()]
        variants = _dedup_preserve_order([ln for ln in lines if ln])[:8]
        if not variants:
            variants = fallback
    except Exception as exc:
        log.warning(
            "query_translation: Gemini falhou para variantes de '%s' (%s) "
            "— fallback determinístico", canonical, exc.__class__.__name__)
        variants = fallback

    _VARIANTS_MEM_CACHE[key] = tuple(variants)
    disk_cache[key] = variants
    _save_disk_cache_variants(settings, disk_cache)
    return variants


def _load_disk_cache_variants(settings: Settings) -> dict[str, list[str]]:
    p = _variants_cache_path(settings)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception as exc:
        log.debug("query_translation: variants cache read falhou (não "
                  "fatal): %s", exc.__class__.__name__)
        return {}


def _save_disk_cache_variants(settings: Settings,
                              cache: dict[str, list[str]]) -> None:
    p = _variants_cache_path(settings)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(cache, ensure_ascii=False, indent=2), "utf-8")
    except Exception as exc:
        log.debug("query_translation: variants cache write falhou (não "
                  "fatal): %s", exc.__class__.__name__)
