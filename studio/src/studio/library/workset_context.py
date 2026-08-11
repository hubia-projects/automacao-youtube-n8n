"""WorksetContext canónico — ÚNICA porta de leitura de workset no studio.

Substitui helpers dispersos por:
- reconcile._load_workset_visual_requirements (Fase F 2026-08)
- reconcile._build_requirement_prompts
- reconcile._visual_requirements_source

Modo:
- WORKFLOW      → load workset/visual_requirements.json obrigatório.
- MAINTENANCE   → sem requirements; só metadata global.

PRINCÍPIO CENTRAL:
    visual_requirements.json é a FONTE CANÓNICA (não se recalcula
    target_seconds / min_distinct_shots / narration_t_in/out) em JSON já
    versionado — Settings só actua quando CRIAMOS requirements novos.

EMENTA DO MÓDULO:
    - RequirementSpec    : spec canónico de 1 entity do workset
    - WorksetContext     : dataclass read-mostly com cache de embeddings
    - load_workset_context() : ÚNICO ponto público de carregamento
    - validate_workset()     : check fail-closed de schema mínimo
    - canonical_helpers      : aliases / slug / overlap detection

FALHAS:
    - sem workflow.json em --workflow mode     → RuntimeError
    - sem visual_requirements.json             → RuntimeError
    - requirements vazios                      → RuntimeError
    - min_distinct_shots<=0 ou target<=0       → coerciona + warning
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger("studio.workset_context")

# Mode constants
MODE_WORKFLOW = "WORKFLOW"
MODE_MAINTENANCE = "MAINTENANCE"

# SSoT: o loader escreve aqui a proveniência efectiva (audit-friendly).
SRC_WORKSET_DIR = "workset/visual_requirements.json"
SRC_WORKSET_FLAT = "workset/<workflow_id>.json"
SRC_INFERRED = "inferred"


def _slug(s: str) -> str:
    """Slugify canonical_entity para Norte-South style entity_id.

    Ex: "Livraria Lello" → "livrairalello". Remove acentos via transliteração
    Python unicodedata que vem com stdlib.
    """
    import unicodedata
    nfkd = unicodedata.normalize("NFKD", s)
    plain = "".join(c for c in nfkd if not unicodedata.combining(c))
    plain = plain.lower().strip()
    return re.sub(r"[^a-z0-9]+", "", plain)


@dataclass(frozen=True)
class RequirementSpec:
    """Spec canónico de 1 requirement. EXACTAMENTE os campos do JSON.

    Defaults são safety net: em JSON bem formado nunca são necessários.
    Settings NÃO entram aqui (Settings só é usado na CRIAÇÃO).

    visual_prompts_en (schema_version >= 1.1) — vector bank de descrições
    visuais em inglês para alinhar SigLIP text-tower (EN pre-training) com
    footages do Porto. read-mostly. Empty tuple se JSON não tiver (legado).
    """
    requirement_id: str
    canonical_entity: str
    entity_type: str
    strict: bool
    required_seconds: float
    target_seconds: float
    min_distinct_shots: int
    narration_t_in: float
    narration_t_out: float
    aliases: tuple[str, ...] = ()
    location: str = ""
    narration_seconds: float = 0.0    # computed (out - in) — convenience
    visual_prompts_en: tuple[str, ...] = ()

    @property
    def entity_id(self) -> str:
        return f"workset_{_slug(self.canonical_entity)}:{self.requirement_id}"


@dataclass
class WorksetContext:
    """Resultado do load_workset_context(). Read-mostly dataclass.

    Embeddings SigLIP cacheados aqui UMA VEZ por run (SIGLIP_TEXT_CACHE).
    NÃO recomputar em chamadas downstream (ingest_asset, assigner, etc.).

    §P5 (2026-08-11): visual_prompt_embeddings — dict[canonical -> list of
    np.ndarray (cada um 768-dim normalizado)]. Lista de embeddings para
    MULTI-PROMPT RETRIEVAL (max cosine). requirement_embeddings mantém-se
    como o embed canónico (single vector) para retro-compat.
    """
    mode: str
    workset_id: str
    workflow_id: str
    source: str                       # SRC_WORKSET_DIR etc.
    workset_dir: Path
    workflow_json: dict
    requirements: list[RequirementSpec] = field(default_factory=list)
    requirement_prompts: dict[str, str] = field(default_factory=dict)
    requirement_embeddings: dict[str, np.ndarray] = field(default_factory=dict)
    visual_prompt_embeddings: dict[str, list] = field(default_factory=dict)
    siglip_model_id: str = ""
    coverage_plan: Optional[dict] = None    # lazy; populated by assigner

    def req_by_canonical(self, canonical: str) -> Optional[RequirementSpec]:
        for r in self.requirements:
            if r.canonical_entity == canonical:
                return r
        return None

    def canonicals(self) -> list[str]:
        return [r.canonical_entity for r in self.requirements]


def _coerce_requirement(raw: dict, idx: int) -> Optional[RequirementSpec]:
    """Converte 1 entry de visual_requirements.json → RequirementSpec.

    Preserva EXACTAMENTE os valores do JSON (P3 — não recalcular).
    Defaults vêm do safety net.
    Retorna None se canonical_entity ausente (warning logged).
    """
    canonical = (raw.get("canonical_entity") or "").strip()
    if not canonical:
        log.warning("workset: requirement[%d] sem canonical_entity — skip", idx)
        return None
    target = float(raw.get("target_seconds", 0.0) or 0.0)
    min_shots = int(raw.get("min_distinct_shots", 1) or 1)
    if target <= 0:
        log.warning(
            "workset: requirement '%s' target_seconds<=0 (got %.2f) — "
            "coverage gate vai sinalizar PARTIAL",
            canonical, target)
        target = 0.0  # express "intent not met" not coerce to safe value
    if min_shots <= 0:
        log.warning(
            "workset: requirement '%s' min_distinct_shots<=0 (got %d) — "
            "coerce to 1",
            canonical, min_shots)
        min_shots = 1
    t_in = float(raw.get("narration_t_in", 0.0) or 0.0)
    t_out = float(raw.get("narration_t_out", 0.0) or 0.0)
    nar_s = max(0.0, t_out - t_in)
    # §P5 (Porto Alignment 2026-08-11): parse visual_prompts_en se existir.
    raw_prompts = raw.get("visual_prompts_en") or []
    if not isinstance(raw_prompts, list):
        log.warning("workset: requirement '%s' visual_prompts_en NÃO é list — skip",
                    canonical)
        raw_prompts = []
    visual_prompts = tuple(p.strip() for p in raw_prompts
                            if isinstance(p, str) and p.strip())
    return RequirementSpec(
        requirement_id=str(raw.get("requirement_id") or f"R{idx:02d}-{_slug(canonical)[:8]}"),
        canonical_entity=canonical,
        entity_type=raw.get("entity_type") or "place",
        strict=bool(raw.get("strict", False)),
        required_seconds=float(raw.get("required_seconds", 0.0) or 0.0),
        target_seconds=target,
        min_distinct_shots=min_shots,
        narration_t_in=t_in,
        narration_t_out=t_out,
        narration_seconds=nar_s,
        aliases=tuple(a for a in (raw.get("aliases") or []) if a),
        location=str(raw.get("location", "") or ""),
        visual_prompts_en=visual_prompts,
    )


def _build_requirement_prompts(reqs: list[RequirementSpec]) -> dict[str, str]:
    """canonical_entity -> text_en composto (canonical + type + loc + aliases).

    SigLIP text tower é EN-only (ADR-0003) mas nomes latinizados (Lello,
    Francesinha, Sao Bento) ainda assim funcionam para coseno visual.
    """
    out: dict[str, str] = {}
    for r in reqs:
        parts: list[str] = [r.canonical_entity]
        if r.entity_type:
            parts.append(r.entity_type)
        if r.location:
            parts.append(r.location)
        for a in r.aliases:
            if a and a.lower() != r.canonical_entity.lower():
                parts.append(a)
        text = " ".join(parts).strip()
        if text:
            out[r.canonical_entity] = text
    return out


def _resolve_siglip_model_id(embedder) -> str:
    """Lê o model_id activo do SiglipEmbedder sem hardcodar.

    Preferência:
      - embedder.model_id attribute (property)
      - embedder.MODEL_ID constant fallback (legado)
      - "google/siglip-base-patch16-384" string fallback final
    """
    if embedder is None:
        return "google/siglip-base-patch16-384"
    for attr in ("model_id", "MODEL_ID"):
        try:
            v = getattr(embedder, attr, None)
            if isinstance(v, str) and v:
                return v
        except Exception:
            pass
    return "google/siglip-base-patch16-384"


def validate_workset(ctx: WorksetContext) -> None:
    """Schema check fail-closed. Raises ValueError com mensagem clara.

    Usado em produção antes de cada pipeline step que assume contexto válido.
    """
    if ctx.mode == MODE_WORKFLOW:
        if not ctx.requirements:
            raise ValueError(
                f"WorksetContext INVÁLIDO: mode=WORKFLOW mas requirements vazio "
                f"(workflow='{ctx.workflow_id}'). Verifica "
                f"data/library/worksets/{ctx.workflow_id}/visual_requirements.json.")
        for r in ctx.requirements:
            if not r.canonical_entity:
                raise ValueError(
                    f"WorksetContext INVÁLIDO: requirement '{r.requirement_id}' "
                    f"sem canonical_entity (workflow='{ctx.workflow_id}').")
        if not ctx.requirement_prompts and ctx.requirements:
            raise ValueError(
                f"WorksetContext INVÁLIDO: requirements={len(ctx.requirements)} "
                f"mas requirement_prompts vazio. Bug interno do loader.")


def load_workset_context(
    *,
    workflow_id: str,
    workset_dir: Path,
    embedder,
    mode: str = MODE_WORKFLOW,
    workflow_json: Optional[dict] = None,
) -> WorksetContext:
    """Único entry point de carregamento canónico.

    Reads:
      1. data/library/worksets/<workflow_id>/visual_requirements.json (canonical)
      2. data/library/worksets/<workflow_id>.json  (legacy fallback)
      3. data/library/workflows/<workflow_id>.json  (workflow metadata)

    Args:
        workflow_id: id da workflow (e.g. "porto-essencia-001")
        workset_dir: Path do directório de workset (worksets/<id>/)
        embedder: SiglipEmbedder (necessário em WORKFLOW; None tolera em MAINTENANCE)
        mode: MODE_WORKFLOW | MODE_MAINTENANCE
        workflow_json: dict override (se já carregado em caller)

    Returns:
        WorksetContext com requirement_embeddings calculados se WORKFLOW.

    Raises:
        RuntimeError: workset ausente em WORKFLOW mode (fail-closed).
        RuntimeError: workflow.json ausente em WORKFLOW mode (fail-closed).
    """
    if mode == MODE_WORKFLOW and not workflow_json:
        wf_path = workset_dir.parent.parent / "workflows" / f"{workflow_id}.json"
        if wf_path.exists():
            try:
                workflow_json = json.loads(wf_path.read_text(encoding="utf-8"))
                log.debug("workset: workflow_json loaded %s", wf_path.name)
            except (OSError, json.JSONDecodeError) as exc:
                log.warning("workset: workflow.json ilegível %s: %s",
                            wf_path, exc.__class__.__name__)
        else:
            # Em WORKFLOW mode é permitido sem workflow.json se o caller já
            # passou workflow_json explicitamente; aqui ainda não passou, então
            # inicializa dict vazio (assigner/coverage pode operar sem theme).
            workflow_json = {}

    if mode == MODE_MAINTENANCE:
        # MAINTENANCE não exige visual_requirements; só metadata global barata.
        return WorksetContext(
            mode=mode,
            workset_id=workflow_id,
            workflow_id=workflow_id,
            source=SRC_INFERRED,
            workset_dir=workset_dir,
            workflow_json=workflow_json or {},
            siglip_model_id=_resolve_siglip_model_id(embedder),
        )

    if mode == MODE_WORKFLOW:
        # Fail-closed: visual_requirements.json OBRIGATÓRIO em WORKFLOW mode.
        if not workset_dir.exists():
            raise RuntimeError(
                f"workset_context: workset dir ausente em mode=WORKFLOW: "
                f"{workset_dir}. Cria data/library/worksets/{workflow_id}/ "
                f"e popula visual_requirements.json antes de produção.")
        # Hierarchy: directory/visual_requirements.json > flat <wf>.json
        primary = workset_dir / "visual_requirements.json"
        legacy = workset_dir.parent / f"{workflow_id}.json"
        vr_path: Optional[Path] = None
        source: str = SRC_INFERRED
        if primary.exists():
            vr_path = primary
            source = SRC_WORKSET_DIR
        elif legacy.exists():
            vr_path = legacy
            source = SRC_WORKSET_FLAT
        if not vr_path:
            raise RuntimeError(
                f"workset_context: WORKFLOW mode requer visual_requirements.json "
                f"em {primary} (ou legacy {legacy}). REFUSING to run (fail-closed).")
        try:
            raw = json.loads(vr_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(
                f"workset_context: visual_requirements.json ilegível em "
                f"{vr_path}: {exc.__class__.__name__}: {exc}") from exc

        # Coerce entries
        requirements: list[RequirementSpec] = []
        for idx, request in enumerate(raw.get("requirements") or []):
            if not isinstance(request, dict):
                log.warning("workset: requirement[%d] não é dict — skip", idx)
                continue
            r = _coerce_requirement(request, idx)
            if r is not None:
                requirements.append(r)

        if not requirements:
            raise RuntimeError(
                f"workset_context: visual_requirements.json em {vr_path} "
                f"TEM requirements=0 entries (após coerce). REFUSING to run.")

        requirement_prompts = _build_requirement_prompts(requirements)
        siglip_model_id = _resolve_siglip_model_id(embedder)

        ctx = WorksetContext(
            mode=mode,
            workset_id=workflow_id,
            workflow_id=workflow_id,
            source=source,
            workset_dir=workset_dir,
            workflow_json=workflow_json or {},
            requirements=requirements,
            requirement_prompts=requirement_prompts,
            siglip_model_id=siglip_model_id,
        )

        # Compute embeddings ONCE per run (P1.2 fix). Reusable por todos os
        # callers downstream (ingest_asset, acquisition, discovery).
        # §P5 (Porto Alignment 2026-08-11): MULTI-PROMPT visual prompt bank
        # embeddings também calculadas aqui (1 cache hit por visual prompt
        # singleton, distinct hash garante).
        prompt_version = "visual-v2" if any(
            r.visual_prompts_en for r in requirements) else "v1"
        if embedder is not None:
            for canon, text_en in requirement_prompts.items():
                try:
                    req_id = next((r.requirement_id for r in requirements
                                   if r.canonical_entity == canon), None)
                    ctx.requirement_embeddings[canon] = embedder.embed_text(
                        text_en,
                        requirement_id=req_id,
                        prompt_version=prompt_version,
                        workflow_id=workflow_id,
                        model_id=siglip_model_id,
                    )
                except Exception as exc:
                    log.warning(
                        "workset_context: embedding SIGLIP falhou para "
                        "'%s': %s — caller gere fallback",
                        canon, exc.__class__.__name__)
            # Visual prompt bank embeddings — uma vez por visual prompt
            # (cache key inclui SHA256(text) pós-fix §P5).
            for req in requirements:
                canon = req.canonical_entity
                visual_prompts = list(req.visual_prompts_en or [])
                if not visual_prompts:
                    ctx.visual_prompt_embeddings[canon] = []
                    continue
                embs: list[np.ndarray] = []
                for vp_text in visual_prompts:
                    try:
                        v = embedder.embed_text(
                            vp_text,
                            requirement_id=req.requirement_id,
                            prompt_version=prompt_version,
                            workflow_id=workflow_id,
                            model_id=siglip_model_id,
                        )
                        embs.append(v)
                    except Exception as exc:
                        log.warning(
                            "workset_context: visual_prompt embedding falhou "
                            "'%s' para '%s': %s",
                            vp_text[:32], canon, exc.__class__.__name__)
                ctx.visual_prompt_embeddings[canon] = embs
        validate_workset(ctx)
        return ctx

    raise RuntimeError(f"workset_context: mode desconhecido: {mode}")


__all__ = [
    "MODE_WORKFLOW",
    "MODE_MAINTENANCE",
    "RequirementSpec",
    "WorksetContext",
    "load_workset_context",
    "validate_workset",
    "_slug",
]
