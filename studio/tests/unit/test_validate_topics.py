"""Testes validate_topics.py (item 3 — T1/T2 do enunciado).

T1: mandatory topics são preservados no script (deteção positiva).
T2: script pode citar entity ausente na biblioteca (não testado aqui
diretamente — ver test_writer_mega.py + comentário em produce.py: a
biblioteca nunca entra nesta função, só o texto do script é inspecionado).
"""
from __future__ import annotations

from studio.script.validate_topics import find_missing_topics, is_topic_present


def test_topico_exato_presente():
    text = "Hoje vamos visitar a Livraria Lello, uma das mais bonitas do mundo."
    assert is_topic_present(text, "Livraria Lello") is True


def test_topico_com_acentuacao_diferente_presente():
    text = "Atravessamos a Ponte Dom Luis, uma obra do seculo XIX."
    assert is_topic_present(text, "Ponte Dom Luís I") is True  # sem "I" mas conteúdo bate


def test_topico_ausente():
    text = "Comemos uma francesinha deliciosa no centro do Porto."
    assert is_topic_present(text, "Bacalhau com natas") is False


def test_topico_case_insensitive():
    text = "A CAPELA DAS ALMAS tem azulejos incríveis."
    assert is_topic_present(text, "Capela das Almas") is True


def test_find_missing_topics_preserva_ordem():
    text = "Visitamos a Livraria Lello e comemos uma Francesinha."
    mandatory = ["Livraria Lello", "Ponte Dom Luís I", "Francesinha", "Pastel de nata"]
    missing = find_missing_topics(text, mandatory)
    assert missing == ["Ponte Dom Luís I", "Pastel de nata"]


def test_find_missing_topics_lista_vazia_sem_mandatory():
    assert find_missing_topics("qualquer texto", []) == []


def test_find_missing_topics_todos_presentes():
    text = "Sé do Porto, Ponte Dom Luís I e Livraria Lello, tudo num só dia."
    mandatory = ["Sé do Porto", "Ponte Dom Luís I", "Livraria Lello"]
    assert find_missing_topics(text, mandatory) == []
