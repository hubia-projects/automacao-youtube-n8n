from studio.script.lint import lint, normalize_for_tts

BOM = (
    "Existe um pastel com segredo de duzentos anos. Em Lisboa, monges criaram "
    "uma receita única. Curto. E agora uma frase bem mais longa que desenvolve a "
    "ideia com calma e contexto histórico real. Você consegue prová-lo por um euro."
)


def test_texto_bom_passa():
    report = lint(BOM)
    assert report.ok
    assert report.stats["words"] > 20


def test_frase_banida_bloqueia():
    report = lint(BOM + " Vamos mergulhar nesse mundo!")
    assert not report.ok
    assert any("vamos mergulhar" in e for e in report.errors)


def test_markdown_bloqueia():
    assert not lint("# Título\n" + BOM).ok
    assert not lint(BOM + "\n- item de lista").ok


def test_hype_em_excesso_bloqueia():
    hyped = BOM + " Incrível! Um lugar incrível com vista incrível e comida incrível."
    assert not lint(hyped).ok


def test_min_words():
    assert not lint("Curto demais.", min_words=100).ok


def test_normalize_para_tts():
    out = normalize_for_tts('Um texto — com travessão e "aspas curvas".')
    assert "—" not in out and '"' not in out
