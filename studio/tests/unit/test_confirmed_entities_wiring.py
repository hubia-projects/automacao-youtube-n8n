"""Regressão item 13: confirmed_entities nunca chegava a assign_shots.

S08Matching fazia warm-up de confirmação Vision (require_entity_confirmation)
mas descartava o retorno — todas as 5 chamadas a assign_shots (4 em
produce.py + 1 em review/fixes.py) usavam o default confirmed_entities=None,
o que desliga o gate estrito da Fase F inteiramente em produção (fail-open
mesmo em cenas strict_entity=True).

Este teste inspecciona o source dos dois módulos (mais robusto do que
correr o pipeline completo, que exige artefactos 01_topic..07_briefs em
disco) — garante que cada chamada a assign_shots(...) passa
confirmed_entities explicitamente, e que produce.py constrói o dict a
partir do retorno real de require_entity_confirmation (não descarta).
"""
from __future__ import annotations

import inspect
import re

from studio.review import fixes as review_fixes
from studio.stages import produce


def test_todas_as_chamadas_assign_shots_em_produce_passam_confirmed_entities():
    source = inspect.getsource(produce)
    calls = re.findall(r"assign_shots\(.*?\n(?:.*\n)*?\s*\)", source)
    # fallback mais robusto: split por "assign_shots(" e contar quantas
    # chamadas (até ao ")" correspondente) mencionam confirmed_entities=
    count_calls = source.count("assign_shots(")
    count_with_kwarg = source.count("confirmed_entities=confirmed_entities")
    assert count_calls == 4, f"esperava 4 chamadas a assign_shots, achei {count_calls}"
    assert count_with_kwarg == count_calls, (
        f"{count_calls} chamadas a assign_shots mas só "
        f"{count_with_kwarg} passam confirmed_entities=confirmed_entities"
    )


def test_warmup_loop_nao_descarta_retorno_de_require_entity_confirmation():
    source = inspect.getsource(produce)
    assert "confirmed = require_entity_confirmation(" in source, (
        "retorno de require_entity_confirmation devia ser capturado "
        "(regressão: bug antigo descartava-o)"
    )
    assert "confirmed_entities[ent.canonical_name.strip().lower()] = confirmed" in source


def test_review_fixes_passa_confirmed_entities_quando_strict():
    source = inspect.getsource(review_fixes)
    assert "confirmed_entities=confirmed_entities" in source
    assert "require_entity_confirmation(" in source
