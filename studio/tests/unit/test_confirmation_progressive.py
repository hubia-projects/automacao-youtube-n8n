"""Item K/L (closure pass): require_entity_confirmation progressivo +
sync real com RequirementIndex.

- Sem target_seconds/min_distinct_shots: comportamento legacy EXACTO (1
  micro-batch, top_k é o limite total) — regressão zero para callers antigos.
- Com target_seconds/min_distinct_shots: para assim que atingido, nunca
  manda todos os candidatos numa só chamada Vision.
- Com requirement_index: shots já CONFIRMED/REJECTED são excluídos do
  próximo batch; cada resultado (confirmado OU rejeitado) é sincronizado.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from studio.config import Settings
from studio.library.confirmation import _local_cache, require_entity_confirmation
from studio.library.metadata import DetectedEntity
from studio.library.requirement_index import (
    CS_CONFIRMED, CS_FAILED_RETRYABLE, CS_REJECTED,
)


def _shot(id_, t_in=0.0, t_out=1.0, media_sha="sha"):
    return {
        "shot_id": id_, "media_path": "", "keyframes_csv": "",
        "food_csv": "Francesinha", "landmarks_csv": "", "places_csv": "Porto",
        "meta_json": json.dumps({}), "t_in": t_in, "t_out": t_out,
        "media_sha": media_sha,
    }


def _db_with(rows):
    db = MagicMock()
    db.iter_rows = MagicMock(return_value=list(rows))
    db._table = MagicMock()
    db._table.update = MagicMock()
    return db


@pytest.fixture(autouse=True)
def _reset():
    _local_cache.clear()


def _settings():
    s = Settings(_env_file=None)
    object.__setattr__(s, "mock_mode", True)
    return s


def test_sem_target_comportamento_legacy_um_unico_batch_top_k_e_limite_total():
    candidates = [_shot(f"MockOK_francesinha_{i}") for i in range(6)]
    db = _db_with(candidates)
    out = require_entity_confirmation("Francesinha", "food", db, _settings(),
                                      top_k=4)
    # legacy: só os primeiros 4 candidatos são considerados (nunca os 6).
    assert len(out) == 4


def test_progressivo_para_assim_que_atinge_target_sem_esgotar_candidatos():
    # 10 candidatos confirmáveis de 3s cada; target=6s, min_shots=2 ->
    # devia parar depois do 1º micro-batch de top_k=2 (2 shots x 3s = 6s).
    candidates = [_shot(f"MockOK_francesinha_{i}", t_in=0.0, t_out=3.0)
                 for i in range(10)]
    db = _db_with(candidates)
    out = require_entity_confirmation(
        "Francesinha", "food", db, _settings(), top_k=2,
        target_seconds=6.0, min_distinct_shots=2,
    )
    assert len(out) == 2, (
        "devia ter parado no 1º micro-batch — nunca processar os 10 "
        "candidatos numa só vez"
    )


def test_progressivo_exclui_shots_ja_confirmados_ou_rejeitados_na_index():
    candidates = [_shot("MockOK_francesinha_1"), _shot("Generic_pastry_2"),
                 _shot("MockOK_francesinha_3")]
    db = _db_with(candidates)
    ri = MagicMock()
    from studio.library.requirement_index import RequirementMatch
    ri.list_for_requirement.return_value = [
        RequirementMatch(workset_id="w1", requirement_id="R01",
                         shot_id="MockOK_francesinha_1", media_sha="sha",
                         similarity=0.0, duration=1.0,
                         confirmation_status=CS_CONFIRMED,
                         confirmation_confidence=0.9, strict_eligible=True),
    ]
    out = require_entity_confirmation(
        "Francesinha", "food", db, _settings(), top_k=4,
        target_seconds=100.0, min_distinct_shots=100,
        requirement_id="R01", workset_id="w1", requirement_index=ri,
    )
    confirmed_ids = {r["shot_id"] for r in out}
    assert "MockOK_francesinha_1" not in confirmed_ids, (
        "shot já CONFIRMED na index não devia ser re-processado"
    )
    assert "MockOK_francesinha_3" in confirmed_ids


def test_progressivo_sincroniza_confirmados_e_rejeitados_na_index():
    candidates = [_shot("MockOK_francesinha_1"), _shot("Generic_pastry_2")]
    db = _db_with(candidates)
    ri = MagicMock()
    ri.list_for_requirement.return_value = []
    require_entity_confirmation(
        "Francesinha", "food", db, _settings(), top_k=4,
        target_seconds=100.0, min_distinct_shots=100,
        requirement_id="R01", workset_id="w1", requirement_index=ri,
    )
    assert ri.upsert_match.call_count == 2
    statuses = {m.args[0].shot_id: m.args[0].confirmation_status
               for m in ri.upsert_match.call_args_list}
    assert statuses["MockOK_francesinha_1"] == CS_CONFIRMED
    assert statuses["Generic_pastry_2"] == CS_REJECTED


def test_safety_cap_max_batches_nunca_vision_ilimitado():
    # 100 candidatos que NUNCA confirmam -> nunca atinge target; max_batches
    # tem de parar o loop bem antes de esgotar tudo.
    candidates = [_shot(f"Generic_never_{i}") for i in range(100)]
    db = _db_with(candidates)
    out = require_entity_confirmation(
        "Francesinha", "food", db, _settings(), top_k=4,
        target_seconds=1000.0, min_distinct_shots=1000,
        max_batches=3,
    )
    assert out == []
    # 3 batches x top_k(4) = no máx 12 candidatos processados, nunca 100.
    db.iter_rows.assert_called_once()


# ---------------------------------------------------------------------------
# Item 15 (automation closure) — infra_failure distingue CS_REJECTED
# (Vision viu e disse não, nunca re-tentado) de CS_FAILED_RETRYABLE (rede/
# parse/circuit-breaker — sem API key, elegível para retry num run futuro).
# ---------------------------------------------------------------------------
def test_infra_failure_vira_failed_retryable_nao_rejected():
    candidates = [_shot("shot_infra"), _shot("shot_generico")]
    db = _db_with(candidates)
    ri = MagicMock()
    ri.list_for_requirement.return_value = []

    def fake_confirm_batch(batch, canonical, entity_type, settings):
        return {
            "shot_infra": DetectedEntity(rejected=True, infra_failure=True,
                                         rejection_reason="no API key"),
            "shot_generico": DetectedEntity(rejected=True, infra_failure=False,
                                            rejection_reason="Vision: não presente"),
        }

    with patch("studio.library.confirmation._confirm_batch",
              side_effect=fake_confirm_batch):
        require_entity_confirmation(
            "Francesinha", "food", db, _settings(), top_k=4,
            target_seconds=100.0, min_distinct_shots=100,
            requirement_id="R01", workset_id="w1", requirement_index=ri,
        )
    statuses = {m.args[0].shot_id: m.args[0].confirmation_status
               for m in ri.upsert_match.call_args_list}
    assert statuses["shot_infra"] == CS_FAILED_RETRYABLE, (
        "falha de infra (sem API key) não devia ficar CS_REJECTED "
        "permanente — tem de poder ser re-tentada"
    )
    assert statuses["shot_generico"] == CS_REJECTED, (
        "verdict genuíno de Vision continua CS_REJECTED (nunca re-tentado)"
    )


def test_failed_retryable_nao_e_excluido_do_proximo_batch():
    candidates = [_shot("shot_infra")]
    db = _db_with(candidates)
    ri = MagicMock()
    from studio.library.requirement_index import RequirementMatch
    ri.list_for_requirement.return_value = [
        RequirementMatch(workset_id="w1", requirement_id="R01",
                         shot_id="shot_infra", media_sha="sha",
                         similarity=0.0, duration=1.0,
                         confirmation_status=CS_FAILED_RETRYABLE,
                         confirmation_confidence=0.0, strict_eligible=True),
    ]
    calls = []

    def fake_confirm_batch(batch, canonical, entity_type, settings):
        calls.append([c["shot_id"] for c in batch])
        return {"shot_infra": DetectedEntity(rejected=True, infra_failure=True,
                                             rejection_reason="transient")}

    with patch("studio.library.confirmation._confirm_batch",
              side_effect=fake_confirm_batch):
        require_entity_confirmation(
            "Francesinha", "food", db, _settings(), top_k=4,
            target_seconds=100.0, min_distinct_shots=100,
            requirement_id="R01", workset_id="w1", requirement_index=ri,
        )
    assert calls == [["shot_infra"]], (
        "shot CS_FAILED_RETRYABLE devia continuar elegível para retry "
        "(nunca excluído como CONFIRMED/REJECTED estariam)"
    )
