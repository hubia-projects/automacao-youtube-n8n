"""Regressão item 11: whisper_model usado como model_id do cache SigLIP.

`ingest.py` passava `model_id=settings.whisper_model` (nome do modelo
Whisper/ASR, ex.: "base") para `embedder.embed_text()` — poluía a chave de
cache de embeddings de TEXTO do SigLIP com um valor sem relação ao modelo
de embedding real. Correcto: não passar model_id (deixa embed_text usar o
seu próprio default, `embed.MODEL_ID`).
"""
from __future__ import annotations

from unittest.mock import patch

from studio.library.db import LibraryDB
from studio.library.ingest import ingest_file


def test_ingest_file_nao_passa_whisper_model_como_siglip_model_id(
    settings, fake_embedder, _seeded_media_file,
):
    settings.whisper_model = "large-v3-turbo"  # valor propositalmente "óbvio"
    db = LibraryDB(settings.library_root)
    captured_kwargs = []
    real_embed_text = fake_embedder.embed_text

    def spy(text_en, **kwargs):
        captured_kwargs.append(kwargs)
        return real_embed_text(text_en, **kwargs)

    with patch.object(fake_embedder, "embed_text", side_effect=spy):
        ingest_file(
            _seeded_media_file,
            {"source": "owned", "source_url": "", "license": "owned"},
            db, settings, fake_embedder,
            requirement_prompts={"Livraria Lello": "old bookstore interior"},
        )

    text_embed_calls = [kw for kw in captured_kwargs if "requirement_id" in kw]
    assert text_embed_calls, "embed_text não foi chamado para requirement_prompts"
    for kw in text_embed_calls:
        assert kw.get("model_id") in (None,), (
            f"model_id não devia vir de settings.whisper_model: {kw}"
        )
        assert "large-v3-turbo" != kw.get("model_id")
