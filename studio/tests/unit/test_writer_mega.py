"""Fase 2 — testes do build_mega_script (consolidação outline+draft).

Cobertura:
1. Sucesso: mega-prompt Flash devolve JSON válido com draft longo
   (>=80% de target_words) → NÃO cai em fallback.
2. Fallback JSON inválido: Flash devolve JSON partido → cai em build_outline+write_draft.
3. Fallback draft curto: Flash devolve draft com <80% de target_words → cai em fallback.
4. Schema rigidity: outline com chave extra desconhecida → Pydantic drop gracefully.
5. Visual grounding: visual_inventory passado verbatim para o prompt mega.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


def _settings() -> MagicMock:
    s = MagicMock()
    s.mock_mode = False
    s.model_flash = "gemini-1.5-flash-latest"
    s.model_pro = "gemini-1.5-pro-latest"
    s.words_per_minute = 150
    s.prompts_root = MagicMock()
    # Para _prompt(): lê prompts/script/mega_draft.v1.md.
    # Mas como vamos patchar _generate_json, podemos retornar texto fixo.
    return s


def test_build_mega_script_success_no_fallback():
    """Quando Flash devolve JSON válido + draft >= 80% target → sucesso."""
    from studio.script import writer

    # 200 palavras de draft (target_words = 2 min * 150 wpm = 300, 80% = 240)
    # ... vou usar target_words = 200 (duration=2/3 min para exactamente 300 palavras alvo... vou spoof)
    long_draft = " ".join(["palavra"] * 250)  # 250 > 240 (80% de 300)
    mega_response = {
        "outline": {
            "hook": "primeira frase do vídeo",
            "open_loops": ["loop 1"],
            "chapters": [
                {"title": "Capítulo 1", "beat": "hook",
                 "target_seconds": 90, "goal": "ganhar atenção",
                 "emotion": "curiosidade", "key_facts": ["fato 1"]},
            ],
        },
        "draft": long_draft,
    }

    with patch.object(writer, "_generate_json", return_value=(mega_response, 0.05)):
        outline, draft, cost = writer.build_mega_script(
            "Lisboa tem um segredo", "research fact 1", 2.0, _settings(),
            visual_inventory="Livraria Lello, Ribeira, Francesinha",
        )
    assert cost == 0.05
    assert isinstance(outline, writer.Outline)
    assert outline.hook == "primeira frase do vídeo"
    assert outline.chapters[0].beat == "hook"
    assert len(draft.split()) == 250


def test_build_mega_script_fallback_on_invalid_json():
    """Quando _generate_json levanta JSONDecodeError → fallback Pro."""
    from studio.script import writer

    # _generate_json lança ValueError (wrapping do JSONDecodeError).
    # Fallback chama build_outline + write_draft (cada um ~1 cost unit).
    fallback_outline = writer.Outline(
        hook="fallback hook",
        open_loops=[],
        chapters=[writer.Chapter(title="fallback", beat="hook", target_seconds=30)],
    )
    fallback_draft = "fallback draft content"

    with patch.object(writer, "_generate_json",
                      side_effect=ValueError("JSON inválido após retry")), \
         patch.object(writer, "build_outline",
                      return_value=(fallback_outline, 0.10)) as mock_outline, \
         patch.object(writer, "write_draft",
                      return_value=(fallback_draft, 0.20)) as mock_draft:
        outline, draft, cost = writer.build_mega_script(
            "tema", "research", 2.0, _settings(),
        )
    # Val: chamou ambos fallbacks
    assert mock_outline.called
    assert mock_draft.called
    assert outline.hook == "fallback hook"
    assert draft == "fallback draft content"
    # Cost agrega: mega_cost (0) + outline (0.10) + draft (0.20) = 0.30
    assert cost == pytest.approx(0.30)


def test_build_mega_script_fallback_on_short_draft():
    """Quando draft é < 80% de target_words → fallback Pro (heurístico)."""
    from studio.script import writer

    # duration=2.0 → target_words = 300 → 80% = 240 palavras.
    # Devolver draft com 100 palavras (apenas 33% — abaixo do limiar).
    short_draft = " ".join(["p"] * 100)
    mega_response = {
        "outline": {
            "hook": "h", "open_loops": [],
            "chapters": [{"title": "c", "beat": "hook",
                          "target_seconds": 30, "goal": "",
                          "emotion": "", "key_facts": []}],
        },
        "draft": short_draft,
    }
    fallback_outline = writer.Outline(
        hook="fb h", open_loops=[],
        chapters=[writer.Chapter(title="fb", beat="hook", target_seconds=30)],
    )
    fallback_draft = "fb pro fallback draft"

    with patch.object(writer, "_generate_json",
                      return_value=(mega_response, 0.05)), \
         patch.object(writer, "build_outline",
                      return_value=(fallback_outline, 0.10)), \
         patch.object(writer, "write_draft",
                      return_value=(fallback_draft, 0.20)):
        outline, draft, cost = writer.build_mega_script("t", "r", 2.0, _settings())
    assert outline.hook == "fb h"
    assert "pro fallback" in draft
    assert cost == pytest.approx(0.05 + 0.10 + 0.20)


def test_build_mega_script_pydantic_schema_graceful_fallback():
    """Quando JSON outline viola schema Pydantic → fallback Pro."""
    from studio.script import writer

    # Outline com chapter.beat inválido + chave extra desconhecida
    mega_response = {
        "outline": {
            "hook": "h", "open_loops": [],
            "chapters": [{
                "title": "bad",
                "beat": "this-is-not-a-valid-beat",
                "target_seconds": 30,
                "extra_unknown_key": "should be ignored or raise",
            }],
        },
        "draft": "x" * 300,  # tamanho OK
    }
    fallback_outline = writer.Outline(
        hook="fb h", open_loops=[],
        chapters=[writer.Chapter(title="fb", beat="hook", target_seconds=30)],
    )
    fallback_draft = "fb full content for testing fallback schema"

    with patch.object(writer, "_generate_json",
                      return_value=(mega_response, 0.05)), \
         patch.object(writer, "build_outline",
                      return_value=(fallback_outline, 0.10)), \
         patch.object(writer, "write_draft",
                      return_value=(fallback_draft, 0.20)):
        outline, draft, cost = writer.build_mega_script("t", "r", 2.0, _settings())
    # Outline recebido vem do fallback (não do mega com beat inválido).
    assert outline.hook == "fb h"
    assert "fb full content" in draft


def test_build_mega_script_visual_inventory_passed_through():
    """visual_inventory é propagado ao prompt como placeholder."""
    from studio.script import writer
    import json as json_mod

    target_vi = "Livraria Lello, Francesinha, Ribeira"  # 3 entidades Porto

    mega_response = {
        "outline": {"hook": "h", "open_loops": [],
                    "chapters": [{"title": "c", "beat": "hook",
                                  "target_seconds": 30, "goal": "",
                                  "emotion": "", "key_facts": []}]},
        "draft": " ".join(["x"] * 250),
    }
    captured_kwargs: dict = {}

    def fake_generate_json(prompt, settings, *, model, tag, temperature):
        captured_kwargs["prompt"] = prompt
        return mega_response, 0.0

    with patch.object(writer, "_generate_json",
                      side_effect=fake_generate_json), \
         patch.object(writer, "_prompt",
                      side_effect=lambda s, name, **kw: f"PROMPT[{name}] " + json_mod.dumps(kw)):
        writer.build_mega_script("tema", "research fact 1", 2.0, _settings(),
                                 visual_inventory=target_vi)
    # Verifica que visual_inventory foi passado
    assert target_vi in captured_kwargs["prompt"]
    assert "PROMPT[mega_draft]" in captured_kwargs["prompt"]


def test_build_mega_script_prompt_includes_topic_research_duration():
    """Os placeholders {topic}, {research}, {duration_minutes} sao injectados
    verbatim no prompt Flash. Protege contra regressao de renomeacao
    acidental de placeholders no template markdown (cod-reviewer item D)."""
    from studio.script import writer
    import json as json_mod

    captured: dict = {}

    def fake_generate_json(prompt, settings, *, model, tag, temperature):
        captured["prompt"] = prompt
        return {
            "outline": {"hook": "h", "open_loops": [],
                        "chapters": [{"title": "c", "beat": "hook",
                                      "target_seconds": 30, "goal": "",
                                      "emotion": "", "key_facts": []}]},
            "draft": " ".join(["palavra"] * 250),
        }, 0.01

    topic = "24 horas no Porto: os maiores mitos"
    research = "ribeira, francesinha, livraria lelo"
    duration = 2.0

    sentinel_outline = writer.Outline(
        hook="s", open_loops=[],
        chapters=[writer.Chapter(title="s", beat="hook", target_seconds=30)])

    with patch.object(writer, "_generate_json",
                      side_effect=fake_generate_json), \
         patch.object(writer, "_prompt",
                      side_effect=lambda s, name, **kw:
                          f"PROMPT[{name}] " + json_mod.dumps(kw)), \
         patch.object(writer, "build_outline",
                      return_value=(sentinel_outline, 0.0)), \
         patch.object(writer, "write_draft",
                      return_value=("placeholder filler", 0.0)):
        writer.build_mega_script(topic, research, duration, _settings(),
                                 visual_inventory="Lello")
    # Placeholders injectados verbatim no prompt enviado ao Flash
    assert topic in captured["prompt"]
    assert research in captured["prompt"]
    assert str(int(duration)) in captured["prompt"] or str(duration) in captured["prompt"]


def test_mega_metrics_increment_on_success_and_fallback():
    """get_mega_metrics() reflecte success/fallback contabilizados in-process.
    code-reviewer item F2: counters cumulativos para avaliar SLO pós-deploy."""
    from studio.script import writer
    writer.reset_mega_metrics()
    s0, f0 = writer.get_mega_metrics()
    assert s0 == 0 and f0 == 0

    sentinel_outline = writer.Outline(
        hook="s", open_loops=[],
        chapters=[writer.Chapter(title="s", beat="hook", target_seconds=30)])

    # 1) Sucesso: draft longo (250 > 240)
    mega_ok = {
        "outline": {"hook": "h", "open_loops": [],
                    "chapters": [{"title": "c", "beat": "hook",
                                  "target_seconds": 30, "goal": "",
                                  "emotion": "", "key_facts": []}]},
        "draft": " ".join(["p"] * 250),
    }
    with patch.object(writer, "_generate_json",
                      return_value=(mega_ok, 0.01)):
        writer.build_mega_script("t", "r", 2.0, _settings())
    s1, f1 = writer.get_mega_metrics()
    assert s1 == 1 and f1 == 0

    # 2) Fallback: draft curto (100 palavras < 240 → fallback Pro)
    mega_short = {
        "outline": {"hook": "h", "open_loops": [],
                    "chapters": [{"title": "c", "beat": "hook",
                                  "target_seconds": 30, "goal": "",
                                  "emotion": "", "key_facts": []}]},
        "draft": " ".join(["p"] * 100),
    }
    with patch.object(writer, "_generate_json",
                      return_value=(mega_short, 0.01)), \
         patch.object(writer, "build_outline",
                      return_value=(sentinel_outline, 0.01)), \
         patch.object(writer, "write_draft",
                      return_value=("fb draft filler", 0.01)):
        writer.build_mega_script("t", "r", 2.0, _settings())
    s2, f2 = writer.get_mega_metrics()
    assert s2 == 1 and f2 == 1
    writer.reset_mega_metrics()
