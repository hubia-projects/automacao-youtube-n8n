"""Testes de regressão da instrumentação Profiler em validate_alignment.

Confirma que:
1. validate_alignment chama Profiler.record("alignment", ...) com
   items = nº de violations acumuladas.
2. elapsed > 0 — coverage do try/except path.
3. Após um AlignmentReport() válido, `alignment.calls >= 1` em Profiler.
4. Se Profiler.record() levantar AttributeError (simulado via mock),
   a função NÃO cai — observability não bloqueia.
5. Se Profiler.record() levantar Exception OUTRA (não AttributeError),
   a função propaga (NÃO swallow de bugs reais).
6. Profiler.write() cria <run>/performance.json válido contendo
   a entrada "alignment".
7. `import time` está no topo do módulo (PEP 8) e não inline.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from studio.perf import Profiler
from studio.matching.alignment import validate_alignment, ViolationType
from studio.config import Settings


@pytest.fixture(autouse=True)
def _reset_profiler():
    Profiler.reset()
    yield
    Profiler.reset()


def test_validate_alignment_calls_profiler_with_violation_count():
    """Prova que validate_alignment regista Profiler mesmo com 0 violations."""
    s = Settings()
    result = validate_alignment(
        scenes=[], briefs=[], segments=[], entity_spans=[],
        coverage_plan=None, settings=s,
    )
    assert result is not None  # sanity (tipos cobertos nos outros tests)
    op = Profiler.snapshot()["operations"].get("alignment", {})
    assert op.get("calls", 0) >= 1, "alignment não foi registado"
    assert op.get("items", -1) == len(result.violations), \
        f"items={op.get('items')} não bate com nº de violations {len(result.violations)}"
    assert op.get("seconds", -1.0) >= 0.0


def test_validate_alignment_profiler_items_grow_with_violations():
    """Items Profiler cresce com violations acumuladas — sanity-check."""
    from studio.script.scenes import Scene
    from studio.matching.briefs import VisualBrief
    from studio.matching.assigner import SegmentAssignment

    s = Settings()

    scene = Scene(
        scene_id="s1", t_in=0.0, t_out=10.0, beat="payoff",
        text="Francesinha", primary_entity="Francesinha",
        primary_entity_type="food", entity_aliases=[],
        entity_importance=0.9, strict_entity=True, location_context="Porto",
    )
    brief = VisualBrief(
        scene_id="s1", visual_subject_en="francesinha sandwich",
        mood="warm", shot_type="close-up",
        must_have=["plate", "sandwich"], must_not=["people"],
        required_entity="Francesinha", required_entity_type="food",
        required_entity_aliases=[], strict_entity=True,
    )
    # SegmentAssignment exige os campos adicionais (Pydantic): beat,
    # media_sha, source_in, source_out, similarity, quality, duration.
    # media_path é str (não PosixPath).
    segment = SegmentAssignment(
        scene_id="s1", seg_index=0, t_in=0.0, t_out=5.0,
        shot_id="sh1", media_sha="abc123",
        beat="payoff", similarity=0.9, quality=7,
        source_in=0.0, source_out=5.0, duration=5.0,
        media_path="fake.mp4",
    )

    result = validate_alignment(
        scenes=[scene], briefs=[brief], segments=[segment],
        entity_spans=[], coverage_plan=None, settings=s,
    )
    n_violations = len(result.violations)
    assert n_violations >= 1, f"esperado ≥1 violation (strict scene), obtido {n_violations}"
    op = Profiler.snapshot()["operations"]["alignment"]
    assert op["items"] == n_violations, "items não bate com violations reais"


def test_validate_alignment_survives_profiler_attribute_error():
    """Se Profiler.record lança AttributeError (Settings mock-incompleto),
    alinhamento NÃO cai — observability.first."""
    s = Settings()

    def boom_attribute_error(category, seconds, items=1):
        raise AttributeError("Simulated Settings missing (test)")

    with patch.object(Profiler, "record", side_effect=boom_attribute_error):
        result = validate_alignment(
            scenes=[], briefs=[], segments=[], entity_spans=[],
            coverage_plan=None, settings=s,
        )
    assert result.total_segments == 0
    assert result.violations == []


def test_validate_alignment_propagates_non_observed_exception():
    """Se Profiler.record lança RuntimeError (não-observed), alinhamento
    propaga — narrow except NÃO swallow de bugs reais."""
    s = Settings()

    def boom_runtime(category, seconds, items=1):
        raise RuntimeError("Simulated Pydantic / ValidationError (test)")

    with patch.object(Profiler, "record", side_effect=boom_runtime):
        with pytest.raises(RuntimeError, match="Simulated"):
            validate_alignment(
                scenes=[], briefs=[], segments=[], entity_spans=[],
                coverage_plan=None, settings=s,
            )


def test_profiler_write_includes_alignment_category(tmp_path):
    """Regression: performance.json inclui alignment (e categories aliás)."""
    s = Settings()
    Profiler.reset()

    validate_alignment(
        scenes=[], briefs=[], segments=[], entity_spans=[],
        coverage_plan=None, settings=s,
    )
    out = Profiler.write(tmp_path)
    assert out is not None
    data = json.loads(out.read_text("utf-8"))
    assert "alignment" in data["operations"]
    assert data["operations"]["alignment"]["calls"] >= 1


def test_validate_alignment_uses_top_level_time_import():
    """Regression de PEP 8: `import time` está no topo do módulo (NÃO inline).

    Lê o ficheiro directamente (não via inspect.getsource que pode incluir
    só a parte do módulo após decoradores/lazy imports).
    """
    from pathlib import Path
    import studio.matching.alignment as mod
    src_path = Path(mod.__file__).read_text(encoding="utf-8")
    # Não pode ter o pattern `import time as _t_align` (que era o legado inline).
    assert "import time as _t_align" not in src_path, \
        "alignment.py ainda tem import time inline — deve subir para topo"
    # `import time` deve existir nas primeiras 40 linhas (não na docstring).
    head_lines = "\n".join(src_path.splitlines()[:40])
    assert "import time" in head_lines, \
        "alignment.py tem de ter `import time` nas primeiras 40 linhas"


def test_validate_alignment_segs_run_path_no_explosion(tmp_path):
    """Sanity-check integração rápida: settings reais + temp run path."""
    s = Settings()
    Profiler.reset()

    result = validate_alignment(
        scenes=[], briefs=[], segments=[], entity_spans=[],
        coverage_plan=None, settings=s,
    )
    assert "total_violations" in result.summary
    assert result.summary["strict_violations"] == 0
    assert result.summary["warnings"] == 0
    Profiler.write(tmp_path)
    assert (tmp_path / "performance.json").exists()


def test_validate_alignment_survives_coverage_plan_attribute_error():
    """Trava a SSoT narrow no gap-report do coverage_plan (regressão Fase 1).

    Cenário: CoveragePlan mock onde `ranked_entities[i].canonical_name`
    rebenta AttributeError quando o gap-report tenta anexar a Violation.
    validate_alignment SOBREVIVE (gap-report é best-effort), e o resto do
    comportamento (Profiler.record + report final) mantém-se intacto.

    Sem este teste, alguém pode amanhã restaurar `except Exception` no
    gap-report e a CI não apanha — o narrow seria silenciosamente perdido.
    """
    s = Settings()

    class _BrokenRankedEntity:
        """Entity simulada que parece strict+com deficit mas rebenta
        AttributeError no acesso a canonical_name, forçando o except
        narrow dentro do gap-report."""
        strict = True
        deficit_seconds = 5.0
        required_seconds = 30.0
        entity_type = "food"

        @property
        def canonical_name(self):
            raise AttributeError("Simulated missing canonical_name (test)")

    class _BrokenCoveragePlan:
        ranked_entities = [_BrokenRankedEntity()]

    result = validate_alignment(
        scenes=[], briefs=[], segments=[], entity_spans=[],
        coverage_plan=_BrokenCoveragePlan(), settings=s,
    )
    # sobrevive: report existe e é válido
    assert result is not None
    assert result.total_segments == 0
    # gap-report best-effort: nenhuma ENTITY_COVERAGE_GAP foi anexada
    # Comparação directa ao enum (em vez de string `.value`) torna o teste
    # immune a renames futuros do valor string do enum.
    gap_violations = [
        v for v in result.violations
        if v.violation_type == ViolationType.ENTITY_COVERAGE_GAP
    ]
    assert gap_violations == [], \
        f"gap-report não devia anexar (broken entity): {gap_violations}"
    # Profiler foi registado normalmente (categoria 'alignment')
    op = Profiler.snapshot()["operations"].get("alignment", {})
    assert op.get("calls", 0) >= 1, \
        "Profiler.record('alignment') não foi chamado — narrow except comeu o caminho inteiro"
