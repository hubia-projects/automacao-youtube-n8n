"""Registo de licenças — implementação fail-closed de LIBRARY_POLICY.md.

Asset sem licença válida NÃO entra na biblioteca. Não existe caminho de
exceção; na dúvida, rejeitar.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ValidationError

Source = Literal["pexels", "pixabay", "wikimedia", "archive_org", "youtube_cc", "owned"]

# Licenças aceites por fonte (LIBRARY_POLICY.md §2)
ALLOWED_LICENSES: dict[str, set[str]] = {
    "pexels": {"pexels"},
    "pixabay": {"pixabay"},
    "wikimedia": {"cc-by", "cc-by-sa", "cc0", "pd"},
    "archive_org": {"cc-by", "cc-by-sa", "cc0", "pd"},
    "youtube_cc": {"cc-by"},
    "owned": {"owned"},
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
    verified_by: Literal["api", "manual"] = "api"


def validate_license(raw: dict | LicenseRecord) -> LicenseRecord:
    """Valida e normaliza; levanta LicenseError em qualquer irregularidade."""
    try:
        rec = raw if isinstance(raw, LicenseRecord) else LicenseRecord.model_validate(raw)
    except ValidationError as exc:
        raise LicenseError(f"registo de licença inválido: {exc}") from exc

    if not rec.source_url and rec.source != "owned":
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
