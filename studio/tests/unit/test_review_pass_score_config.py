"""Item 17/32: review_pass_score configurável (era PASS_SCORE=75 hardcoded
em S11Review, sem override possível sem editar código)."""
from __future__ import annotations

import inspect

from studio.config import Settings
from studio.stages import produce


def test_settings_tem_review_pass_score_default_75():
    s = Settings()
    assert s.review_pass_score == 75.0
    assert s.review_max_rounds == 2


def test_settings_review_pass_score_aceita_override():
    s = Settings(review_pass_score=90.0)
    assert s.review_pass_score == 90.0


def test_settings_tem_auto_acquire_library_default_false():
    s = Settings()
    assert s.auto_acquire_library is False


def test_s11review_le_pass_score_de_settings_nao_hardcoded():
    source = inspect.getsource(produce.S11Review.run)
    assert 'getattr(ctx.settings, "review_pass_score"' in source
    # a comparação de gate usa a variável local (lida de settings), não
    # mais a constante da classe directamente
    assert "score >= pass_score" in source
    assert "rnd == max_rounds" in source
