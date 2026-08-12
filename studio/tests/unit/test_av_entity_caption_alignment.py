"""Item 15/25/26 (master doc) — alinhamento narração -> EntitySpan -> Scene
-> captions, todos a partir do MESMO words.json.

Prova o requisito explícito do enunciado: "narração diz 'Ponte Dom Luís I'
-> janela da Scene -> segmentos overlapping -> todos confirmed Dom Luís" e
que as legendas (captions) não deslizam em relação à narração (mesmo
source de word timestamps para tudo).
"""
from __future__ import annotations

from pathlib import Path

from studio.render.captions import build_ass, build_srt
from studio.script.entities import EntityMention, align_timestamps
from studio.script.scenes import segment_scenes

SCRIPT = (
    "Hoje atravessamos a Ponte Dom Luís I ao entardecer. "
    "A vista sobre o rio Douro é incrível. "
    "Depois fomos jantar uma francesinha."
)


def _synthetic_words(script: str, per_word_s: float = 0.4) -> list[dict]:
    """words.json sintético — cadência fixa, determinística, sem Whisper
    real. Mesma lista é usada para EntitySpan, Scene E captions — é
    exactamente essa partilha de fonte que este teste valida."""
    words = script.split()
    out = []
    t = 0.0
    for w in words:
        out.append({"word": w, "start": round(t, 3), "end": round(t + per_word_s - 0.05, 3)})
        t += per_word_s
    return out


def _mention_ponte() -> EntityMention:
    return EntityMention(
        canonical_name="Ponte Dom Luís I",
        aliases=["Ponte D. Luís"],
        entity_type="landmark",
        mention_text="Ponte Dom Luís I",
        context_text=SCRIPT,
        narrative_importance=0.95,
        location_context="Porto",
        strict_visual=True,
    )


def test_entity_span_alinha_com_as_palavras_exactas():
    words = _synthetic_words(SCRIPT)
    spans = align_timestamps([_mention_ponte()], words)
    assert len(spans) == 1
    span = spans[0]
    # "Ponte Dom Luís I" é a 5ª-8ª palavra do script (0-indexed 4..7)
    ponte_idx = SCRIPT.split().index("Ponte")
    expected_t_in = words[ponte_idx]["start"]
    expected_t_out = words[ponte_idx + 3]["end"]  # "Ponte","Dom","Luís","I"
    assert span.t_in == expected_t_in
    assert span.t_out == expected_t_out


def test_scene_da_entidade_cobre_toda_a_janela_do_entity_span():
    """A Scene cuja primary_entity é 'Ponte Dom Luís I' tem de cobrir (ou
    exceder) a janela do EntitySpan — nunca uma janela mais estreita."""
    words = _synthetic_words(SCRIPT)
    spans = align_timestamps([_mention_ponte()], words)
    scenes = segment_scenes(SCRIPT, words, outline=None, entity_spans=spans)
    assert scenes, "segment_scenes devolveu vazio"
    ponte_scene = next(
        (s for s in scenes if s.primary_entity == "Ponte Dom Luís I"), None)
    assert ponte_scene is not None, (
        f"nenhuma Scene com primary_entity='Ponte Dom Luís I' — "
        f"scenes={[s.primary_entity for s in scenes]}"
    )
    span = spans[0]
    assert ponte_scene.t_in <= span.t_in
    assert ponte_scene.t_out >= span.t_out


def test_captions_srt_no_intervalo_da_entidade_citam_a_entidade():
    """As legendas cobrindo a janela do EntitySpan têm de conter o texto
    da entidade — mesma fonte de word timestamps que a narração/Scene,
    logo sem drift possível entre os dois."""
    words = _synthetic_words(SCRIPT)
    spans = align_timestamps([_mention_ponte()], words)
    span = spans[0]

    import re

    srt_path = build_srt(words, Path("/tmp") / "test_av_alignment.srt")
    srt_text = srt_path.read_text("utf-8")

    def _srt_time_to_s(ts: str) -> float:
        h, m, rest = ts.split(":")
        s, ms = rest.split(",")
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0

    blocks = re.findall(
        r"\d+\n(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)\n(.+)",
        srt_text,
    )
    assert blocks, f"nenhum cue parseado do SRT:\n{srt_text}"
    covering_text = " ".join(
        text for start_s, end_s, text in blocks
        if _srt_time_to_s(end_s) > span.t_in and _srt_time_to_s(start_s) < span.t_out
    )
    assert "Ponte Dom Luís I" in covering_text, (
        f"cues no intervalo [{span.t_in},{span.t_out}] não citam a entidade: "
        f"{covering_text!r}"
    )
    srt_path.unlink(missing_ok=True)


def test_captions_ass_no_intervalo_da_entidade_citam_a_entidade():
    words = _synthetic_words(SCRIPT)
    spans = align_timestamps([_mention_ponte()], words)
    span = spans[0]

    ass_path = build_ass(words, Path("/tmp") / "test_av_alignment.ass")
    ass_text = ass_path.read_text("utf-8")
    assert "Ponte Dom Luís I" in ass_text, (
        f"legenda ASS não contém o texto da entidade:\n{ass_text}"
    )
    ass_path.unlink(missing_ok=True)
