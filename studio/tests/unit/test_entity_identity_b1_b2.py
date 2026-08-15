"""PORTO FINAL ASSET TEST — regressão dos bugs B1 (entity_type sintético
hardcoded "place") e B2 (canonical PT vs classifier EN — identidade
canónica partilhada em text_match.py)."""
from __future__ import annotations

from studio.library.text_match import (
    build_candidate_where_clause,
    candidate_match_names,
    candidate_matches_entity,
    csv_columns_for_entity_type,
    is_specific_alias,
    normalize_text,
    rank_by_hints,
    rank_score_for_hints,
)


# === B2: identidade canónica / matching ======================================

def test_normalize_text_remove_acentos_e_normaliza_espacos():
    assert normalize_text("Sé do Porto") == "se do porto"
    assert normalize_text("SE   DO   PORTO!!") == "se do porto"
    assert normalize_text("Porto   Cathedral") == "porto cathedral"


def test_is_specific_alias_exige_2_palavras():
    assert is_specific_alias("Porto Cathedral") is True
    assert is_specific_alias("Cathedral") is False
    assert is_specific_alias("Cod") is False
    assert is_specific_alias("Cod with Cream") is True


def test_candidate_match_names_filtra_alias_generico_de_1_palavra():
    names = candidate_match_names(
        "Bacalhau com natas", aliases=(), aliases_en=("Cod", "Cod with Cream"),
    )
    assert "Cod" not in names
    assert "Cod with Cream" in names
    assert "Bacalhau com natas" in names  # canonical sempre entra


def test_b2_porto_cathedral_bate_se_do_porto_via_alias_en():
    """Caso real confirmado em produção: foto correcta da Sé do Porto
    ingerida com landmarks_csv="porto cathedral,..." — sem alias_en, a
    comparação literal contra "sé do porto" nunca encontrava esta foto."""
    assert candidate_matches_entity(
        "porto cathedral,dom luís i bridge,douro river",
        "Sé do Porto", aliases_en=("Porto Cathedral",),
    ) is True


def test_b2_viseu_cathedral_nao_bate_se_do_porto():
    """Guarda de falso-positivo explícita (secção 13 do pedido): mesmo com
    alias_en "Porto Cathedral" definido, uma catedral DIFERENTE (Viseu)
    nunca deve corresponder — "cathedral" sozinho nunca é um alias válido."""
    assert candidate_matches_entity(
        "viseu cathedral", "Sé do Porto", aliases_en=("Porto Cathedral",),
    ) is False


def test_b2_sao_bento_station_bate_estacao_de_sao_bento():
    assert candidate_matches_entity(
        "sao bento railway station platform",
        "Estação de São Bento",
        aliases_en=("São Bento Station", "São Bento railway station"),
    ) is True


def test_b2_sem_aliases_en_canonical_pt_nao_bate_label_en():
    """Sem aliases_en (regressão do estado ANTES do fix), o mismatch
    original persiste — prova que o alias_en é o que resolve o bug, não
    normalização sozinha."""
    assert candidate_matches_entity(
        "porto cathedral", "Sé do Porto",
    ) is False


def test_b2_food_generic_alias_nao_cria_falso_positivo():
    """secção 14: alias genérico tipo "cod" sozinho nunca deve ser
    suficiente para confirmar "Bacalhau com natas" — usar só o alias
    específico "Cod with Cream"."""
    # "cod" sozinho nunca é usado como nome de match (filtrado por
    # is_specific_alias), logo um shot genérico de bacalhau simples não
    # corresponde ao requirement específico "bacalhau com natas":
    assert candidate_matches_entity(
        "cod fillet grilled", "Bacalhau com natas",
        aliases_en=("Cod",),  # alias de 1 palavra — deve ser ignorado
    ) is False
    assert candidate_matches_entity(
        "cod with cream sauce", "Bacalhau com natas",
        aliases_en=("Cod with Cream",),
    ) is True


def test_csv_columns_for_entity_type_food_isolado():
    assert csv_columns_for_entity_type("food") == ["food_csv"]
    assert csv_columns_for_entity_type("dish") == ["food_csv"]


def test_csv_columns_for_entity_type_location_types_unificam_landmarks_e_places():
    """bug B1 side-effect: fronteira place/landmark/building/attraction é
    inconsistente a montante — pesquisar as duas colunas em vez de confiar
    num único mapeamento exacto evita perder candidatos por type errado."""
    for et in ("place", "landmark", "building", "attraction"):
        assert csv_columns_for_entity_type(et) == ["landmarks_csv", "places_csv"]


def test_build_candidate_where_clause_sem_nomes_usaveis_fail_closed():
    assert build_candidate_where_clause("place", "") == "1=0"


def test_build_candidate_where_clause_inclui_aliases_en():
    where = build_candidate_where_clause(
        "landmark", "Sé do Porto", aliases_en=("Porto Cathedral",),
    )
    assert "landmarks_csv LIKE '%porto cathedral%'" in where
    assert "places_csv LIKE '%porto cathedral%'" in where


# === PORTO FINAL RETRIEVAL FIX (secções 16-17): ranking por frase =========

def test_rank_score_zero_sem_hints_ou_texto():
    assert rank_score_for_hints("qualquer coisa", ()) == 0.0
    assert rank_score_for_hints("", ("Sé do Porto",)) == 0.0


def test_rank_score_frase_completa_supera_overlap_de_palavras():
    """"Sé do Porto"/"Porto Cathedral" são só palavras genéricas — um
    ranking por overlap de palavras fica sem sinal; por FRASE COMPLETA
    continua a distinguir Porto de Viseu."""
    hints = ("Sé do Porto", "Porto Cathedral")
    score_correct = rank_score_for_hints("Porto Cathedral aerial view", hints)
    score_wrong = rank_score_for_hints("Viseu Cathedral facade", hints)
    assert score_correct > score_wrong
    assert score_correct >= 8.0  # bateu a frase completa do alias


def test_rank_by_hints_ordena_estavel_sem_hints():
    items = ["a", "b", "c"]
    assert rank_by_hints(items, (), lambda x: x) == items


def test_rank_by_hints_ordena_candidato_certo_primeiro():
    items = ["Viseu Cathedral facade", "generic bridge photo", "Porto Cathedral aerial"]
    ranked = rank_by_hints(items, ("Sé do Porto", "Porto Cathedral"), lambda x: x)
    assert ranked[0] == "Porto Cathedral aerial"
