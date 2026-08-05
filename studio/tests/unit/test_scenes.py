from studio.script.scenes import segment_scenes
from studio.script.writer import Chapter, Outline


def _words_for(text: str, per_word: float = 0.4, pause_every: int = 12,
               pause: float = 0.5) -> list[dict]:
    """Timing sintético com pausas periódicas (simula respiração)."""
    out, t = [], 0.0
    for i, w in enumerate(text.split()):
        if i and i % pause_every == 0:
            t += pause
        out.append({"word": w, "start": round(t, 3), "end": round(t + per_word, 3)})
        t += per_word
    return out


TEXT = (
    "Primeira frase do vídeo com gancho forte. Segunda frase que desenvolve a ideia. "
    "Terceira frase com mais contexto histórico. Quarta frase que planta uma promessa. "
    "Quinta frase sobre a receita secreta. Sexta frase sobre os monges do mosteiro. "
    "Sétima frase sobre o erro dos turistas. Oitava frase sobre o preço de um euro. "
    "Nona frase a caminho do final. Décima frase com o payoff prometido."
)


def test_cenas_cobrem_o_texto_sem_buracos():
    words = _words_for(TEXT)
    scenes = segment_scenes(TEXT, words)
    assert scenes, "devia haver cenas"
    # ordenadas, sem sobreposição, dentro da duração
    for a, b in zip(scenes, scenes[1:]):
        assert a.t_out <= b.t_in + 0.001
    assert scenes[0].t_in == words[0]["start"]
    assert abs(scenes[-1].t_out - words[-1]["end"]) < 0.001
    # todo o texto preservado
    assert " ".join(s.text for s in scenes).split() == TEXT.split()


def test_duracao_de_cena_dentro_das_bandas():
    scenes = segment_scenes(TEXT, _words_for(TEXT))
    for s in scenes[:-1]:  # última pode ser curta
        assert (s.t_out - s.t_in) <= 18.0 + 0.5


def test_beat_herdado_do_outline():
    outline = Outline(hook="h", chapters=[
        Chapter(title="a", beat="hook", target_seconds=10),
        Chapter(title="b", beat="detail", target_seconds=20),
        Chapter(title="c", beat="payoff", target_seconds=10),
    ])
    scenes = segment_scenes(TEXT, _words_for(TEXT), outline)
    assert scenes[0].beat == "hook"
    assert scenes[-1].beat == "payoff"
