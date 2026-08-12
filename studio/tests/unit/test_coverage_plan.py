"""Testes Fase C — Coverage Plan + Ranking + Queries Hierárquicas.

COBERTURA (5 testes):
T15 — ranking_formula: Francesinha > Lello > Porto genérico
       (duração+freq+importance+specificity).
T16 — coverage_buffer_1_25: target_seconds = required_seconds × 1.25.
T17 — query_hierarchy_4_levels: 4 níveis em ordem (features→loc→entity→ctx).
T18 — empty_library_no_panic: biblioteca sem shots não derruba; cobertura=0;
       deficit=target — top-up é o caminho óbvio.
T19 — determinism_byte_equal: 2 runs byte-equal (sem timestamps side-effects).

Detalhe técnico: a Fase C lê `db._table.search()` directamente para contar
segundos+shots+files. Para testar sem uma library real, mockamos `_table`
com uma classe fake que devolve rows sintéticos do construtor do teste.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from studio.config import Settings
from studio.script.entities import EntitySpan
from studio.script.scenes import Scene
from studio.matching.coverage_plan import (
    EntityCoverage,
    build_coverage_plan,
    build_query_hierarchy,
    measure_coverage,
    rank_entity_importance,
    write_plan,
)


# ----------------- helpers -----------------
def _fake_table(rows: list[dict]):
    """Mock mínimo que imita o suficiente da LanceDB table para que
    `db._table.search().where(clause).limit(N).to_list()` funcione sem
    I/O real. Mantido para outros tests que ainda possam aceder
    directamente à tabela."""
    tbl = MagicMock()

    def _search():
        s = MagicMock()
        s.where = MagicMock(return_value=s)
        s.limit = MagicMock(return_value=s)
        s.to_list = MagicMock(return_value=rows)
        return s

    tbl.search = _search
    return tbl


def _fake_db(rows: list[dict] | None = None) -> MagicMock:
    """Mock que cobre a nova API pública `LibraryDB.iter_rows()` (Fase C)
    aplicando um filtro LIKE básico para se aproximar do
    comportamento real de LanceDB — necessário para que multi-entity
    testes provem o invariante "Coverage Plan evita downloads quando
    cobertura já é suficiente" (T20.2)."""
    db = MagicMock()
    db._table = _fake_table(rows or [])
    all_rows = list(rows or [])

    def iter_rows(clause, limit=20_000):
        out = []
        for r in all_rows:
            if _clause_matches(r, clause):
                out.append(r)
        return out[:limit] if limit else out

    db.iter_rows = MagicMock(side_effect=iter_rows)
    return db


def _clause_matches(row: dict, clause: str) -> bool:
    """Parser minimalista de cláusulas LanceDB WHERE. Suporta:
      - `col LIKE '%pattern%'`
      - `col1 LIKE 'a%' OR col2 LIKE 'b%'`
      - `quality >= N`
      - `revoked = false`
    Divide em partes OR; cada parte pode ter col LIKE pattern;
    row passa se QUALQUER part for match (semântica OR dos cláusulas
    reais)."""
    import re
    parts = clause.split(" OR ")
    if not parts:
        return True
    matches_any = False
    for part in parts:
        part = part.strip().strip("()")
        # LIKE patterns
        like_m = re.search(r"(\w+)\s+LIKE\s+'%([^']+)%'", part)
        if like_m:
            col = like_m.group(1)
            pat = like_m.group(2).lower()
            val = (row.get(col) or "").lower()
            if pat in val:
                matches_any = True
                continue
        # quality >= N
        q_m = re.search(r"quality\s*>=\s*(\d+)", part)
        if q_m:
            n = int(q_m.group(1))
            if int(row.get("quality", 0)) < n:
                continue
        # revoked = false
        r_m = re.search(r"revoked\s*=\s*false", part)
        if r_m:
            if row.get("revoked", False):
                continue
        # fallback: assume match (e.g., parens wrappers sem campo)
        if not like_m and not q_m and not r_m:
            matches_any = True
    return matches_any


def _span(canonical: str, et: str, t_in: float, t_out: float,
          importance: float = 0.9, strict: bool = True) -> EntitySpan:
    return EntitySpan(
        entity_id=canonical.lower().replace(" ", "_"),
        canonical_name=canonical,
        entity_type=et,
        t_in=t_in, t_out=t_out,
        text=f"...{canonical}...",
        aliases=[],
        importance=importance,
        strict_visual=strict,
        location_context="Porto",
    )


# ----------------- T15 — ranking -----------------
class TestRankingFormula(unittest.TestCase):
    def test_francesinha_above_lello_and_porto_generic(self):
        s = Settings()
        spans = [
            # Francesinha: 35s + 6 menções + importance alta (favorita)
            _span("Francesinha", "food", t_in=10, t_out=20, importance=0.95),
            _span("Francesinha", "food", t_in=40, t_out=50, importance=0.95),
            _span("Francesinha", "food", t_in=70, t_out=75, importance=0.95),
            _span("Francesinha", "food", t_in=100, t_out=110, importance=0.95),
            _span("Francesinha", "food", t_in=130, t_out=135, importance=0.95),
            _span("Francesinha", "food", t_in=155, t_out=160, importance=0.95),
            # Livraria Lello: 20s + 3 menções + importance moderada
            _span("Livraria Lello", "landmark", t_in=200, t_out=210, importance=0.85),
            _span("Livraria Lello", "landmark", t_in=230, t_out=240, importance=0.85),
            # Porto (tópico em si → baixa specificity se topic = Porto)
            _span("Porto", "place", t_in=260, t_out=270, importance=0.7),
        ]
        ranked = rank_entity_importance(
            spans, total_script_seconds=300.0, topic="24 horas no Porto")
        names = [e.canonical_name for e in ranked]
        i_fran = names.index("Francesinha")
        i_lello = names.index("Livraria Lello")
        i_porto = names.index("Porto")
        self.assertLess(i_fran, i_lello,
                         f"Francesinha deveria vir ANTES de Lello (ordem={names})")
        self.assertLess(i_lello, i_porto,
                         f"Lello deveria vir ANTES de Porto genérico (ordem={names})")

        # variance: pesos batem nas fórmulas
        fran = ranked[i_fran]
        # spans no test: 6 menções Francesinha somam 10+10+5+10+5+5 = 45s
        # (não 35s). priority = 0.45·(45/300) + 0.25·(6/6) + 0.20·0.95 + 0.10·1.0
        # = 0.0675 + 0.25 + 0.19 + 0.10 = 0.6075
        expected = round(
            0.45 * (45.0 / 300.0)
            + 0.25 * (6 / 6)
            + 0.20 * 0.95
            + 0.10 * 1.0,
            4,
        )
        self.assertAlmostEqual(fran.priority_score, expected, places=4)
        self.assertAlmostEqual(fran.priority_score, 0.6075, places=3)
        # sanity: required_seconds agrega as 6 spans (45s)
        self.assertAlmostEqual(fran.required_seconds, 45.0, places=2)


# ----------------- T16 — cobertura buffer 1.25× -----------------
class TestCoverageBuffer(unittest.TestCase):
    def test_buffer_multiplies_required_seconds(self):
        s = Settings()
        # 1 entity simples, sem cobertura — testar apenas target_seconds
        row = _span("Francesinha", "food", t_in=0, t_out=40)  # 40s
        db = _fake_db([])  # biblioteca vazia
        plan = build_coverage_plan([row], db, s, topic="24h no Porto",
                                   total_script_seconds=120.0)
        self.assertEqual(len(plan.ranked_entities), 1)
        ent = plan.ranked_entities[0]
        # target = required × 1.25 = 40 × 1.25 = 50.0
        self.assertEqual(ent.target_seconds, 50.0)
        # min_distinct_shots: ceil(50 / shots_by_duration=8) = 7
        self.assertEqual(ent.min_distinct_shots, 7)


# ----------------- T17 — query hierarchy 4 níveis -----------------
class TestQueryHierarchy(unittest.TestCase):
    def test_4_levels_in_order(self):
        q = build_query_hierarchy(
            "Livraria Lello", location="Porto", entity_type="landmark",
            features=["iconic staircase", "interior"], levels=4)
        self.assertEqual(len(q), 4)
        # 1º: entity + features + tipo
        self.assertIn("Livraria Lello", q[0])
        self.assertIn("iconic staircase", q[0])
        # 2º: entity + location
        self.assertIn("Porto", q[1])
        # 3º: entity isolada (sem city/type explícitos dominantes)
        self.assertIn("Livraria Lello", q[2])
        # 4º: contexto genérico (city + tipo, NÃO entity — cai p/ fallback)
        self.assertNotIn("Livraria Lello", q[3])

    def test_dedup_keeps_order(self):
        q1 = build_query_hierarchy("Francesinha", location="Porto",
                                    entity_type="food", levels=4,
                                    features=["close up"])
        q2 = build_query_hierarchy("Francesinha", location="Porto",
                                    entity_type="food", levels=4)
        # intersection é não-vazio mas listas não devem duplicar entries
        self.assertEqual(len(q1), len(set(q1)))
        self.assertEqual(len(q2), len(set(q2)))


# ----------------- T18 — biblioteca vazia não panica -----------------
class TestEmptyLibraryNoPanic(unittest.TestCase):
    def test_zero_shots_yields_deficit_equal_target(self):
        s = Settings()
        row = _span("Livraria Lello", "landmark", t_in=0, t_out=20)
        db = _fake_db([])  # ZERO shots na biblioteca
        plan = build_coverage_plan([row], db, s, topic="24h no Porto",
                                   total_script_seconds=120.0)
        ent = plan.ranked_entities[0]
        self.assertEqual(ent.available_seconds, 0.0)
        self.assertEqual(ent.available_distinct_shots, 0)
        self.assertEqual(ent.available_files, 0)
        # deficit = target - available = 25 - 0 = 25
        self.assertEqual(ent.deficit_seconds, 25.0)
        # nota explícita para o operador
        self.assertTrue(any("sem shots" in n for n in ent.notes),
                        f"esperava nota 'sem shots', recebi {ent.notes}")
        # queries hierárquicas SEM vazio — top-up tem onde começar
        self.assertGreaterEqual(len(ent.queries), 1)


# ----------------- T19 — determinismo byte-equality -----------------
class TestDeterminism(unittest.TestCase):
    def test_two_runs_byte_equal(self):
        s = Settings()
        spans = [
            _span("Francesinha", "food", t_in=0, t_out=20, importance=0.9),
            _span("Livraria Lello", "landmark", t_in=30, t_out=50),
        ]
        # 2 shots na library (mock _fake_table)
        rows = [
            {"shot_id": "sh1", "media_sha": "sha1",
             "t_in": 0.0, "t_out": 8.0, "quality": 5, "revoked": False,
             "places_csv": "Porto", "landmarks_csv": "",
             "food_csv": "Francesinha"},
            {"shot_id": "sh2", "media_sha": "sha2",
             "t_in": 0.0, "t_out": 7.0, "quality": 4, "revoked": False,
             "places_csv": "Porto", "landmarks_csv": "Livraria Lello",
             "food_csv": ""},
        ]
        db_a = _fake_db(rows)
        db_b = _fake_db(rows)
        p1 = build_coverage_plan(spans, db_a, s, topic="24h Porto",
                                 total_script_seconds=100.0)
        p2 = build_coverage_plan(spans, db_b, s, topic="24h Porto",
                                 total_script_seconds=100.0)
        # Comparar JSON serializado (byte-equal)
        j1 = p1.model_dump_json(indent=2)
        j2 = p2.model_dump_json(indent=2)
        self.assertEqual(j1, j2,
                         msg="CoveragePlan deve ser byte-equal entre 2 runs idênticos")


# ----------------- extra: write_plan persiste ficheiro -----------------
class TestWritePlan(unittest.TestCase):
    def test_write_plan_persists_json(self):
        import shutil
        s = Settings()
        spans = [_span("Francesinha", "food", t_in=0, t_out=20)]
        td = tempfile_ses()
        try:
            p = build_coverage_plan(spans, _fake_db([]), s, topic="Porto",
                                    total_script_seconds=60.0)
            out = write_plan(p, td / "plan.json")
            data = json.loads(out.read_text("utf-8"))
            self.assertEqual(data["schema_version"], "1.0")
            self.assertEqual(data["topic"], "Porto")
            self.assertEqual(len(data["ranked_entities"]), 1)
            self.assertEqual(data["ranked_entities"][0]["canonical_name"],
                             "Francesinha")
            self.assertIn("coverage_buffer", data["settings_snapshot"])
        finally:
            shutil.rmtree(td, ignore_errors=True)


def tempfile_ses() -> Path:
    """Devolve Path (em vez de string) para que '/plan.json' funcione."""
    import tempfile
    return Path(tempfile.mkdtemp(prefix="tmp_coverage_"))


# ----------------- T20 — invariante Fase 2: cobertura suficiente ⇒ deficit==0
# Spec: "Coverage Plan evita downloads quando cobertura já é suficiente."
# Garantia mecânica: topup_for_plan (em topup.py) salta entidades com
# deficit_seconds <= 0 (não chama sweep, não chama ingest). Esta classe
# prova que build_coverage_plan calcula deficit_seconds = 0 quando
# available_meets_target, para dois cenários canónicos.
class TestCoverageSufficient(unittest.TestCase):
    def test_single_entity_covered_zero_deficit(self):
        """Cenário 1 entity: Francesinha exige 20s de narração; library
        tem 1 shot de 30s Francesinha (single media_sha) ⇒ target=25s,
        available=30s, **deficit=0** ⇒ ZERO downloads quando topup correr."""
        s = Settings()
        row = _span("Francesinha", "food", t_in=0, t_out=20)  # 20s required
        rows = [{
            "shot_id": "sh_fran",
            "media_sha": "sha_fran",
            "t_in": 0.0, "t_out": 30.0,     # 30s reais cap por media_sha
            "quality": 5, "revoked": False,
            "places_csv": "Porto",
            "landmarks_csv": "",
            "food_csv": "Francesinha",
        }]
        plan = build_coverage_plan(
            [row], _fake_db(rows), s,
            topic="24h Porto", total_script_seconds=300.0)
        ent = plan.ranked_entities[0]
        # required=20, buffer=1.25, target=25
        self.assertEqual(ent.required_seconds, 20.0)
        self.assertEqual(ent.target_seconds, 25.0)
        # available=30 (cap real: t_out max por media_sha = 30)
        self.assertEqual(ent.available_seconds, 30.0)
        # INVARIANTE Fase 2: deficit = max(0, target-available) = 0
        self.assertEqual(ent.deficit_seconds, 0.0)
        # Sanity: a entity está coberta com shots + files contabilizados.
        self.assertEqual(ent.available_distinct_shots, 1)
        self.assertEqual(ent.available_files, 1)
        # NÃO marcou nota "sem shots" porque há shots.
        self.assertFalse(
            any("sem shots" in n for n in ent.notes),
            f"coberta mas marcou nota: {ent.notes}",
        )

    def test_multi_entity_only_deficit_triggers_topup(self):
        """Cenário 2 entities: Francesinha coberta, Lello SEM shots.
        Apenas Lello entra no topup. Francesinha fica inalterada."""
        s = Settings()
        spans = [
            _span("Francesinha", "food", t_in=0, t_out=20),
            _span("Livraria Lello", "landmark", t_in=30, t_out=50),
        ]
        rows = [{
            "shot_id": "sh_fran",
            "media_sha": "sha_fran",
            "t_in": 0.0, "t_out": 30.0,
            "quality": 5, "revoked": False,
            "places_csv": "Porto",
            "landmarks_csv": "",
            "food_csv": "Francesinha",
        }]
        # Lello NÃO tem rows — fica deficit total.
        plan = build_coverage_plan(
            spans, _fake_db(rows), s,
            topic="24h Porto", total_script_seconds=300.0)
        deficiencies = {ent.canonical_name: ent.deficit_seconds
                        for ent in plan.ranked_entities}
        # Francesinha coberta: NO top-up
        self.assertEqual(deficiencies["Francesinha"], 0.0)
        # Lello descoberta pelo plan mas sem biblioteca ⇒ deficit total
        lello_deficit = deficiencies["Livraria Lello"]
        self.assertGreater(lello_deficit, 0.0,
                            f"Lello devia ter deficit > 0, obtido {lello_deficit}")
        # Sanity: Francesinha NÃO marca 'sem shots' nota; Lello marca.
        fran_ent = next(e for e in plan.ranked_entities
                        if e.canonical_name == "Francesinha")
        lello_ent = next(e for e in plan.ranked_entities
                         if e.canonical_name == "Livraria Lello")
        self.assertFalse(any("sem shots" in n for n in fran_ent.notes))
        self.assertTrue(any("sem shots" in n for n in lello_ent.notes),
                        "Lello sem shots devia ter nota explícita")

    def test_exact_target_match_zero_deficit_boundary(self):
        """Caso de borda: available == target (sem folga) ⇒ deficit = 0.
        Importante porque topup usa strict > e queremos zero marginal downloads."""
        s = Settings()
        row = _span("Francesinha", "food", t_in=0, t_out=20)  # required=20s
        # buffer 1.25 → target = 25.0
        rows = [{
            "shot_id": "sh_fran",
            "media_sha": "sha_fran",
            "t_in": 0.0, "t_out": 25.0,    # exactamente target
            "quality": 5, "revoked": False,
            "places_csv": "Porto",
            "landmarks_csv": "",
            "food_csv": "Francesinha",
        }]
        plan = build_coverage_plan(
            [row], _fake_db(rows), s,
            topic="24h Porto", total_script_seconds=300.0)
        ent = plan.ranked_entities[0]
        self.assertEqual(ent.target_seconds, 25.0)
        self.assertEqual(ent.available_seconds, 25.0)
        # boundary: 0 deficit (>=), não negativo
        self.assertEqual(ent.deficit_seconds, 0.0)


# ----------------- item 6 / T3 — required_seconds vem da Scene, não da frase
class TestRequiredSecondsFromScene(unittest.TestCase):
    def test_scene_15s_gera_requirement_15s_nao_1s(self):
        """T3 do enunciado: uma Scene de 15s sobre Lello gera requirement
        ~15s, mesmo que o EntitySpan (duração da FRASE "Livraria Lello")
        dure só ~1.5s dentro dessa cena."""
        s = Settings()
        # EntitySpan estreito: só a frase "Livraria Lello" (t=5.0-6.5, 1.5s)
        span = _span("Livraria Lello", "landmark", t_in=5.0, t_out=6.5)
        # Scene larga: toda a secção narrativa sobre a livraria (0-15s)
        scenes = [Scene(scene_id="s001", t_in=0.0, t_out=15.0,
                        text="cena sobre a Livraria Lello",
                        primary_entity="Livraria Lello",
                        primary_entity_type="landmark")]
        ranked = rank_entity_importance(
            [span], total_script_seconds=60.0, topic="Porto", scenes=scenes)
        self.assertEqual(len(ranked), 1)
        self.assertAlmostEqual(ranked[0].required_seconds, 15.0, places=2)

    def test_sem_scenes_mantem_fallback_por_entityspan(self):
        """Retrocompatibilidade: sem `scenes`, required_seconds continua a
        vir da soma dos EntitySpans (comportamento antigo)."""
        span = _span("Livraria Lello", "landmark", t_in=5.0, t_out=6.5)
        ranked = rank_entity_importance(
            [span], total_script_seconds=60.0, topic="Porto")
        self.assertAlmostEqual(ranked[0].required_seconds, 1.5, places=2)

    def test_scene_sem_primary_entity_nao_afeta_ranking(self):
        """Scenes sem primary_entity (filler/generic) são ignoradas no
        índice de duração por entidade — não corrompem outras entities."""
        span = _span("Francesinha", "food", t_in=0.0, t_out=2.0)
        scenes = [
            Scene(scene_id="s001", t_in=0.0, t_out=20.0,
                 text="cena sobre a Francesinha", primary_entity="Francesinha",
                 primary_entity_type="food"),
            Scene(scene_id="s002", t_in=20.0, t_out=25.0, text="filler genérico"),
        ]
        ranked = rank_entity_importance(
            [span], total_script_seconds=60.0, topic="Porto", scenes=scenes)
        self.assertAlmostEqual(ranked[0].required_seconds, 20.0, places=2)

    def test_build_coverage_plan_aceita_scenes_kwarg(self):
        """build_coverage_plan propaga `scenes` até rank_entity_importance."""
        s = Settings()
        span = _span("Livraria Lello", "landmark", t_in=5.0, t_out=6.5)
        scenes = [Scene(scene_id="s001", t_in=0.0, t_out=15.0,
                        text="x", primary_entity="Livraria Lello",
                        primary_entity_type="landmark")]
        plan = build_coverage_plan(
            [span], _fake_db([]), s, topic="Porto",
            total_script_seconds=60.0, scenes=scenes)
        self.assertAlmostEqual(plan.ranked_entities[0].required_seconds, 15.0,
                               places=2)


# ----------------- item 9 / T6 — união de intervalos por media_sha ----------
class TestUnionOfIntervals(unittest.TestCase):
    def test_disjoint_intervals_same_media_sha_nao_duplicam(self):
        """Doutrina: media A com shots [0,5],[4,9],[20,25] -> usable union
        = 14s (9 + 5), NUNCA 25s (max(t_out)) nem 15s (soma simples com
        overlap [0,5]+[4,9] contado 2x)."""
        s = Settings()
        row = _span("Livraria Lello", "landmark", t_in=0, t_out=10)
        rows = [
            {"shot_id": "sh1", "media_sha": "shaA", "t_in": 0.0, "t_out": 5.0,
             "quality": 5, "revoked": False, "places_csv": "",
             "landmarks_csv": "Livraria Lello", "food_csv": ""},
            {"shot_id": "sh2", "media_sha": "shaA", "t_in": 4.0, "t_out": 9.0,
             "quality": 5, "revoked": False, "places_csv": "",
             "landmarks_csv": "Livraria Lello", "food_csv": ""},
            {"shot_id": "sh3", "media_sha": "shaA", "t_in": 20.0, "t_out": 25.0,
             "quality": 5, "revoked": False, "places_csv": "",
             "landmarks_csv": "Livraria Lello", "food_csv": ""},
        ]
        plan = build_coverage_plan([row], _fake_db(rows), s, topic="Porto",
                                   total_script_seconds=60.0)
        ent = plan.ranked_entities[0]
        self.assertAlmostEqual(ent.available_seconds, 14.0, places=2)
        self.assertEqual(ent.available_distinct_shots, 3)
        self.assertEqual(ent.available_files, 1)

    def test_per_shot_durations_preenchido_item9(self):
        """_per_shot_durations (PrivateAttr) deixa de ficar vazio — bug
        anterior fazia strict_available_seconds ser sempre 0."""
        s = Settings()
        row = _span("Francesinha", "food", t_in=0, t_out=10)
        rows = [
            {"shot_id": "sh1", "media_sha": "shaA", "t_in": 0.0, "t_out": 6.0,
             "quality": 5, "revoked": False, "places_csv": "",
             "landmarks_csv": "", "food_csv": "Francesinha"},
        ]
        plan = build_coverage_plan([row], _fake_db(rows), s, topic="Porto",
                                   total_script_seconds=60.0)
        ent = plan.ranked_entities[0]
        self.assertEqual(ent._per_shot_durations, {"sh1": 6.0})

    def test_shot_unico_media_com_t_in_nao_zero_conta_duracao_real(self):
        """Bug adicional descoberto: um único shot com t_in!=0 usava
        t_out como se fosse a duração inteira (ignorava t_in). Union fix
        corrige isto também para o caso de 1 shot só."""
        s = Settings()
        row = _span("Francesinha", "food", t_in=0, t_out=10)
        rows = [
            {"shot_id": "sh1", "media_sha": "shaA", "t_in": 5.0, "t_out": 15.0,
             "quality": 5, "revoked": False, "places_csv": "",
             "landmarks_csv": "", "food_csv": "Francesinha"},
        ]
        plan = build_coverage_plan([row], _fake_db(rows), s, topic="Porto",
                                   total_script_seconds=60.0)
        ent = plan.ranked_entities[0]
        # duração real = 15-5 = 10s, não t_out=15s
        self.assertAlmostEqual(ent.available_seconds, 10.0, places=2)


# ----------------- item 10 / T7 — mesmo shot não conta 3x para 3 requirements
class TestSameShotNotArtificiallyTriple(unittest.TestCase):
    def test_shot_partilhado_entre_3_entities_nao_infla_disponibilidade(self):
        """measure_coverage() é chamado por-entity — um shot cujos metadados
        batem em 3 entities distintas conta available_seconds/shots em
        CADA entity individualmente (correcto para medir candidatos), mas
        a FEASIBILITY real (selected_shots.json, item 10 da doutrina) tem
        de impedir que esse shot seja alocado a mais de 1 requirement no
        vídeo final — isso é responsabilidade da camada de selecção
        (workset_builder/assigner), não de measure_coverage. Este teste
        documenta o comportamento actual de measure_coverage (mede
        candidatos, não aloca) para não confundir os dois níveis."""
        s = Settings()
        shared_row = {
            "shot_id": "sh_shared", "media_sha": "shaShared",
            "t_in": 0.0, "t_out": 8.0, "quality": 5, "revoked": False,
            "places_csv": "Porto", "landmarks_csv": "Livraria Lello",
            "food_csv": "Francesinha",
        }
        spans = [
            _span("Livraria Lello", "landmark", t_in=0, t_out=5),
            _span("Francesinha", "food", t_in=10, t_out=15),
        ]
        plan = build_coverage_plan(spans, _fake_db([shared_row]), s,
                                   topic="Porto", total_script_seconds=60.0)
        by_name = {e.canonical_name: e for e in plan.ranked_entities}
        # ambos os requirements VEEM o shot como candidato (measure é
        # por-entity, não sabe que é o MESMO shot físico) — mas cada um
        # regista o mesmo shot_id, permitindo à camada de selecção
        # detectar o conflito via intersecção de available_shot_ids.
        self.assertIn("sh_shared", by_name["Livraria Lello"].available_shot_ids)
        self.assertIn("sh_shared", by_name["Francesinha"].available_shot_ids)


# ----------------- item 7 / T8 — contextual filler completa a timeline ----
class TestContextualFiller(unittest.TestCase):
    def test_filler_completa_tempo_restante(self):
        """video=180s, core narrative windows=125s -> filler ~55s
        (+ buffer no target)."""
        s = Settings()
        span = _span("Livraria Lello", "landmark", t_in=0, t_out=125)
        plan = build_coverage_plan(
            [span], _fake_db([]), s, topic="Porto",
            total_script_seconds=180.0, include_filler=True)
        names = [e.canonical_name for e in plan.ranked_entities]
        filler = next(e for e in plan.ranked_entities
                      if e.entity_type == "filler")
        self.assertEqual(len(plan.ranked_entities), 2)
        self.assertAlmostEqual(filler.required_seconds, 55.0, places=2)
        self.assertFalse(filler.strict, "filler nunca é strict")
        self.assertIn("Livraria Lello", names)

    def test_sem_filler_quando_core_cobre_tudo(self):
        """Core já cobre a timeline inteira -> nenhum requirement filler
        é acrescentado (None, não uma entity de 0s)."""
        s = Settings()
        span = _span("Livraria Lello", "landmark", t_in=0, t_out=180)
        plan = build_coverage_plan(
            [span], _fake_db([]), s, topic="Porto",
            total_script_seconds=180.0, include_filler=True)
        self.assertEqual(len(plan.ranked_entities), 1)

    def test_include_filler_false_nao_altera_shape_antigo(self):
        """Default include_filler=False preserva o comportamento antigo
        (retrocompatibilidade com callers que não pedem filler)."""
        s = Settings()
        span = _span("Livraria Lello", "landmark", t_in=0, t_out=20)
        plan = build_coverage_plan(
            [span], _fake_db([]), s, topic="Porto", total_script_seconds=180.0)
        self.assertEqual(len(plan.ranked_entities), 1)

    def test_filler_nunca_satisfaz_strict(self):
        """Filler é sempre strict=False mesmo se todas as entities core
        forem strict — nunca pode substituir footage estrito."""
        s = Settings()
        span = _span("Francesinha", "food", t_in=0, t_out=10, strict=True)
        plan = build_coverage_plan(
            [span], _fake_db([]), s, topic="Porto",
            total_script_seconds=100.0, include_filler=True)
        filler = next(e for e in plan.ranked_entities
                      if e.entity_type == "filler")
        self.assertFalse(filler.strict)


if __name__ == "__main__":
    unittest.main()
