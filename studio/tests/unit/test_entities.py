"""Fase A — testes do extractor de entidades + align_timestamps + integração S06Scenes.

5 testes obrigatórios do task spec:
  T1: Texto 'Agora chegamos à Livraria Lello.' devolve EntityMention com
      canonical=Lello + type=landmark + strict=True
  T2: Timestamps derivados do áudio batem com palavras reais dentro de ±200ms
  T3: Menção genérica ('as ruas do Porto') NÃO vira entity strict
  T4: Mock mode determinístico (sem API externa)
  T5: Cenas existentes sem entity_spans continuam funcionando (backward-compat)
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest


def _settings_mock(mock_mode: bool = True,
                  shots_root: Path | None = None) -> MagicMock:
    s = MagicMock()
    s.mock_mode = mock_mode
    s.prompts_root = MagicMock()
    # prompts_root / "script" / "{name}.v1.md" tem de resolver para um
    # ficheiro real (mesmo que não usado, evita erros iniciais)
    if shots_root is not None:
        s.library_root = shots_root
    return s


def _words_list(*entries: tuple[str, float, float]) -> list[dict]:
    return [{"word": w, "start": t_in, "end": t_out} for w, t_in, t_out in entries]


# ─────────────────────── T1: Livraria Lello yields mention landmark strict ───

def test_livraria_lello_yields_landmark_strict():
    """Texto fala Livraria Lello explicitamente. O extractor devolve
    EntityMention com canonical_name='Livraria Lello', type='landmark',
    strict_visual=True, mention_text com o trecho literal."""
    from studio.script.entities import extract_entities

    script = (
        "Hoje, no coração da cidade, vamos descobrir o segredo mais bem "
        "guardado do Porto. Primeiro, uma paragem obrigatória: a Livraria "
        "Lello. E sim, mesmo num vídeo sobre coisas de comer."
    )

    mentions, cost = extract_entities(script, research="(mock)", settings=_settings_mock())
    assert cost == 0.0  # mock
    lello = next((m for m in mentions if "Lello" in m.canonical_name), None)
    assert lello is not None, f"Lello não extraido. Mentions: {[m.canonical_name for m in mentions]}"
    assert lello.entity_type == "landmark"
    assert lello.strict_visual is True
    assert "Livraria Lello" in lello.mention_text
    # mention_text é verbatim
    assert lello.mention_text == "Livraria Lello"
    assert 0.7 <= lello.narrative_importance <= 1.0


# ─────────────────────── T2: Timestamps aligned to words-with-tolerance ──────

def test_align_timestamps_bate_com_words_reais():
    """Para o script 'Vamos provar a Francesinha hoje.' com mock words list
    contendo (Vamos,0.0), (provar,0.5), (a,1.0), (Francesinha,1.4), (hoje,2.0)
    — align devolve EntitySpan com t_in=1.4 (start de Francesinha),
    t_out=2.0 (end de hoje), text='Francesinha hoje'."""
    from studio.script.entities import (
        EntityMention, align_timestamps,
    )

    m = EntityMention(canonical_name="Francesinha",
                      entity_type="food", mention_text="Francesinha",
                      narrative_importance=0.95, strict_visual=True)
    words = _words_list(
        ("Vamos", 0.0, 0.4), ("provar", 0.5, 0.9),
        ("a", 1.0, 1.1), ("Francesinha", 1.4, 2.0),
        ("hoje.", 2.0, 2.4),  # pontuação não impede match
    )
    spans = align_timestamps([m], words)
    assert len(spans) == 1
    s = spans[0]
    # janela EXACTA (single-token entity)
    assert abs(s.t_in - 1.4) < 0.001
    assert abs(s.t_out - 2.0) < 0.001
    assert f"Francesinha" in s.text
    assert s.entity_id.startswith("francesinha:")
    # mention_text multi-token ainda funciona: 'a Francesinha'
    m2 = EntityMention(canonical_name="Francesinha", entity_type="food",
                       mention_text="a Francesinha", narrative_importance=0.95,
                       strict_visual=True)
    s2 = align_timestamps([m2], words)
    assert len(s2) == 1
    assert abs(s2[0].t_in - 1.0) < 0.001  # 'a' começa em 1.0
    assert abs(s2[0].t_out - 2.0) < 0.001
    assert "a Francesinha" in s2[0].text


# ─────────────────────── T3: entity non-strict não vira anchor ───────────────

def test_cidade_generica_não_vira_strict_anchor():
    """Quando o tema é '5 coisas para fazer em Lisboa', menções de 'Lisboa'
    no script NÃO devem virar entity strict_visual=True (é contexto
    geográfico, não anchor visual)."""
    from studio.script.entities import extract_entities

    script = (
        "Hoje vamos explorar cinco segredos de Lisboa. Lisboa é uma cidade "
        "com história. Em cada esquina de Lisboa há algo para descobrir."
    )
    mentions, _ = extract_entities(script, research="(mock)", settings=_settings_mock())
    bsbs = [m for m in mentions if m.canonical_name == "Lisboa"]
    assert bsbs, "Lisboa deveria ter pelo menos uma mention"
    for m in bsbs:
        # contexto geográfico não é anchor visual (a cena só de cidade gera
        # B-roll genérico, não precisa de footage Lisboa-tagged-específico)
        assert m.strict_visual is False, \
            f"Lisboa não devia ser strict_visual (é contexto, não entity): {m.model_dump()}"
        assert m.entity_type == "place"


# ─────────────────────── T4: mock_mode determinístico (sem API) ──────────────

def test_mock_mode_no_api_calls():
    """mock_mode=True ⇒ 0 chamadas a LLM, lista determinística baseada em
    regras PT-PT."""
    from studio.script.entities import extract_entities

    script = "No Porto, prove a Francesinha. Visite a Livraria Lello. Vá aos Pastéis de Belém."
    # script não é empty; settings.mock_mode=True
    m1, c1 = extract_entities(script, research="(mock)", settings=_settings_mock())
    m2, c2 = extract_entities(script, research="(mock)", settings=_settings_mock())
    assert c1 == 0.0 == c2
    # Determinism: mesmos inputs ⇒ mesmo output
    assert [x.canonical_name for x in m1] == [x.canonical_name for x in m2]
    # mock devolve entidades conhecidas do dicionário PT
    names = {x.canonical_name for x in m1}
    assert {"Francesinha", "Livraria Lello", "Pastéis de Belém"} <= names


# ─────────────────────── T5: backward-compat — scenes.py preserved ───────────

# ──────────── T6: alias fallback quando mention_text não bate ────────────

def test_align_timestamps_fallback_via_alias():
    """Se mention_text='Lello' mas o áudio só tem 'Livraria Lello',
    align_timestamps deve cair no alias e alinhar correctamente. Code-
    reviewer item A."""
    from studio.script.entities import (
        EntityMention, align_timestamps,
    )

    # mention_text abstracto ("Lello"), aliases=['Livraria Lello'] com espaço.
    # IMPORTANTE: aliases sem espaço (como "LivrariaLello") NÃO alinham a
    # janela de N=2 tokens porque o normalizador do _norm_phrase faz split
    # em whitespace. Alinhador PROCURA spans LITERIAS como aparecem no script.
    m = EntityMention(
        canonical_name="Livraria Lello",
        aliases=["Lello", "Livraria Lello"],
        entity_type="landmark",
        mention_text="Lello",                # abstracto (LLM escolheu)
        narrative_importance=0.95,
        strict_visual=True,
        location_context="Porto",
    )
    # Audio diz SÓ 'Livraria Lello' (a forma composta)
    words = _words_list(
        ("visitamos", 0.0, 0.3),
        ("a", 0.3, 0.4),
        ("Livraria", 0.5, 1.0),
        ("Lello", 1.0, 1.6),
        ("hoje.", 1.7, 2.0),
    )
    spans = align_timestamps([m], words)
    assert len(spans) == 1, f"sem fallback de alias — got {len(spans)}"
    s = spans[0]
    # t_in = 0.5 (Livraria), t_out = 1.6 (Lello) — sem o alias fallback,
    # 'Lello' só não casaria porque precisamos de N=2 tokens ['livraria','lello']
    assert abs(s.t_in - 0.5) < 0.001
    assert abs(s.t_out - 1.6) < 0.001
    assert "Livraria Lello" in s.text

    # Caso contrário: mention_text literal bate, é preferido
    m2 = EntityMention(
        canonical_name="Livraria Lello",
        aliases=["Lello"],
        entity_type="landmark",
        mention_text="Livraria Lello",       # verbatim
        narrative_importance=0.95,
        strict_visual=True,
    )
    spans2 = align_timestamps([m2], words)
    assert len(spans2) == 1
    # mesmo match (verbatim ganha, alias não tenta)
    assert abs(spans2[0].t_in - 0.5) < 0.001
    assert abs(spans2[0].t_out - 1.6) < 0.001


# ──────── T7: align drop silencioso de mentions sem texto válido ──────────

def test_align_drops_mention_vazia_sem_log_misleading():
    """T7: menção com mention_text='' e aliases=[] deve cair no drop SEM
    tentar janela (code-reviewer item A+B). Aliases só com whitespace
    também drop. Não devem quebrar o resto do alinhamento."""
    from studio.script.entities import (
        EntityMention, align_timestamps,
    )

    mentions = [
        EntityMention(canonical_name="Francesinha", entity_type="food",
                       mention_text="", aliases=[],
                       narrative_importance=0.95, strict_visual=True),
        EntityMention(canonical_name="Torre dos Clerigos", entity_type="landmark",
                       mention_text="   ", aliases=[""],
                       narrative_importance=0.85, strict_visual=True),
        EntityMention(canonical_name="Francesinha", entity_type="food",
                       mention_text="Francesinha",
                       narrative_importance=0.95, strict_visual=True),
    ]
    words = _words_list(
        ("Vamos", 0.0, 0.4), ("provar", 0.5, 0.9),
        ("Francesinha", 1.0, 1.7),
    )
    spans = align_timestamps(mentions, words)
    # Só a 3ª menção (válida) sobrevive; (D) dedupe canônico também elimina
    # a duplicação, restando uma única span.
    assert len(spans) == 1
    assert spans[0].canonical_name == "Francesinha"
    # janela simples
    assert abs(spans[0].t_in - 1.0) < 0.001
    assert abs(spans[0].t_out - 1.7) < 0.001


# ──────── T8: align dedupe canônico entre mentions iguais ─────────────────

def test_align_dedup_canonical_com_mesma_entity():
    """T8: 2 EntityMentions com mesmo canonical_name (uma com mais importance)
    viram UMA EntitySpan (sem duplicar t_in). Code-reviewer item D."""
    from studio.script.entities import (
        EntityMention, align_timestamps,
    )

    mentions = [
        # Mesma entidade, alias curto primeiro
        EntityMention(canonical_name="Francesinha", entity_type="food",
                       aliases=["a francesinha"], mention_text="francesinha",
                       narrative_importance=0.7, strict_visual=True),
        # Mesma entidade, mention_text completo segundo (ganha — importance maior)
        EntityMention(canonical_name="Francesinha", entity_type="food",
                       aliases=[], mention_text="Francesinha",
                       narrative_importance=0.95, strict_visual=True),
    ]
    words = _words_list(
        ("Francesinha", 1.0, 1.7), ("e", 1.8, 1.9), ("Bacalhau", 2.0, 2.6),
    )
    spans = align_timestamps(mentions, words)
    # dedupe canônico → 1 span (não 2)
    assert len(spans) == 1
    assert spans[0].canonical_name == "Francesinha"
    assert abs(spans[0].t_in - 1.0) < 0.001
    assert abs(spans[0].t_out - 1.7) < 0.001


def test_scenes_py_backward_compat_sem_entity():
    """Cenas existentes (geradas pela segmentação actual) devem continuar
    funcionando intactas — Scene continua com t_in/t_out/text/beat mas
    sem strict_entity (default=False). O segmentador recebe Nada de
    entity, e produz o mesmo output de antes (cenas semanticamente
    iguais)."""
    from studio.script.scenes import segment_scenes, Scene

    script = "Primeira frase do vídeo. Segunda frase com alguma descrição. " * 3
    # palavras espaçadas uniformemente para alinhar
    words = []
    for i, w in enumerate(script.split()):
        t = 0.6 * i
        words.append({"word": w, "start": t, "end": t + 0.55})
    scenes = segment_scenes(script, words, None)

    # Scene continua a funcionar com 4 campos obrigatórios (sem entity)
    for s in scenes:
        assert isinstance(s, Scene)
        assert hasattr(s, "t_in")
        assert hasattr(s, "t_out")
        assert hasattr(s, "text")
        assert hasattr(s, "beat")
        # sem entity fields (a Fase B vai adicionar)
        assert not hasattr(s, "strict_entity") or getattr(s, "strict_entity", False) is False

    # escritas em disco round-trip (sem entity fields) — backward-compat
    out = Path("/tmp/_entities_test_scenes.json")
    out.write_text(json.dumps([s.model_dump() for s in scenes], ensure_ascii=False))
    loaded = json.loads(out.read_text())
    assert loaded[0]["text"]  # cenas escritas são legíveis pelo resto do pipeline
