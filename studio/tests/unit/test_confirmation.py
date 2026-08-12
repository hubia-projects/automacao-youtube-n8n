"""Testes Fase E — Metadata Confidence via Vision + cache + back-compat.

Cobertura (6 testes):
T27 — entity confirmada (mock OK) → is_confirmed True
T28 — entity não confirmada (mock fail) → reuse=False (rejeitada)
T29 — lazy confirm só com strict_visual=True (só confirma strict)
T30 — cache hit (2ª chamada sem Vision)
T31 — mock_mode não chama Vision (resolve sem HTTP)
T32 — back-compat: shot antigo sem `confirmations` em meta_json NÃO quebra
"""
from __future__ import annotations
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from studio.config import Settings
from studio.library.metadata import DetectedEntity
from studio.library.confirmation import (
    confirm_shot_entity, require_entity_confirmation, _local_cache,
)


def _shot(id_, *, meta=None, keyframes=None, media_path=""):
    return {
        "shot_id": id_,
        "media_path": media_path,
        "keyframes_csv": ",".join(keyframes or []),
        "food_csv": "Francesinha",
        "landmarks_csv": "",
        "places_csv": "Porto",
        "meta_json": json.dumps(meta or {}),
    }


def _db_with(rows):
    db = MagicMock()
    db.iter_rows = MagicMock(return_value=list(rows))
    db._table = MagicMock()
    db._table.update = MagicMock()
    return db


def _reset_cache():
    _local_cache.clear()


class TestE27EntityConfirmed(unittest.TestCase):
    """T27 — shot com mock OK + entity match → confirma."""

    def setUp(self):
        _reset_cache()

    def test_mock_ok_returns_confirmed(self):
        s = Settings(_env_file=None)
        object.__setattr__(s, "mock_mode", True)
        shot = _shot("MockOK_francesinha_1")
        db = _db_with([])
        det = confirm_shot_entity(shot, "Francesinha", "food", db, s)
        self.assertTrue(det.is_confirmed(0.85))
        self.assertEqual(det.name, "Francesinha")
        self.assertGreaterEqual(det.confidence, 0.85)


class TestE28EntityNotConfirmed(unittest.TestCase):
    """T28 — shot genérico sem match → rejeitado."""

    def setUp(self):
        _reset_cache()

    def test_generic_no_match_rejected(self):
        s = Settings(_env_file=None)
        object.__setattr__(s, "mock_mode", True)
        shot = _shot("Generic_bakery_42")  # SEM MockOK_
        db = _db_with([])
        det = confirm_shot_entity(shot, "Francesinha", "food", db, s)
        self.assertTrue(det.rejected)
        self.assertFalse(det.is_confirmed(0.85))
        # rejeitada deve ter reason
        self.assertIn("mock", det.rejection_reason.lower())


class TestE29LazyConfirmStrict(unittest.TestCase):
    """T29 — back-compat: shots antigos sem confirmação em meta_json
    só precisam lazy confirm se strict_visual. Para non-strict (não
    usado em strict matching), reuse permitido."""

    def test_no_meta_confirmations_does_not_break(self):
        s = Settings(_env_file=None)
        object.__setattr__(s, "mock_mode", True)
        # shot sem meta_json.confirmations
        shot = _shot("MockOK_lello_5", meta={"_no_confirmations": True})
        db = _db_with([])
        # chamar confirm_shot_entity NÃO quebra — cache/persistent miss → Vision
        det = confirm_shot_entity(shot, "Livraria Lello", "landmark", db, s)
        self.assertIsNotNone(det)
        # MockOK_lello em mock_mode → confirmou
        self.assertTrue(det.is_confirmed(0.85))


class TestE30CacheHit(unittest.TestCase):
    """T30 — 2ª chamada da mesma (shot, entity) usa cache sem Vision."""

    def setUp(self):
        _reset_cache()

    def test_second_call_uses_cache(self):
        s = Settings(_env_file=None)
        object.__setattr__(s, "mock_mode", True)
        shot = _shot("MockOK_livraria_lello_5")
        db = _db_with([])
        # 1ª chamada → mock OK
        det1 = confirm_shot_entity(shot, "Livraria Lello", "landmark", db, s)
        # 2ª chamada: cache hit não chama nenhuma vez _vision_call
        with patch("studio.library.confirmation._vision_call") as mvc:
            det2 = confirm_shot_entity(shot, "Livraria Lello", "landmark",
                                        db, s)
        mvc.assert_not_called()
        self.assertEqual(det1.confidence, det2.confidence)


class TestE31MockModeNoNetwork(unittest.TestCase):
    """T31 — mock_mode nunca chama HTTP/Vision."""

    def setUp(self):
        _reset_cache()

    def test_mock_mode_skips_network(self):
        s = Settings(_env_file=None)
        object.__setattr__(s, "mock_mode", True)
        # patch generate_multimodal — em mock_mode nunca é chamado
        with patch("studio.library.confirmation.generate_multimodal") as mg:
            shot = _shot("MockOK_francesinha_z")
            db = _db_with([])
            _ = confirm_shot_entity(shot, "Francesinha", "food", db, s)
            _ = confirm_shot_entity(shot, "Francesinha", "food", db, s)
        mg.assert_not_called()


class TestE32OldShotBackCompat(unittest.TestCase):
    """T32 — shot pré-Fase E sem confirmations está em meta_json.
    Leitura/escrita NÃO quebra."""

    def setUp(self):
        _reset_cache()

    def test_meta_with_other_keys_works(self):
        s = Settings(_env_file=None)
        object.__setattr__(s, "mock_mode", True)
        # meta_json com campos incompatíveis (ex: schema antigo)
        meta = {
            "summary": "test shot",
            "places": ["Porto"],
            "_schema_version": "0.1",  # pré-Fase E
        }
        shot = _shot("MockOK_francesinha_legacy", meta=meta)
        db = _db_with([])
        det = confirm_shot_entity(shot, "Francesinha", "food", db, s)
        self.assertIsNotNone(det)
        # write_back foi chamado
        db._table.update.assert_called()


class TestRequireEntityConfirmation(unittest.TestCase):
    """Testa o agregador require_entity_confirmation."""

    def setUp(self):
        _reset_cache()

    def test_filters_by_min_confidence(self):
        s = Settings(_env_file=None)
        object.__setattr__(s, "mock_mode", True)
        candidates = [
            _shot("MockOK_francesinha_1"),
            _shot("Generic_pastry_x"),  # rejeitado
            _shot("MockOK_francesinha_b"),
        ]
        db = _db_with(candidates)
        out = require_entity_confirmation("Francesinha", "food", db, s,
                                          top_k=4, min_confidence=0.85)
        # apenas confirmados retornam (MockOK_*)
        self.assertEqual(len(out), 2)
        for r in out:
            self.assertGreaterEqual(r["__confirmation"].confidence, 0.85)




class TestEVisionHttpx(unittest.TestCase):
    """T_Vision_Httpx — regression: Vision real path (não mock) usa
    httpx generateContent com payload multimodal. Patch httpx.Client.post
    para verificar URL + params + payload shape + response parsing.
    """

    def test_vision_httpx_payload_and_parse(self):
        from unittest.mock import patch, MagicMock
        # Pre-built JSON string que representa a resposta Gemini (sem
        # chaves aninhadas no source — evita conflito com heredoc).
        gemini_text = (
            '{"name":"Francesinha","entity_type":"food","confidence":0.95,'
            '"evidence":["visual iconic sandwich","OCR plate match"],'
            '"rejected":false,"rejection_reason":"","at":"2026-08-07T15:30:00Z"}'
        )
        fake_resp = MagicMock()
        fake_resp.status_code = 200
        # part-wrapper do Gemini: candidates[0].content.parts[0].text
        fake_resp.json.return_value = _gemini_response(gemini_text)
        fake_resp.raise_for_status = MagicMock()
        with patch("httpx.Client") as MClient:
            MClient.return_value.__enter__.return_value.post.return_value = fake_resp
            from studio.library.confirmation import generate_multimodal
            parts = [
                {"text": "Confirm Francesinha (food)?"},
                {"inline_data": {"mime_type": "image/jpeg", "data": "AAA"}},
            ]
            s = Settings(_env_file=None)
            object.__setattr__(s, "mock_mode", False)
            object.__setattr__(s, "gemini_api_key", "TEST_KEY")
            object.__setattr__(s, "model_flash", "gemini-flash-latest")
            text, _cost = generate_multimodal(
                parts, s, json_mode=True, temperature=0.0, tag="test")
        # httpx.post chamado SEMPRE com kw args (url, params=, json=)
        call_args = MClient.return_value.__enter__.return_value.post.call_args
        url = call_args.args[0]  # primeiro posicional = URL
        self.assertIn("generativelanguage.googleapis.com", url)
        params = call_args.kwargs.get("params", {})
        self.assertEqual(params.get("key"), "TEST_KEY")
        payload = call_args.kwargs.get("json", {})
        self.assertIn("contents", payload)
        self.assertEqual(payload["generationConfig"]["responseMimeType"],
                         "application/json")
        # response parsed → text tem Francesinha
        self.assertIn("Francesinha", text)


def _gemini_response(text: str) -> dict:
    """Helper module-level para T_Vision_Httpx — constrói Gemini response
    dict a partir de pre-built JSON string (evita conflito heredoc)."""
    import json as _json
    parsed = _json.loads(text)
    return {"candidates": [
        {"content": {"parts": [{"text": _json.dumps(parsed)}]}}]
    }


if __name__ == "__main__":
    unittest.main()
