"""manual_provider.py — fallback final quando os providers automáticos
esgotam (itens 34/35/36 do fecho de cobertura multi-provider).

Path canónico: `data/library/manual/inbox/<workset_id>/`. O operador
arrasta ficheiros (vídeo ou imagem) para lá; `scan_manual_inbox()` (chamado
por `run_acquisition_for_workset`, ANTES da waterfall automática de cada
wave — dá prioridade a conteúdo curado pelo humano, evita gastar API se o
operador já resolveu manualmente) detecta, ingere pelo caminho canónico
(mesmo `ingest_asset` de qualquer provider automático — nunca um segundo
caminho de ingest), indexa e deixa o remeasure normal decidir se fechou o
deficit.

Licença: sem proveniência verificável (source="orphan", ver licenses.py) —
mesmo regime de qualquer asset sem contrato de licença explícito, restrito
até revisão manual. Sem tratamento manual complexo: só scan+ingest, sem UI
de aprovação dedicada (a aprovação é o próprio acto de o operador colocar
o ficheiro na pasta).
"""
from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("studio.manual_provider")

_IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".webp"})
_VIDEO_SUFFIXES = frozenset({".mp4", ".mov", ".webm", ".mkv", ".ogv"})


def manual_inbox_dir(settings, workset_id: str) -> Path:
    return settings.library_root / "manual" / "inbox" / workset_id


def _media_kind_for(path: Path) -> str | None:
    suffix = path.suffix.lower()
    if suffix in _IMAGE_SUFFIXES:
        return "image"
    if suffix in _VIDEO_SUFFIXES:
        return "video"
    return None  # extensão desconhecida — skip (nunca adivinhar)


def scan_manual_inbox(
    workset_id: str,
    db,
    embedder,
    settings,
    *,
    requirement_prompts: dict | None = None,
    requirement_embeddings: dict | None = None,
    visual_prompt_embeddings: dict | None = None,
) -> int:
    """Ingere ficheiros novos de `manual_inbox_dir()`. Idempotente — dedup
    por SHA-256 já garantido por `ingest_asset`/`ingest_file`, seguro
    re-scan a cada wave/resume sem duplicar. Devolve nº de ficheiros
    ingeridos com sucesso nesta chamada."""
    from studio.library.ingest_asset import ingest_asset
    from studio.library.licenses import LicenseRecord

    inbox = manual_inbox_dir(settings, workset_id)
    if not inbox.is_dir():
        return 0

    ingested = 0
    for path in sorted(inbox.iterdir()):
        if not path.is_file() or path.name.startswith("."):
            continue
        media_kind = _media_kind_for(path)
        if media_kind is None:
            log.debug("manual_inbox: '%s' extensão desconhecida — skip",
                     path.name)
            continue
        lic = LicenseRecord(
            source="orphan", source_url=f"orphan:manual:{path.name}",
            license="unknown", author="", verified_by="manual",
        )
        try:
            result, _state = ingest_asset(
                path, lic, db, settings, embedder,
                source_id=f"manual:{path.name}", video_id=workset_id,
                requirement_prompts=requirement_prompts,
                requirement_embeddings=requirement_embeddings,
                visual_prompt_embeddings=visual_prompt_embeddings,
                media_kind=media_kind,
            )
        except Exception as exc:
            log.warning("manual_inbox: ingest_asset('%s') falhou: %s",
                       path.name, exc.__class__.__name__)
            continue
        if result.status == "ingested":
            ingested += 1
            log.info("manual_inbox: '%s' ingerido (media_kind=%s)",
                    path.name, media_kind)
        elif result.status == "skipped_duplicate":
            log.debug("manual_inbox: '%s' já na biblioteca (dedup SHA)",
                     path.name)
        else:
            log.warning("manual_inbox: '%s' rejeitado (%s)",
                       path.name, result.reason or result.status)
    return ingested
