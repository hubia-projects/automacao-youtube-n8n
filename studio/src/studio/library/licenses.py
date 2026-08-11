"""Registo de licenças — implementação fail-closed de LIBRARY_POLICY.md.

Asset sem licença válida NÃO entra na biblioteca (excepto no caminho
especial `source="orphan"` — Phase 6 do plano architecture — onde o
ficheiro existe no disco mas NÃO temos proveniência Pexels/Pixabay. Esses
entram com license='unknown' e mantêm o regime restrito até revisão
manual.)

DOC: 20-principles library plan §P5 (canonical ingest_asset).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ValidationError

# Phase 6: 'orphan' adicionado para mp4 sem proveniência. validate_license
# tem branch dedicada que NÃO enforça ALLOWED_LICENSES nem exige source_url.
Source = Literal["pexels", "pixabay", "wikimedia", "archive_org",
                 "youtube_cc", "owned", "orphan"]

# Licenças aceites por fonte (LIBRARY_POLICY.md §2). Orphan não tem
# allow-list enforcement — validate_license toma caminho dedicado.
ALLOWED_LICENSES: dict[str, set[str]] = {
    "pexels": {"pexels"},
    "pixabay": {"pixabay"},
    "wikimedia": {"cc-by", "cc-by-sa", "cc0", "pd"},
    "archive_org": {"cc-by", "cc-by-sa", "cc0", "pd"},
    "youtube_cc": {"cc-by"},
    "owned": {"owned"},
    # orphan nunca consultado — branch especial em validate_license.
    "orphan": {"unknown", "owned"},
}
_ATTRIBUTION_REQUIRED = {"cc-by", "cc-by-sa"}


class LicenseError(RuntimeError):
    """Licença em falta ou inválida — o asset é rejeitado."""


class LicenseRecord(BaseModel):
    source: Source
    source_url: str
    license: str
    author: str = ""
    retrieved_at: str = ""
    attribution_required: bool = False
    attribution_text: str = ""
    share_alike: bool = False
    verified_by: Literal["api", "manual", "provider"] = "api"


def validate_license(raw: dict | LicenseRecord) -> LicenseRecord:
    """Valida e normaliza; levanta LicenseError em qualquer irregularidade.
    Fase 6 — branch dedicada para `source == "orphan"` que ignora a
    allow-list e o source_url obrigatório, aceitando license='unknown'.
    """
    try:
        rec = raw if isinstance(raw, LicenseRecord) else LicenseRecord.model_validate(raw)
    except ValidationError as exc:
        raise LicenseError(f"registo de licença inválido: {exc}") from exc

    # === Branch orphan (Phase 6) ===========================================
    if rec.source == "orphan":
        # Defaults defensivos: qualquer orphan NÃO deve vir com
        # share_alike ou attribution_required True até revisão manual.
        if rec.license == "":
            rec.license = "unknown"
        if not rec.source_url:
            rec.source_url = f"orphan:{rec.license}"
        rec.share_alike = False
        # attribution_required é deixado ao default (False) salvo se user
        # marcar explicitamente. attribution_text fica se fornecido.
        if not rec.retrieved_at:
            rec.retrieved_at = datetime.now(timezone.utc).isoformat()
        return rec
    # =========================================================================

    if not rec.source_url and rec.source != "owned":
        # owned continua a poder não ter source_url; resto exige.
        raise LicenseError("source_url obrigatório para fontes externas")

    allowed = ALLOWED_LICENSES[rec.source]
    if rec.license not in allowed:
        raise LicenseError(
            f"licença {rec.license!r} não permitida para fonte {rec.source!r} "
            f"(permitidas: {sorted(allowed)})"
        )

    if rec.license in _ATTRIBUTION_REQUIRED:
        rec.attribution_required = True
        if not rec.attribution_text:
            raise LicenseError(f"{rec.license} exige attribution_text")

    if rec.license == "cc-by-sa":
        rec.share_alike = True  # marcado restricted a jusante (fora da busca default)

    if rec.source == "youtube_cc" and rec.verified_by != "manual":
        raise LicenseError("youtube_cc exige verified_by=manual (canal na allowlist)")

    if not rec.retrieved_at:
        rec.retrieved_at = datetime.now(timezone.utc).isoformat()
    return rec
