"""PORTO FINAL RETRIEVAL FIX — secção 30: benchmark de retrieval contra
5 entidades known-good do Porto, usando APIs reais (sem download em
massa). Gate obrigatório antes de `studio resume porto-24h-001` (secção
35): prova que o código consegue encontrar candidatos plausíveis para
entidades cuja existência JÁ confirmámos manualmente nos providers
actuais — não descobre "se existe", prova "se o código encontra".

Uso:
    PYTHONPATH=src:scripts uv run python3 scripts/test_known_asset_retrieval.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from studio.config import Settings
from studio.library.query_translation import translate_entity_aliases_en
from studio.library.sources import pexels, pixabay, wikimedia
from studio.library.text_match import rank_score_for_hints

# threshold do secção 17: >= 8.0 significa que bateu a FRASE COMPLETA de
# um alias específico (>=2 palavras) — não é só overlap de token fraco.
_PASS_THRESHOLD = 8.0

KNOWN_GOOD = [
    {"canonical": "Sé do Porto", "location": "Porto", "entity_type": "landmark",
     "aliases_pt": (), "providers": ("pexels", "pixabay", "wikimedia")},
    {"canonical": "Ponte Dom Luís I", "location": "Porto", "entity_type": "landmark",
     "aliases_pt": (), "providers": ("pexels", "wikimedia")},
    {"canonical": "Torre dos Clérigos", "location": "Porto", "entity_type": "landmark",
     "aliases_pt": ("Clérigos",), "providers": ("pexels", "wikimedia")},
    {"canonical": "Estação de São Bento", "location": "Porto", "entity_type": "building",
     "aliases_pt": (), "providers": ("pexels", "wikimedia")},
    {"canonical": "Livraria Lello", "location": "Porto", "entity_type": "building",
     "aliases_pt": (), "providers": ("wikimedia", "pexels")},
]


def _search_provider(provider: str, query: str, hints: tuple[str, ...],
                     settings: Settings) -> list:
    mod = {"pexels": pexels, "pixabay": pixabay, "wikimedia": wikimedia}[provider]
    try:
        return mod.search(query, 8, settings, canonical_hints=hints)
    except Exception as exc:
        print(f"    {provider}: FALHOU ({exc.__class__.__name__}: {exc})")
        return []


def _candidate_text(provider: str, cand) -> str:
    if provider == "wikimedia":
        return f"{cand.title} {' '.join(cand.categories)}"
    if provider == "pexels":
        return cand.title
    if provider == "pixabay":
        return f"{cand.tags} {cand.source_url}"
    return ""


def run() -> bool:
    settings = Settings()
    print(f"mock_mode={settings.mock_mode} "
         f"pexels_key={bool(settings.pexels_api_key)} "
         f"pixabay_key={bool(settings.pixabay_api_key)} "
         f"gemini_key={bool(settings.gemini_api_key)}\n")

    overall_pass = True
    for spec in KNOWN_GOOD:
        canonical = spec["canonical"]
        print(f"\n{'=' * 70}\nREQUIREMENT: {canonical}")
        aliases_en = translate_entity_aliases_en(
            canonical, spec["entity_type"], spec["location"],
            spec["aliases_pt"], settings)
        hints = (canonical, *spec["aliases_pt"], *aliases_en)
        print(f"QUERY PLAN (hints): {hints}")

        best_score = 0.0
        best_provider = ""
        best_candidate = None
        for provider in spec["providers"]:
            query = aliases_en[0] if aliases_en else canonical
            candidates = _search_provider(provider, query, hints, settings)
            print(f"\n  PROVIDER: {provider}")
            print(f"  QUERY: {query!r}")
            print(f"  RESULTS: {len(candidates)}")
            for i, cand in enumerate(candidates[:5]):
                text = _candidate_text(provider, cand)
                score = rank_score_for_hints(text, hints)
                media_kind = getattr(cand, "media_kind", "video")
                print(f"    [{i}] id={cand.provider_id} score={score:.1f} "
                     f"media={media_kind} text={text[:80]!r}")
                if score > best_score:
                    best_score = score
                    best_provider = provider
                    best_candidate = cand

        passed = best_score >= _PASS_THRESHOLD
        overall_pass = overall_pass and passed
        status = "PASS" if passed else "FAIL"
        print(f"\n  BEST: provider={best_provider} score={best_score:.1f} "
             f"candidate={best_candidate.provider_id if best_candidate else None} "
             f"-> {status}")

    print(f"\n\n{'=' * 70}")
    print(f"KNOWN_GOOD_RETRIEVAL_PASS = {'YES' if overall_pass else 'NO'}")
    return overall_pass


if __name__ == "__main__":
    ok = run()
    sys.exit(0 if ok else 1)
