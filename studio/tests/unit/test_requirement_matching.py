"""Testes requirement_matching.py (item F/U — matches semanticamente
justificados, substitui o anti-padrão all-shots×all-requirements
similarity=0.0 encontrado em reconcile.py)."""
from __future__ import annotations

import math
from unittest.mock import MagicMock

import numpy as np

from studio.library.requirement_index import CS_NOT_REQUIRED, CS_PENDING
from studio.library.requirement_matching import matches_for_shot


def _vec_cos(cos_theta: float) -> np.ndarray:
    cos_theta = max(-1.0, min(1.0, cos_theta))
    sin_theta = math.sqrt(max(0.0, 1.0 - cos_theta * cos_theta))
    return np.array([cos_theta, sin_theta], dtype=np.float32)


class _Spec:
    def __init__(self, canonical, requirement_id, strict):
        self.canonical_entity = canonical
        self.requirement_id = requirement_id
        self.strict = strict


def _ctx(canonicals, specs_by_canon, embeddings, banks=None):
    ctx = MagicMock()
    ctx.workset_id = "wf-test"
    ctx.canonicals.return_value = canonicals
    ctx.req_by_canonical.side_effect = lambda c: specs_by_canon.get(c)
    ctx.requirement_embeddings = embeddings
    ctx.visual_prompt_embeddings = banks or {}
    return ctx


def test_shot_sem_similaridade_suficiente_nao_gera_match():
    ctx = _ctx(
        ["Livraria Lello"],
        {"Livraria Lello": _Spec("Livraria Lello", "R1", strict=True)},
        {"Livraria Lello": _vec_cos(1.0)},
    )
    shot_vec = _vec_cos(-1.0)  # oposto — similaridade nula/negativa
    out = matches_for_shot(
        shot_id="s1", media_sha="sha1", t_in=0.0, t_out=5.0,
        shot_vec=shot_vec, workset_ctx=ctx, min_similarity=0.18,
    )
    assert out == []


def test_shot_com_similaridade_suficiente_strict_vira_pending():
    ctx = _ctx(
        ["Livraria Lello"],
        {"Livraria Lello": _Spec("Livraria Lello", "R1", strict=True)},
        {"Livraria Lello": _vec_cos(1.0)},
    )
    shot_vec = _vec_cos(0.9)
    out = matches_for_shot(
        shot_id="s1", media_sha="sha1", t_in=0.0, t_out=5.0,
        shot_vec=shot_vec, workset_ctx=ctx, min_similarity=0.18,
    )
    assert len(out) == 1
    m = out[0]
    assert m.requirement_id == "R1"
    assert m.confirmation_status == CS_PENDING
    assert m.similarity > 0.8
    assert m.duration == 5.0


def test_shot_com_similaridade_suficiente_non_strict_vira_not_required():
    ctx = _ctx(
        ["Rio Douro"],
        {"Rio Douro": _Spec("Rio Douro", "R2", strict=False)},
        {"Rio Douro": _vec_cos(1.0)},
    )
    shot_vec = _vec_cos(0.9)
    out = matches_for_shot(
        shot_id="s2", media_sha="sha2", t_in=10.0, t_out=14.0,
        shot_vec=shot_vec, workset_ctx=ctx, min_similarity=0.18,
    )
    assert len(out) == 1
    assert out[0].confirmation_status == CS_NOT_REQUIRED


def test_multiplos_requirements_so_os_relevantes_geram_match():
    """Um shot NUNCA deve gerar match para requirements irrelevantes —
    prova directa de que não é mais all-shots×all-requirements."""
    ctx = _ctx(
        ["Livraria Lello", "Francesinha", "Ponte Dom Luís I"],
        {
            "Livraria Lello": _Spec("Livraria Lello", "R1", strict=True),
            "Francesinha": _Spec("Francesinha", "R2", strict=True),
            "Ponte Dom Luís I": _Spec("Ponte Dom Luís I", "R3", strict=True),
        },
        {
            "Livraria Lello": _vec_cos(1.0),      # match forte
            "Francesinha": _vec_cos(-1.0),        # irrelevante
            "Ponte Dom Luís I": _vec_cos(-0.9),   # irrelevante
        },
    )
    shot_vec = _vec_cos(0.95)
    out = matches_for_shot(
        shot_id="s3", media_sha="sha3", t_in=0.0, t_out=3.0,
        shot_vec=shot_vec, workset_ctx=ctx, min_similarity=0.30,
    )
    assert len(out) == 1
    assert out[0].requirement_id == "R1"


def test_multi_prompt_bank_usa_max_score():
    ctx = _ctx(
        ["Livraria Lello"],
        {"Livraria Lello": _Spec("Livraria Lello", "R1", strict=True)},
        {"Livraria Lello": _vec_cos(-1.0)},  # single embedding fraco
        banks={"Livraria Lello": [_vec_cos(-1.0), _vec_cos(1.0)]},  # banco tem 1 bom
    )
    shot_vec = _vec_cos(0.95)
    out = matches_for_shot(
        shot_id="s4", media_sha="sha4", t_in=0.0, t_out=2.0,
        shot_vec=shot_vec, workset_ctx=ctx, min_similarity=0.30,
    )
    assert len(out) == 1  # usa o melhor prompt do banco, não o pior


def test_shot_vec_none_devolve_lista_vazia():
    ctx = _ctx(["X"], {"X": _Spec("X", "R1", True)}, {"X": _vec_cos(1.0)})
    assert matches_for_shot(
        shot_id="s5", media_sha="sha5", t_in=0.0, t_out=1.0,
        shot_vec=None, workset_ctx=ctx,
    ) == []


def test_requirement_sem_embedding_disponivel_e_ignorado():
    ctx = _ctx(["X"], {"X": _Spec("X", "R1", True)}, {})  # sem embeddings
    out = matches_for_shot(
        shot_id="s6", media_sha="sha6", t_in=0.0, t_out=1.0,
        shot_vec=_vec_cos(1.0), workset_ctx=ctx,
    )
    assert out == []
