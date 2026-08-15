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
    CS_CONFIRMED, CS_CONFIRMED_CORROBORATED, CS_FAILED_RETRYABLE, CS_REJECTED,
)


def _shot(id_, t_in=0.0, t_out=1.0, media_sha="sha", source_url="",
         landmarks_csv="", places_csv="Porto", food_csv="Francesinha"):
    return {
        "shot_id": id_, "media_path": "", "keyframes_csv": "",
        "food_csv": food_csv, "landmarks_csv": landmarks_csv,
        "places_csv": places_csv,
        "meta_json": json.dumps({}), "t_in": t_in, "t_out": t_out,
        "media_sha": media_sha, "source_url": source_url,
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


def test_imagem_confirmada_pelo_mesmo_oraculo_vision_sem_tratamento_especial():
    """item 17/18 (fecho de cobertura multi-provider): require_entity_
    confirmation é kind-agnostic — um shot media_kind="image" passa pelo
    MESMO mecanismo de confirmação Vision que vídeo, nunca confia em
    filename/categoria/provider como verdade absoluta. keyframes_csv de
    uma imagem é o próprio ficheiro (1 entrada) — funciona sem alteração."""
    img_shot = _shot("MockOK_francesinha_img")
    img_shot["media_kind"] = "image"
    img_shot["keyframes_csv"] = "/media/abc.jpg"
    db = _db_with([img_shot])
    out = require_entity_confirmation("Francesinha", "food", db, _settings(),
                                      top_k=4)
    assert len(out) == 1
    assert out[0]["media_kind"] == "image"


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


def test_batch_vision_dict_unico_sem_shot_id_aplica_se_a_todos_os_shots(
    tmp_path,
):
    """BUG REAL (microvalidação real, 2026-08-14): quando Gemini julga os
    shots do batch visualmente consistentes o suficiente para dar 1
    veredicto único, devolve 1 dict SEM "shot_id" — nunca um array por
    shot. Confirmado ao vivo: 2 fotos reais da Livraria Lello (Wikimedia)
    deram 1 resposta única com confidence=1.0 e evidência real (texto OCR
    "LELLO & IRMÃO", vitral "DECUS IN LABORE") — mas o parser antigo
    exigia match por shot_id que um dict único nunca tem, descartando
    TODO o batch como "batch parse miss" apesar da confirmação clara."""
    from studio.library.confirmation import _batch_vision_call

    kf1 = tmp_path / "kf1.jpg"
    kf2 = tmp_path / "kf2.jpg"
    kf1.write_bytes(b"fake jpeg 1")
    kf2.write_bytes(b"fake jpeg 2")
    shots = [
        {"shot_id": "img_ext", "keyframes_csv": str(kf1)},
        {"shot_id": "img_int", "keyframes_csv": str(kf2)},
    ]
    settings = MagicMock(mock_mode=False, gemini_api_key="fake-key")

    single_dict_response = json.dumps({
        "name": "Livraria Lello", "entity_type": "landmark",
        "confidence": 1.0, "rejected": False, "rejection_reason": "",
        "evidence": ["texto OCR 'LELLO & IRMÃO'",
                    "vitral 'DECUS IN LABORE'"],
    })
    with patch("studio.library.confirmation.generate_multimodal",
              return_value=(single_dict_response, 0.001)):
        out = _batch_vision_call(shots, "Livraria Lello", "landmark", settings)

    assert set(out.keys()) == {"img_ext", "img_int"}
    for sid, det in out.items():
        assert det.rejected is False, f"{sid} devia estar confirmado"
        assert det.infra_failure is False
        assert det.confidence == 1.0


# ---------------------------------------------------------------------------
# item PORTO (search+confirmation calibration) — decisão em camadas A/B/C.
# Zona A (>=min_conf=0.85): confirma puro. Zona B (0.70-0.849): só
# CONFIRMED_CORROBORATED com >=2 famílias INDEPENDENTES (OCR_EXACT +
# SOURCE_TITLE_MATCH). Zona C (<0.70): rejeita sempre, sem excepção.
# ---------------------------------------------------------------------------

def _confirm_with(det: DetectedEntity, canonical="Livraria Lello",
                  entity_type="landmark", aliases=(), aliases_en=(),
                  shot_kwargs=None):
    shot_kwargs = dict(shot_kwargs or {})
    # bug B2 fix: retrieval agora é REAL (candidate_matches_entity), não
    # bypassed pelo mock — por defeito o shot fica tagueado com o próprio
    # canonical (simula retrieval bem sucedida) para estes testes
    # exercitarem a camada de DECISÃO (zona A/B/C), não a retrieval em si
    # (essa tem testes próprios, ver test_candidate_matches_entity_*).
    shot_kwargs.setdefault("landmarks_csv", canonical.lower())
    candidates = [_shot("shot_a", **shot_kwargs)]
    db = _db_with(candidates)
    ri = MagicMock()
    ri.list_for_requirement.return_value = []

    with patch("studio.library.confirmation._confirm_batch",
              return_value={"shot_a": det}):
        require_entity_confirmation(
            canonical, entity_type, db, _settings(), top_k=4,
            target_seconds=100.0, min_distinct_shots=100,
            requirement_id="R01", workset_id="w1", requirement_index=ri,
            aliases=aliases, aliases_en=aliases_en,
        )
    call = ri.upsert_match.call_args_list[0].args[0]
    return call.confirmation_status, call.confirmation_confidence


def test_zona_a_confidence_alta_confirma_puro_sem_precisar_de_familias():
    det = DetectedEntity(name="Livraria Lello", confidence=0.92, rejected=False)
    status, conf = _confirm_with(det)
    assert status == CS_CONFIRMED
    assert conf == 0.92


def test_zona_b_com_2_familias_independentes_corrobora():
    """Caso real que motivou o pedido: foto real da Wikimedia da Livraria
    Lello, confidence=0.80 (abaixo de 0.85), OCR real 'LELLO & IRMÃO' +
    título do provider também batendo — devia ser CONFIRMED_CORROBORATED,
    não REJECTED."""
    det = DetectedEntity(
        name="Livraria Lello", confidence=0.80, rejected=False,
        ocr_text_found=["LELLO & IRMÃO"],
    )
    status, conf = _confirm_with(
        det, shot_kwargs={
            "source_url": "https://commons.wikimedia.org/wiki/"
                          "File:Exterior_view_of_Livraria_Lello_01.jpg",
        },
    )
    assert status == CS_CONFIRMED_CORROBORATED
    assert conf == 0.80


def test_zona_b_com_apenas_1_familia_continua_rejeitado():
    """OCR bate mas source_url é genérico (sem match) — só 1 família
    independente, insuficiente para corroborar (nunca aceitar por
    facilitismo)."""
    det = DetectedEntity(
        name="Livraria Lello", confidence=0.80, rejected=False,
        ocr_text_found=["LELLO & IRMÃO"],
    )
    status, _conf = _confirm_with(
        det, shot_kwargs={"source_url": "https://example.com/generic_photo.jpg"},
    )
    assert status == CS_REJECTED


def test_zona_b_sem_nenhuma_familia_rejeitado():
    det = DetectedEntity(name="Livraria Lello", confidence=0.80, rejected=False)
    status, _conf = _confirm_with(det)
    assert status == CS_REJECTED


def test_zona_c_confidence_baixa_rejeita_mesmo_com_evidencia_forte():
    """Doutrina explícita: <0.70 rejeita SEMPRE, sem excepção — mesmo que
    OCR e título batam (não pode compensar confidence genuinamente baixa
    com corroboração)."""
    det = DetectedEntity(
        name="Livraria Lello", confidence=0.5, rejected=False,
        ocr_text_found=["LELLO & IRMÃO"],
    )
    status, _conf = _confirm_with(
        det, shot_kwargs={
            "source_url": "https://commons.wikimedia.org/wiki/"
                          "File:Livraria_Lello_interior.jpg",
        },
    )
    assert status == CS_REJECTED


def test_vision_rejected_true_nunca_confirma_mesmo_com_confidence_alta():
    det = DetectedEntity(name="", confidence=0.9, rejected=True,
                         rejection_reason="entidade errada")
    status, _conf = _confirm_with(det)
    assert status == CS_REJECTED


def test_falso_positivo_livraria_generica_nao_confirma_como_lello():
    """'livraria bonita em Lisboa' genérica: confidence moderado (0.80,
    zona B) mas ZERO evidência específica da Lello — nunca confirmar só
    porque SigLIP/Vision achou parecido."""
    det = DetectedEntity(name="Livraria Lello", confidence=0.80, rejected=False,
                         ocr_text_found=["Livraria Chiado"])
    status, _conf = _confirm_with(
        det, shot_kwargs={
            "source_url": "https://commons.wikimedia.org/wiki/"
                          "File:Generic_bookstore_Lisbon.jpg",
        },
    )
    assert status == CS_REJECTED


def test_falso_positivo_catedral_generica_nao_confirma_como_se_do_porto():
    """catedral gótica genérica na Espanha: confidence moderado (0.80,
    zona B), OCR sem nada específico da Sé do Porto -> rejeitado."""
    det = DetectedEntity(name="Sé do Porto", confidence=0.80, rejected=False)
    status, _conf = _confirm_with(
        det, canonical="Sé do Porto", entity_type="landmark",
        shot_kwargs={
            "source_url": "https://commons.wikimedia.org/wiki/"
                          "File:Generic_gothic_cathedral_Spain.jpg",
        },
    )
    assert status == CS_REJECTED


def test_corroboracao_usa_aliases_nao_so_canonical():
    """OCR/título batem num ALIAS ('Lello'), não no canonical completo
    ('Livraria Lello') — corroboração deve reconhecer aliases, não só a
    string canonical exacta."""
    det = DetectedEntity(
        name="Livraria Lello", confidence=0.80, rejected=False,
        ocr_text_found=["LELLO"],
    )
    status, _conf = _confirm_with(
        det, aliases=("Lello",),
        shot_kwargs={
            "source_url": "https://commons.wikimedia.org/wiki/File:Lello_03.jpg",
        },
    )
    assert status == CS_CONFIRMED_CORROBORATED


def test_known_status_exclui_corroborated_do_proximo_batch():
    """CS_CONFIRMED_CORROBORATED conta como 'já resolvido' — não deve ser
    re-Vision'd num próximo run (mesma doutrina de CONFIRMED/REJECTED)."""
    from studio.library.requirement_index import (
        CS_CONFIRMED_CORROBORATED as _CSCC,
        RequirementMatch,
    )
    candidates = [_shot("shot_a")]
    db = _db_with(candidates)
    ri = MagicMock()
    ri.list_for_requirement.return_value = [
        RequirementMatch(workset_id="w1", requirement_id="R01",
                         shot_id="shot_a", media_sha="sha",
                         similarity=0.0, duration=1.0,
                         confirmation_status=_CSCC,
                         confirmation_confidence=0.80, strict_eligible=True),
    ]
    calls = []

    def fake_confirm_batch(batch, canonical, entity_type, settings):
        calls.append([c["shot_id"] for c in batch])
        return {}

    with patch("studio.library.confirmation._confirm_batch",
              side_effect=fake_confirm_batch):
        require_entity_confirmation(
            "Livraria Lello", "landmark", db, _settings(), top_k=4,
            target_seconds=100.0, min_distinct_shots=100,
            requirement_id="R01", workset_id="w1", requirement_index=ri,
        )
    assert calls == [], "shot já CONFIRMED_CORROBORATED não devia ir a Vision outra vez"
