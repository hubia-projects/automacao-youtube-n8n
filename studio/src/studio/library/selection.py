"""selection.py — item I/J (closure pass): allocação real de shots por
requirement + selection feasibility.

`build_workset()` deixava `selected_shots.json` como scaffold vazio
(`{"by_entity": {}}`) — nenhuma camada decidia de facto QUAIS shots cobrem
cada requirement, nem se a cobertura medida (segundos/shots disponíveis)
é de facto ALOCÁVEL sem conflito (o mesmo shot podia "contar" para duas
requirements em simultâneo em `is_workset_ready`, inflando a leitura de
prontidão).

`allocate_shots()` é um greedy determinístico sobre os matches já
persistidos na `RequirementIndex` (reusa E/G — nunca rescaneia a
biblioteca): strict primeiro (só `CS_CONFIRMED`), depois core não-estrito
(`CS_CONFIRMED` + `CS_NOT_REQUIRED`), depois filler por último — nunca
reutiliza um `shot_id` já alocado a outra requirement, e respeita um cap
por `media_sha` (mesmo ficheiro físico não pode fornecer shots
indefinidamente para a mesma requirement).
"""
from __future__ import annotations

from dataclasses import dataclass

from studio.library.requirement_index import CS_CONFIRMED, CS_NOT_REQUIRED
from studio.matching.coverage_plan import FILLER_ENTITY_TYPE


@dataclass
class AllocationResult:
    by_requirement: dict[str, list[str]]
    feasible_by_requirement: dict[str, bool]

    @property
    def selection_feasible(self) -> bool:
        return bool(self.feasible_by_requirement) and all(
            self.feasible_by_requirement.values())


def allocate_shots(
    plan,
    workset_ctx,
    ri,
    *,
    max_uses_per_media: int = 1,
) -> AllocationResult:
    """Greedy determinístico: strict > core não-estrito > filler.

    `workset_ctx.req_by_canonical(canonical_name).requirement_id` dá o
    mapping canonical -> requirement_id (a mesma identidade escrita por
    `workset_builder.build_workset()` em visual_requirements.json).
    """
    workset_id = workset_ctx.workset_id
    used_shots: set[str] = set()
    media_uses: dict[str, int] = {}
    by_requirement: dict[str, list[str]] = {}
    feasible_by_requirement: dict[str, bool] = {}

    def _allocate_one(ent, req_id: str, statuses: set[str]) -> None:
        matches = ri.list_for_requirement(workset_id, req_id)
        eligible = [m for m in matches if m.confirmation_status in statuses]
        eligible.sort(key=lambda m: -m.similarity)
        picked: list[str] = []
        secs = 0.0
        for m in eligible:
            if m.shot_id in used_shots:
                continue
            sha = m.media_sha
            if sha and media_uses.get(sha, 0) >= max_uses_per_media:
                continue
            picked.append(m.shot_id)
            used_shots.add(m.shot_id)
            if sha:
                media_uses[sha] = media_uses.get(sha, 0) + 1
            secs += m.duration
            if (secs >= ent.target_seconds
                    and len(picked) >= ent.min_distinct_shots):
                break
        by_requirement[req_id] = picked
        feasible_by_requirement[req_id] = (
            secs >= ent.target_seconds and len(picked) >= ent.min_distinct_shots)

    core = [e for e in plan.ranked_entities if e.entity_type != FILLER_ENTITY_TYPE]
    filler = [e for e in plan.ranked_entities if e.entity_type == FILLER_ENTITY_TYPE]
    strict_core = [e for e in core if e.strict]
    nonstrict_core = [e for e in core if not e.strict]

    def _req_id(ent) -> str | None:
        spec = workset_ctx.req_by_canonical(ent.canonical_name)
        return spec.requirement_id if spec is not None else None

    for ent in strict_core:
        req_id = _req_id(ent)
        if req_id:
            _allocate_one(ent, req_id, {CS_CONFIRMED})
    for ent in nonstrict_core:
        req_id = _req_id(ent)
        if req_id:
            _allocate_one(ent, req_id, {CS_CONFIRMED, CS_NOT_REQUIRED})
    for ent in filler:
        req_id = _req_id(ent)
        if req_id:
            _allocate_one(ent, req_id, {CS_CONFIRMED, CS_NOT_REQUIRED})

    return AllocationResult(by_requirement=by_requirement,
                            feasible_by_requirement=feasible_by_requirement)
