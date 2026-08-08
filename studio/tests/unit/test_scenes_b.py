"""Testes Fase B — Scene segmentation entity-aware + VisualBrief anchored.

OBJECTIVO: garantir que quando o roteiro cita explicitamente uma entidade
visual (Livraria Lello, Francesinha) e os entity_spans têm t_in/t_out
correspondentes, a Scene herda primary_entity E que mudança de entity
strict FECHA cena mesmo sem pausa suficiente no áudio.

Cobertura:
T9  — entity_span 00:40–00:50 Livraria Lello + 00:50–01:00 Francesinha →
      2 cenas separadas (não 1 cena monolítica).
T10 — cena SEM entity_spans → comportamento legacy preservado
      (entity fields com defaults vazios, não quebra nada).
T11 — VisualBrief de cena com primary_entity="Francesinha" mantém
      required_entity="Francesinha" (Gemini mock não pode sobrescrever
      o anchor determinístico).
T12 — Francesinha classificada como entity_type food (não landmark).
T13 — entity_aliases da Scene propagam para o VisualBrief.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

# path bootstrap — testes correm a partir da raiz do repo
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from studio.config import Settings
from studio.script.entities import EntitySpan
from studio.script.scenes import Scene, segment_scenes
from studio.script.writer import Chapter, Outline
from studio.matching.briefs import VisualBrief, build_briefs


def _words(w: list[tuple[float, float, str]]) -> list[dict]:
    """Helper: palavras alinhadas em ((start, end, "word"))."""
    return [{"start": s, "end": e, "word": l} for s, e, l in w]


# ----------------- T9 -----------------
class TestEntitySplitScene(unittest.TestCase):
    """Mudança de entity strict FECHA cena mesmo sem pausa suficiente."""

    def test_entity_strict_splits_scene(self):
        # sem grandes pausas (gap de 0.1s entre frases), mas com 2 entities
        # strict diferentes → esperamos 2 cenas separadas.
        words = _words([
            (40.0, 40.4, "A"), (40.4, 40.9, "Livraria"), (40.9, 41.3, "Lello"),
            (41.3, 41.7, "abre"), (41.7, 42.0, "as"), (42.0, 42.5, "portas"),
            (42.5, 42.9, "no"), (42.9, 43.5, "número"),
            (43.5, 44.0, "doze."),
            (44.1, 44.6, "Agora"), (44.6, 45.0, "é"), (45.0, 45.5, "a"),
            (45.5, 46.1, "Francesinha."),
            (46.2, 46.7, "O"), (46.7, 47.2, "sabor"),
            (47.2, 47.7, "intenso"),
        ])
        script = ("A Livraria Lello abre as portas no número doze. "
                  "Agora é a Francesinha. O sabor intenso")
        entity_spans = [
            EntitySpan(entity_id="livraria_lello",
                       canonical_name="Livraria Lello",
                       entity_type="landmark",
                       t_in=40.0, t_out=43.5,
                       text="A Livraria Lello abre as portas no número doze.",
                       aliases=["Lello"],
                       importance=0.95,
                       strict_visual=True,
                       location_context="Porto"),
            EntitySpan(entity_id="francesinha",
                       canonical_name="Francesinha",
                       entity_type="food",
                       t_in=44.1, t_out=47.7,
                       text="Agora é a Francesinha. O sabor intenso",
                       aliases=[],
                       importance=0.95,
                       strict_visual=True,
                       location_context="Porto"),
        ]

        scenes = segment_scenes(script, words, outline=None,
                                entity_spans=entity_spans)

        # 2 cenas strict, não 1 monolítica
        self.assertEqual(len(scenes), 2,
                         msg=f"esperava 2 cenas, recebi {len(scenes)}: "
                             f"{[(s.scene_id, s.primary_entity) for s in scenes]}")

        s0, s1 = scenes[0], scenes[1]
        # cena 0 = Livraria Lello
        self.assertEqual(s0.primary_entity, "Livraria Lello")
        self.assertEqual(s0.primary_entity_type, "landmark")
        self.assertTrue(s0.strict_entity)
        # cena 1 = Francesinha (mudou mesmo sem pausa)
        self.assertEqual(s1.primary_entity, "Francesinha")
        self.assertEqual(s1.primary_entity_type, "food")
        self.assertTrue(s1.strict_entity)


# ----------------- T10 -----------------
class TestLegacyNoEntity(unittest.TestCase):
    """Cena sem entity_spans → comportamento legacy, defaults vazios."""

    def test_legacy(self):
        words = _words([
            (0.0, 0.3, "O"), (0.3, 0.6, "Porto"), (0.6, 1.0, "acorda"),
            (1.0, 1.5, "cedo"), (1.5, 1.9, "e"), (1.9, 2.4, "as"),
            (2.4, 3.0, "ruas"),
            (8.0, 8.4, "ganham"), (8.4, 8.9, "movimento"), (8.9, 9.4, "pela"),
            (9.4, 9.8, "manhã"), (9.8, 10.2, "tranquila"),
        ])
        script = ("O Porto acorda cedo e as ruas. "
                  "ganham movimento pela manhã tranquila")
        outline = Outline(hook="O Porto acorda cedo.", chapters=[
            Chapter(title="Hook", beat="hook", target_seconds=3.0),
            Chapter(title="Detail", beat="detail", target_seconds=10.0),
        ])

        # SEM entity_spans → legacy
        scenes = segment_scenes(script, words, outline, entity_spans=None)

        self.assertGreater(len(scenes), 0)
        # campos novos vazios / False (defaults retro-compat)
        for s in scenes:
            self.assertEqual(s.primary_entity, "")
            self.assertEqual(s.primary_entity_type, "")
            self.assertEqual(s.entity_aliases, [])
            self.assertEqual(s.entity_importance, 0.0)
            self.assertFalse(s.strict_entity)
            self.assertEqual(s.location_context, "")


# ----------------- T11 -----------------
class TestBriefAnchorPreserved(unittest.TestCase):
    """VisualBrief NÃO pode sobrescrever o anchor da Scene."""

    def test_anchor_cannot_be_overridden_by_mock(self):
        settings = Settings(mock_mode=True)
        scene = Scene(
            scene_id="s000", t_in=0.0, t_out=5.0, beat="detail",
            text="A Francesinha",
            primary_entity="Francesinha",
            primary_entity_type="food",
            entity_aliases=["Francesinhas", "sandes do Porto"],
            entity_importance=0.95,
            strict_entity=True,
            location_context="Porto",
        )
        briefs, _ = build_briefs([scene], settings)
        b = briefs[0]
        self.assertEqual(b.required_entity, "Francesinha",
                         "anchor determinístico foi sobrescrito")
        self.assertTrue(b.strict_entity)
        self.assertEqual(b.required_entity_type, "food")


# ----------------- T12 -----------------
class TestFrancesinhaIsFood(unittest.TestCase):
    """type="food" para Francesinha (não landmark/other_visual)."""

    def test_francesinha_type(self):
        settings = Settings(mock_mode=True)
        scene = Scene(
            scene_id="s000", t_in=0.0, t_out=5.0, beat="detail",
            text="A Francesinha é o prato ícone do Porto.",
            primary_entity="Francesinha",
            primary_entity_type="food",
            strict_entity=True,
            entity_importance=0.98,
        )
        briefs, _ = build_briefs([scene], settings)
        b = briefs[0]
        self.assertEqual(b.required_entity_type, "food")


# ----------------- T13 -----------------
class TestEntityAliasesPropagate(unittest.TestCase):
    """entity_aliases da Scene devem propagar para VisualBrief."""

    def test_aliases(self):
        settings = Settings(mock_mode=True)
        scene = Scene(
            scene_id="s000", t_in=0.0, t_out=5.0, beat="detail",
            text="A Livraria Lello",
            primary_entity="Livraria Lello",
            primary_entity_type="landmark",
            entity_aliases=["Lello", "Livraria Chardron"],
            strict_entity=True,
            entity_importance=0.92,
        )
        briefs, _ = build_briefs([scene], settings)
        b = briefs[0]
        self.assertIn("Lello", b.required_entity_aliases)
        self.assertIn("Livraria Chardron", b.required_entity_aliases)


# ----------------- extra: cena SEM entity + B-roll genérico -----------------
class TestBrollGenericFallback(unittest.TestCase):
    """Cena sem primary_entity → VisualBrief em modo genérico (B-roll)."""

    def test_generic_fallback_keeps_legacy(self):
        s = Settings(mock_mode=True)
        scene = Scene(
            scene_id="s000", t_in=0.0, t_out=5.0, beat="detail",
            text="O Porto acorda cedo.",
            # sem entity explícita → B-roll genérico
        )
        briefs, _ = build_briefs([scene], s)
        b = briefs[0]
        self.assertEqual(b.required_entity, "")
        self.assertFalse(b.strict_entity)
        # deve continuar procurando footage genérica do Porto
        self.assertIn("Porto", b.visual_subject_en)


if __name__ == "__main__":
    unittest.main()
