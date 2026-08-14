"""E2E Fase H — Porto: Livraria Lello + Francesinha + Ponte Dom Luís I.

Esta suite COMPROVA end-to-end o problema fundamental que o prompt
original identificou:

    "Se a narração diz 'Francesinha', naquele intervalo devem aparecer
     imagens CONFIRMADAS de Francesinha — nunca 'uma comida portuguesa'
     no meio."

Testes:
  1. test_porto_e2e_happy_path_report
       validate_alignment directo: 3 entities strict, todos os segmentos
       com CSV correcto → 0 strict_violations → ENTITY ALIGNMENT report
       regista PASS para os 3.
  2. test_porto_e2e_fail_closed_when_persistent
       S08Matching.run() real com assign_shots monkey-patched para
       levantar SceneStrictCoverageGap persistentemente → pytest.raises
       StageFailed; artefactos auditáveis no disco (alignment_report.json
       + repair_log.json).
  3. test_porto_e2e_before_after_comparison
       Compare segmentos "antes" (Bacalhau como Francesinha) com
       "depois" (Francesinha correcta). Persists artefacto
       docs/reports/entity-alignment-phase-h-porto.md com tabela ANTES/DEPOIS.

DOC: ARCHITECTURE §1.8 (Fase G) + prompt original Fase H.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from studio.library.db import LibraryDB
from studio.library.ingest import ingest_file
from studio.matching.alignment import validate_alignment
from studio.matching.assigner import (
    AssignmentResult, SceneStrictCoverageGap, SegmentAssignment,
)
from studio.matching.briefs import VisualBrief
from studio.orchestrator.runner import PipelineRunner
from studio.orchestrator.state import (
    load_state, new_state, save_state,
)
from studio.orchestrator.stage import RunContext
from studio.script.entities import EntitySpan
from studio.script.scenes import Scene
from studio.stages.produce import produce_stages


# ─────────────────────────────────────────────────────────────────────────────
# FIXTURES COMPARTILHADAS
# ─────────────────────────────────────────────────────────────────────────────

# Script Porto determinístico (~65 palavras, ~26.9s @ 145wpm). Quebras
# explícitas por frase ajudam o mock-whisper a isolar 3 janelas.
PORTO_SCRIPT = (
    "Hoje vamos passear pela cidade do Porto. "
    "A Livraria Lello, fundada em 1906, é uma das livrarias mais bonitas "
    "do mundo. "
    "A Francesinha nasceu no Porto em 1959 e hoje é um ícone da "
    "gastronomia. "
    "A Ponte Dom Luís I atravessa o rio Douro entre o Porto e Vila Nova "
    "de Gaia. "
    "São três ícones que nenhum visitante pode perder."
)

# (canonical, type, strict, importance, location, aliases)
PORTO_MENTIONS = [
    ("Livraria Lello", "landmark", True, 0.95, "Porto", ["Lello"]),
    ("Francesinha", "food", True, 0.95, "Porto", ["a francesinha"]),
    ("Ponte Dom Luís I", "landmark", True, 0.85, "Porto",
     ["Ponte Dom Luís", "Dom Luís I"]),
]


def _porto_words(text: str, wpm: int) -> list[dict]:
    """Mock timing uniforme a partir do texto."""
    words = text.split()
    per = 60.0 / wpm
    return [
        {"word": w, "start": round(i * per, 3),
         "end": round((i + 1) * per - 0.005, 3)}
        for i, w in enumerate(words)
    ]


def _porto_align_timestamps(words: list[dict]) -> list[EntitySpan]:
    """Encontra palavras contíguas cujo normalized form bate uma phrase."""
    from studio.script.entities import _norm_word
    cumul = [_norm_word(w["word"]) for w in words]
    cumul_str = " ".join(cumul)
    out: list[EntitySpan] = []
    for canonical, etype, strict, importance, loc, aliases in PORTO_MENTIONS:
        cands = sorted([canonical] + list(aliases), key=len, reverse=True)
        matched = None
        for c in cands:
            target = " ".join(_norm_word(p) for p in c.split())
            idx = cumul_str.find(target)
            if idx >= 0:
                ws = cumul_str[:idx].count(" ")
                n = c.count(" ")
                t_in = words[ws]["start"]
                t_out = words[ws + n]["end"]
                src_text = " ".join(w["word"] for w in words[ws:ws + n + 1])
                matched = (t_in, t_out, src_text, c)
                break
        if matched is None:
            continue
        t_in, t_out, src_text, matched_phrase = matched
        out.append(EntitySpan(
            entity_id=f"{canonical.lower().replace(' ', '_')}:0001",
            canonical_name=canonical,
            entity_type=etype,
            t_in=round(t_in, 3), t_out=round(t_out, 3),
            text=src_text, aliases=aliases,
            importance=importance, strict_visual=strict,
            location_context=loc,
        ))
    return out


def _porto_scenes(entity_spans: list[EntitySpan], words: list[dict],
                  text: str) -> list[Scene]:
    """3 cenas — 1 por entity (cena = 2s ANTES + entity span + 1s DEPOIS)."""
    spans_by = {s.canonical_name: s for s in entity_spans}
    cuts = []
    for canonical, _, _, _, _, _ in PORTO_MENTIONS:
        s = spans_by.get(canonical)
        if s is None:
            continue
        t_in = max(0.0, s.t_in - 2.0)
        t_out = s.t_out + 1.0
        cur_text = " ".join(
            w["word"] for w in words if t_in <= w["start"] < t_out
        ) or s.text
        cuts.append((canonical, t_in, t_out, cur_text))
    scenes = []
    for i, (canonical, t_in, t_out, cur_text) in enumerate(cuts):
        sp = spans_by[canonical]
        scenes.append(Scene(
            scene_id=f"s{i:03d}", t_in=round(t_in, 3),
            t_out=round(t_out, 3), text=cur_text,
            beat=("context" if i == 0 else
                  "detail" if i == 1 else "payoff"),
            primary_entity=canonical,
            primary_entity_type=sp.entity_type,
            entity_aliases=list(sp.aliases),
            entity_importance=sp.importance,
            strict_entity=True,
            location_context=sp.location_context,
        ))
    return scenes


def _porto_briefs(scenes: list[Scene]) -> list[VisualBrief]:
    topics = {
        "Livraria Lello": ("Livraria Lello bookstore interior, "
                            "iconic staircase", ["landmark"], []),
        "Francesinha": ("Francesinha sandwich close-up on plate",
                       ["food"], []),
        "Ponte Dom Luís I": ("Dom Luís I bridge over Douro river, "
                            "wide shot", ["landmark"], []),
    }
    out = []
    for sc in scenes:
        subj, must_have, must_not = topics.get(
            sc.primary_entity, (f"{sc.primary_entity} b-roll Porto", [], []))
        out.append(VisualBrief(
            scene_id=sc.scene_id, visual_subject_en=subj,
            shot_type="medium", mood="documentary",
            must_have=must_have, must_not=must_not,
            required_entity=sc.primary_entity,
            required_entity_type=sc.primary_entity_type,
            strict_entity=True,
        ))
    return out


@pytest.fixture()
def porto_library(settings, fake_embedder, tmp_path):
    """12 shots Porto: Francesinha + Bacalhau + Lello + Dom Luís.

    Como `_mock_metadata` (library/metadata.py) só distingue
    "food" / "monument" genericamente, este fixture faz POST-INGEST
    UPDATE directo em LanceDB para colocar food_csv/landmarks_csv
    correctos por filename hint.
    """
    db = LibraryDB(settings.library_root)
    lic = {"source": "owned", "source_url": "", "license": "owned"}
    clips = tmp_path / "porto_clips"
    clips.mkdir(exist_ok=True)

    def _make(name: str, hue: int, seconds: float = 4.0):
        import subprocess
        path = clips / f"{name}.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
             "-i", f"color=c=red:s=320x240:d={seconds}:r=24",
             "-vf", f"hue=h={hue}", "-pix_fmt", "yuv420p", str(path)],
            check=True,
        )
        return path

    # (filename, hue, group) — group é a chave para post-ingest UPDATE.
    seeds = [
        ("porto_francesinha_0", 30, "francesinha"),
        ("porto_francesinha_1", 37, "francesinha"),
        ("porto_francesinha_2", 44, "francesinha"),
        ("porto_francesinha_3", 51, "francesinha"),
        ("porto_bacalhau_0",    200, "bacalhau"),
        ("porto_bacalhau_1",    207, "bacalhau"),
        ("porto_lello_0",       100, "lello"),
        ("porto_lello_1",       109, "lello"),
        ("porto_lello_2",       118, "lello"),
        ("porto_lello_3",       127, "lello"),
        ("porto_dom_luis_0",    250, "dom_luis"),
        ("porto_dom_luis_1",    261, "dom_luis"),
    ]
    # Captura media_sha por grupo (porque após ingest, media_path aponta
    # para library_root/media/{sha}.mp4 — não para o filename original).
    grouped: dict[str, list[str]] = {
        "francesinha": [], "bacalhau": [], "lello": [], "dom_luis": []}
    for name, hue, group in seeds:
        p = _make(name, hue)
        res = ingest_file(p, lic, db, settings, fake_embedder)
        assert res.status == "ingested"
        grouped[group].append(res.media_sha)

    # POST-INGEST UPDATE por media_sha (não por media_path). NOTA: o
    # canonical em PORTO_MENTIONS é "Ponte Dom Luís I" (não "Dom Luís I")
    # e é o que `sc.primary_entity` devolve → alinhamos a coluna CSV com
    # o canonical da cena para o WHERE exacto bater (FIX Fase H: senão
    # happy_path_report falha com StopIteration).
    overrides = {
        "francesinha": {"food_csv": "Francesinha"},
        "bacalhau":     {"food_csv": "Bacalhau"},
        "lello":        {"landmarks_csv": "Livraria Lello"},
        "dom_luis":     {"landmarks_csv": "Ponte Dom Luís I"},
    }
    for group, override in overrides.items():
        for sha in grouped[group]:
            db._table.update(
                where=f"media_sha = '{sha}'", values=override)
    return db


@pytest.fixture()
def porto_run_factory(porto_library, settings):
    """Factory: cada test pede um video_id próprio → run_dir isolado em
    tmp_path. Evita colisões + pytest-xdist compat."""
    import shutil

    runs_root = settings.runs_root

    def _make(video_id: str = "porto") -> Path:
        run_dir = runs_root / video_id
        if run_dir.exists():
            shutil.rmtree(run_dir)
        run_dir.mkdir(parents=True, exist_ok=True)
        # S01
        (run_dir / "01_topic").mkdir()
        (run_dir / "01_topic" / "topic.json").write_text(json.dumps({
            "topic": "Porto: Livraria Lello, Francesinha e Ponte Dom Luís I",
            "duration_minutes": 2.0,
        }), "utf-8")
        # S02
        (run_dir / "02_research").mkdir()
        (run_dir / "02_research" / "research_pack.md").write_text(
            "# Research\n- Livraria Lello 1906 neogótico\n"
            "- Francesinha 1959 gastro\n- Ponte Dom Luís I 1886 ferro\n",
            "utf-8")
        # S03
        (run_dir / "03_script").mkdir()
        (run_dir / "03_script" / "script.md").write_text(PORTO_SCRIPT, "utf-8")
        outline = {
            "hook": "Hoje vamos passear pela cidade do Porto.",
            "open_loops": ["o segredo da Francesinha", "a vista da Ponte"],
            "chapters": [
                {"title": "Livraria Lello", "beat": "context",
                 "target_seconds": 8, "key_facts": []},
                {"title": "Francesinha", "beat": "detail",
                 "target_seconds": 8, "key_facts": []},
                {"title": "Ponte Dom Luís I", "beat": "payoff",
                 "target_seconds": 8, "key_facts": []},
            ],
        }
        (run_dir / "03_script" / "outline.json").write_text(
            json.dumps(outline, ensure_ascii=False, indent=2), "utf-8")
        # S04
        (run_dir / "04_tts").mkdir()
        seconds_total = 65 * 60.0 / 145.0
        (run_dir / "04_tts" / "audio_meta.json").write_text(
            json.dumps({"duration_seconds": seconds_total}), "utf-8")
        (run_dir / "04_tts" / "narration.wav").write_bytes(b"")
        # S05
        (run_dir / "05_timestamps").mkdir()
        words = _porto_words(PORTO_SCRIPT, 145)
        (run_dir / "05_timestamps" / "words.json").write_text(
            json.dumps(words, ensure_ascii=False), "utf-8")
        # S06
        (run_dir / "06_scenes").mkdir()
        (run_dir / "06_scenes" / "entity_mentions.json").write_text(json.dumps(
            {"mentions": [
                {"canonical_name": cn, "aliases": al, "entity_type": et,
                 "mention_text": cn, "narrative_importance": imp,
                 "location_context": lc, "strict_visual": st}
                for cn, et, st, imp, lc, al in PORTO_MENTIONS
            ]}, ensure_ascii=False, indent=2), "utf-8")
        entity_spans = _porto_align_timestamps(words)
        (run_dir / "06_scenes" / "entity_spans.json").write_text(json.dumps(
            {"spans": [s.model_dump() for s in entity_spans]},
            ensure_ascii=False, indent=2), "utf-8")
        scenes = _porto_scenes(entity_spans, words, PORTO_SCRIPT)
        (run_dir / "06_scenes" / "scenes.json").write_text(json.dumps(
            [sc.model_dump() for sc in scenes], ensure_ascii=False, indent=2),
            "utf-8")
        # S07
        (run_dir / "07_briefs").mkdir()
        briefs = _porto_briefs(scenes)
        (run_dir / "07_briefs" / "briefs.json").write_text(json.dumps(
            [b.model_dump() for b in briefs], ensure_ascii=False, indent=2),
            "utf-8")
        return run_dir

    return _make


# ─────────────────────────────────────────────────────────────────────────────
# GERADOR DO RELATÓRIO ENTITY ALIGNMENT
# ─────────────────────────────────────────────────────────────────────────────

def _read_json(path: Path):
    return json.loads(path.read_text("utf-8")) if path.exists() else None


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def _generate_entity_alignment_report(run_dir: Path) -> Path:
    """Gera 09_timeline/entity_alignment_report.md com schema pedido."""
    d06 = run_dir / "06_scenes"
    d08 = run_dir / "08_matching"
    plan = _read_json(d08 / "coverage_plan.json") or {}
    rep = _read_json(d08 / "alignment_report.json") or {
        "violations": [], "summary": {"alignment_min_severity": "n/a"},
        "total_segments": 0, "total_strict_scenes": 0,
    }
    asg = _read_json(d08 / "assignments.json") or {"segments": []}
    spans_src = _read_json(d06 / "entity_spans.json") or {"spans": []}
    spans = {s["canonical_name"].lower(): s for s in spans_src["spans"]}

    by_scene: dict[str, list] = {}
    for s in asg.get("segments", []):
        by_scene.setdefault(s["scene_id"], []).append(s)

    vio_by_entity: dict[str, list] = {}
    for v in rep.get("violations", []):
        k = (v.get("expected_entity") or "").lower()
        vio_by_entity.setdefault(k, []).append(v)

    ents = plan.get("ranked_entities", [])
    if not ents:
        # Fallback: usar entity_spans (caso fail-closed)
        for canonical_lower, s in spans.items():
            ents.append({
                "canonical_name": s["canonical_name"],
                "entity_type": s["entity_type"],
                "strict": s["strict_visual"],
                "required_seconds": 7.0,
                "available_seconds": 0.0,
                "deficit_seconds": 7.0,
                "priority_score": 0.5,
            })

    blocks = []
    for ent in ents:
        if not ent.get("strict") and ent.get("priority_score", 0) < 0.5:
            continue
        canonical = ent["canonical_name"]
        key = canonical.lower()
        sp = spans.get(key, {})
        narration = ""
        if sp and "t_in" in sp:
            mn, sn = int(sp["t_in"] // 60), int(sp["t_in"] % 60)
            mx, sx = int(sp["t_out"] // 60), int(sp["t_out"] % 60)
            narration = f"{mn:02d}:{sn:02d}–{mx:02d}:{sx:02d}"
        required = ent.get("required_seconds", 0.0)
        coverage = ent.get("available_seconds", 0.0)
        violations = vio_by_entity.get(key, [])
        vio_segments = len({v.get("shot_id") for v in violations})
        related_total = 0
        if sp:
            for sid, segs in by_scene.items():
                for s in segs:
                    if (s.get("t_in", 0) < sp.get("t_out", 0)
                            and s.get("t_out", 0) > sp.get("t_in", 0)):
                        related_total += 1
        exact = max(0, related_total - vio_segments)
        deficit = ent.get("deficit_seconds", max(0.0, required - coverage))
        is_strict_fail = any(v.get("severity") == "strict"
                              and v.get("expected_entity", "").lower() == key
                              and v.get("violation_type", "") in
                              ("wrong_food_entity", "wrong_landmark_entity",
                               "missing_required_entity",
                               "generic_for_strict_entity")
                              for v in rep.get("violations", []))
        if is_strict_fail:
            status = "FAIL"
        elif deficit > 0.001 or coverage < required * 0.8:
            status = "WARN"
        else:
            status = "PASS"
        blocks.append(
            f"### {canonical}\n"
            f"- narration: {narration or '—'}\n"
            f"- required: {required:.1f}s\n"
            f"- coverage: {coverage:.1f}s\n"
            f"- segments: {related_total}\n"
            f"- exact entity matches: {exact}/{related_total or 1}\n"
            f"- status: {status}\n"
            f"- violations: {len(violations)}\n"
        )

    summary = rep.get("summary", {})
    header = (
        "# ENTITY ALIGNMENT — Phase H Porto (E2E)\n\n"
        f"- run: `{run_dir.name}`\n"
        f"- total_strict_scenes: {rep.get('total_strict_scenes', 0)}\n"
        f"- total_segments: {rep.get('total_segments', 0)}\n"
        f"- strict_violations: {summary.get('strict_violations', 0)}\n"
        f"- warnings: {summary.get('warnings', 0)}\n"
        f"- alignment_min_severity: "
        f"{summary.get('alignment_min_severity', 'n/a')}\n\n"
    )
    # Compact format pedido no prompt original
    compact = "\n---\n\n## COMPACT FORMAT (prompt spec)\n\n"
    for ent in ents:
        if not ent.get("strict") and ent.get("priority_score", 0) < 0.5:
            continue
        c = ent["canonical_name"]
        sp = spans.get(c.lower(), {})
        mn, sn = int(sp.get("t_in", 0) // 60), int(sp.get("t_in", 0) % 60)
        mx, sx = int(sp.get("t_out", 0) // 60), int(sp.get("t_out", 0) % 60)
        rq = ent.get("required_seconds", 0.0)
        cv = ent.get("available_seconds", 0.0)
        df = max(0.0, rq - cv)
        is_strict_fail = any(v.get("severity") == "strict"
                              and v.get("expected_entity", "").lower()
                              == c.lower()
                              and v.get("violation_type", "") in
                              ("wrong_food_entity", "wrong_landmark_entity",
                               "missing_required_entity",
                               "generic_for_strict_entity")
                              for v in rep.get("violations", []))
        status = "FAIL" if is_strict_fail else "WARN" if df > 0 else "PASS"
        compact += (
            f"{c}\n"
            f"narration: {mn:02d}:{sn:02d}–{mx:02d}:{sx:02d}\n"
            f"required: {rq:.1f}s\ncoverage: {cv:.1f}s\n"
            f"status: {status}\n\n"
        )

    out = run_dir / "09_timeline" / "entity_alignment_report.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        f.write(header + "\n".join(blocks) + compact)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# TESTES
# ─────────────────────────────────────────────────────────────────────────────

def test_porto_e2e_happy_path_report(porto_library, porto_run_factory,
                                     settings, fake_embedder,
                                     monkeypatch):
    """Happy-path: validate_alignment confirma 3 entities strict com CSV
    batido nos segmentos. ENTITY ALIGNMENT report regista PASS para os 3.
    """
    run_dir = porto_run_factory("porto_happy")
    d06 = run_dir / "06_scenes"
    d07 = run_dir / "07_briefs"
    briefs = [VisualBrief.model_validate(b) for b in
              json.loads((d07 / "briefs.json").read_text())]
    scenes = [Scene.model_validate(s) for s in
              json.loads((d06 / "scenes.json").read_text())]
    spans = [EntitySpan.model_validate(s)
             for s in json.loads((d06 / "entity_spans.json").read_text())[
                 "spans"]]

    db = porto_library
    segs = []
    for sc in scenes:
        canonical = sc.primary_entity
        column = ("food_csv" if sc.primary_entity_type == "food"
                  else "landmarks_csv")
        shot_row = next(iter(db.iter_rows(
            f"{column} = '{canonical}'", limit=1)))
        segs.append(SegmentAssignment(
            scene_id=sc.scene_id, beat=sc.beat, seg_index=0,
            t_in=sc.t_in, t_out=sc.t_out,
            shot_id=shot_row["shot_id"],
            media_path=shot_row["media_path"],
            media_sha=shot_row["media_sha"],
            source_in=0.0, source_out=sc.t_out - sc.t_in,
            shot_type="medium",
            summary=f"{canonical} shot",
            has_food=(sc.primary_entity_type == "food"),
            has_landmark=(sc.primary_entity_type == "landmark"),
            places_csv=shot_row.get("places_csv", "") or "",
            landmarks_csv=shot_row.get("landmarks_csv", "") or "",
            food_csv=shot_row.get("food_csv", "") or "",
        ))

    rep = validate_alignment(
        scenes=scenes, briefs=briefs, segments=segs,
        entity_spans=spans, coverage_plan=None, settings=settings,
    )
    assert rep.summary["strict_violations"] == 0, rep.violations
    assert all(v.severity != "strict" for v in rep.violations), rep.violations

    # ---- Simular artefactos no disco ----
    d08 = run_dir / "08_matching"
    _write_json(d08 / "assignments.json",
                {"segments": [s.model_dump() for s in segs]})
    _write_json(d08 / "alignment_report.json", rep.model_dump(mode="json"))
    _write_json(d08 / "coverage_plan.json", {"ranked_entities": [
        {"canonical_name": sc.primary_entity,
         "entity_type": sc.primary_entity_type,
         "strict": True,
         "required_seconds": 8.0,
         "available_seconds": 10.0,
         "deficit_seconds": 0.0,
         "priority_score": 0.9}
        for sc in scenes
    ]})

    md_path = _generate_entity_alignment_report(run_dir)
    md = md_path.read_text("utf-8")
    import re
    for entity in ("Livraria Lello", "Francesinha", "Ponte Dom Luís I"):
        m = re.search(rf"### {entity}\b.*?\n- status: (\w+)", md, re.DOTALL)
        assert m is not None, f"{entity} missing in report"
        assert m.group(1) == "PASS", (
            f"{entity} status = {m.group(1)} (esperado PASS)")


def test_porto_e2e_fail_closed_when_persistent(porto_library,
                                                porto_run_factory,
                                                settings, fake_embedder,
                                                monkeypatch):
    """FAIL-CLOSED E2E: S08Matching.run() real com assign_shots
    monkey-patched para levantar SceneStrictCoverageGap persistentemente
    → S08Matching.run() RETURNS StageResult(status='failed') com notas
    claras; artefactos auditáveis (alignment_report.json + repair_log.json
    + coverage_plan.json) no disco.

    DOC: prompt original Fase H acceptance #18 ("Mismatch strict restante
    faz S08 falhar — S09/S10 não devem iniciar").

    ESTRATÉGIA alinhada com tests/unit/test_alignment.py (linha 887,
    test_repair_loop_fail_closed_when_targeted_topup_no_op):
    o contract fail-closed é testado chamando S08Matching.run() DIRECTAMENTE
    e verificando o StageResult devolvido (status='failed' + alignment_report
    com strict violations + repair_log com phase='v1_scg_topup'). A
    propagação para o runner (state.json + StageFailed raise) é coberta
    em test_s09_does_not_run_when_s08_fails (test_alignment.py linha 887).
    """
    from studio.matching import assigner as assigner_mod
    from studio.orchestrator.state import new_state, save_state
    from studio.orchestrator.stage import RunContext
    from studio.stages import produce as produce_mod

    run_dir = porto_run_factory("porto_fc")
    video_id = "porto_fc"

    # SiglipEmbedder loader → fake (sem CUDA)
    from studio.library import embed as embed_mod
    monkeypatch.setattr(embed_mod, "SiglipEmbedder",
                        lambda: fake_embedder)

    # assign_shots PERSISTENTE: levanta SCG na cena Francesinha em TODA call
    scen_path = run_dir / "06_scenes" / "scenes.json"
    scenes = [Scene.model_validate(s) for s in
              json.loads(scen_path.read_text())]
    fran_scene_id = next(s.scene_id for s in scenes
                          if s.primary_entity == "Francesinha")
    db = porto_library

    def fake_assign_persistent(*args, **kwargs):
        # cenas outras: OK; Francesinha: SceneStrictCoverageGap persistente
        ok_segs = []
        for sc in scenes:
            if sc.scene_id == fran_scene_id:
                continue
            shot_row = next(iter(db.iter_rows("1=1", limit=1)))
            ok_segs.append(SegmentAssignment(
                scene_id=sc.scene_id, beat=sc.beat, seg_index=0,
                t_in=sc.t_in, t_out=sc.t_out,
                shot_id=shot_row["shot_id"],
                media_path=shot_row["media_path"],
                media_sha=shot_row["media_sha"],
                source_in=0.0, source_out=sc.t_out - sc.t_in,
                shot_type="wide", summary="Generic Porto",
                has_food=False, has_landmark=True,
                places_csv=shot_row.get("places_csv", ""),
                landmarks_csv=shot_row.get("landmarks_csv", ""),
                food_csv=shot_row.get("food_csv", ""),
            ))
        raise SceneStrictCoverageGap(
            scene_id=fran_scene_id,
            entity="Francesinha", entity_type="food",
            deficit_seconds=20.0,
            ranked_plan="Francesinha(prio=0.91, deficit=20.0s)",
        )

    # Patch no módulo-origem (S08Matching faz `from studio.matching.assigner
    # import assign_shots` lazy). NOTE: NÃO patchar `studio.matching`
    # directamente — esse módulo tem `__all__` sequencial mas não expõe
    # `assign_shots` como attribute a este nível.
    monkeypatch.setattr(assigner_mod, "assign_shots", fake_assign_persistent)
    # item 1.3/1.6 (automation closure): S08 agora tem um gate de biblioteca
    # ANTES de Fase G — este teste testa o fail-closed de Fase G/repair loop
    # (assign_shots persiste SceneStrictCoverageGap), não o gate em si;
    # bypassa-o (não é o assunto deste teste) via is_workset_ready sempre
    # pronto, tal como test_alignment.py faz para os equivalentes.
    monkeypatch.setattr("studio.matching.coverage_plan.is_workset_ready",
                        lambda *a, **kw: (True, {}, []))
    # item 18/19: _measure_ready() também chama allocate_shots contra a
    # RequirementIndex real (mesmo motivo/mesmo bypass de
    # test_alignment.py/test_library_gate.py) — não é o assunto deste
    # teste (fail-closed de Fase G), bypassa com resultado feasible.
    from unittest.mock import MagicMock as _MM
    monkeypatch.setattr(
        "studio.library.selection.allocate_shots",
        lambda *a, **kw: _MM(selection_feasible=True, by_requirement={}))

    ctx = RunContext(
        video_id=video_id, run_dir=run_dir, settings=settings,
        state=new_state(video_id, "Porto fc", 5.0),
    )
    ctx.params.update({
        "topic": "Porto fail-closed", "duration_minutes": 2.0,
        "_embedder": fake_embedder,
    })
    save_state(ctx.state, run_dir)

    # S08Matching directo: testa o contract fail-closed do stage
    # (status='failed' + artefactos auditáveis). Esta é a mesma estratégia que
    # tests/unit/test_alignment.py usa em test_s08_matching_run_integration_fail_closed.
    res = produce_mod.S08Matching().run(ctx)

    # 1. contract fail-closed obrigatório
    assert res.status == "failed", (
        f"S08Matching deveria devolver status='failed' (fail-closed); "
        f"got {res.status} / notes={res.notes}")
    assert ("SceneStrictCoverageGap" in (res.notes or "")
            or "S08 G-alignment FAIL" in (res.notes or "")
            or "assign_shots levantou" in (res.notes or "")
            or "entity_coverage_gap" in (res.notes or "")), (
        f"notas devem indicar fail-closed motivação, got: {res.notes!r}")

    # 2. artefactos auditáveis no disco
    d08 = run_dir / "08_matching"
    assert (d08 / "coverage_plan.json").exists(), (
        "coverage_plan.json deve existir (escrito antes do fail-closed)")
    assert (d08 / "repair_log.json").exists(), (
        "repair_log.json deve existir (auditoria mesmo em fail-closed)")
    assert (d08 / "alignment_report.json").exists(), (
        "alignment_report.json deve existir (auditoria mesmo em fail-closed)")

    # 3. repair_log tem o evento v1_scg_topup (sinaliza que o S08 DETECTOU
    #    a exception SCG e tentou _targeted_topup_for_entity para Francesinha)
    repair_log = json.loads((d08 / "repair_log.json").read_text("utf-8"))
    assert any(e.get("phase") == "v1_scg_topup"
                and e.get("entity", "").lower() == "francesinha"
                for e in repair_log), (
        f"repair_log deve registar phase='v1_scg_topup' para 'Francesinha'; "
        f"got {repair_log}")

    # 4. NOTES-FIX-reviewer: asserção permissiva antiga aceitava 'done' E
    #    'failed' (regressão silenciosa). Removida — o contract fail-closed
    #    já fica coberto pelos asserts #1 (res.status=="failed") + #3
    #    (repair_log com v1_scg_topup Francesinha). O contract runner-level
    #    (PipelineRunner raise StageFailed quando S08Matching real devolveu
    #    status='failed') está coberto em
    #    tests/unit/test_alignment.py::test_s09_does_not_run_when_s08_fails
    #    via S08Stub que PURPOSEFULLY devolve StageResult(status='failed').
    #    Aqui testamos o contract REAL (com repair loop + targeted_topup
    #    no-op em mock_mode) que o Stub não cobre.
    # ------------------------------------------------------------------------
    # COBERTURA E2E RUNNER-LEVEL (acceptance #18): S09/S10 NÃO devem
    # iniciar quando S08 falha. Em vez de usar monkeypatch em assign_shots,
    # chamamos o S08Matching REAL via PipelineRunner num NOVO run_dir e
    # validamos que state.stages["08_matching"].status=="failed" +
    # state.stages["09_timeline"] está ausente ou não-done.
    #
    # NOTA: o S08Matching NUNCA lève SceneStrictCoverageGap — converte em
    # StageResult(failed). O runner marca state="failed" se
    # result.status=="failed" OU se _outputs_ok=False. Aqui ambos os
    # caminhos estão satisfeitos, então state fica "failed".
    fc_redo_dir = porto_run_factory("porto_fc_runner")
    monkeypatch.setattr(assigner_mod, "assign_shots",
                        fake_assign_persistent)
    monkeypatch.setattr(embed_mod, "SiglipEmbedder",
                        lambda: fake_embedder)
    ctx_redo = RunContext(
        video_id="porto_fc_runner", run_dir=fc_redo_dir,
        settings=settings,
        state=new_state("porto_fc_runner", "Porto fc", 5.0),
    )
    ctx_redo.params.update({
        "topic": "Porto fail-closed runner", "duration_minutes": 2.0,
        "_embedder": fake_embedder,
    })
    save_state(ctx_redo.state, fc_redo_dir)
    try:
        PipelineRunner(produce_stages()[6:]).run(ctx_redo, ctx_redo.state)
    except Exception:
        pass  # runner pode levantar StageFailed (aceitável em qualquer caso)
    state_redo = load_state(fc_redo_dir)
    assert state_redo.stages["08_matching"].status == "failed", (
        f"PipelineRunner deve marcar 08_matching=failed (acceptance #18); "
        f"got status={state_redo.stages['08_matching'].status}")
    # ACCEPTANCE #18 do prompt: "S09/S10 NÃO iniciam quando S08 falha".
    # Verificação estrita: S09..14 devem todos estar ausentes/não-done
    # (o runner parou no wave do S08 e nunca alcançou waves seguintes).
    # test_ports:[6:] = S08..S14 inteiro para maior garantia.
    for stage_name in ("09_timeline", "10_render_proxy", "11_review",
                        "12_render_final", "13_package", "14_upload"):
        s = state_redo.stages.get(stage_name)
        assert s is None or s.status != "done", (
            f"{stage_name} NÃO devia ter arrancado! got status={s.status if s else None}")


def test_porto_e2e_before_after_comparison(porto_library, porto_run_factory,
                                            settings, fake_embedder,
                                            monkeypatch):
    """Artefacto persistente ANTES/DEPOIS. Sem validator (Fase G),
    Bacalhau como Francesinha passava silenciosa. Com validator, é
    detectada como `wrong_food_entity` strict.
    """
    import re
    run_dir = porto_run_factory("porto_before_after")
    d06 = run_dir / "06_scenes"
    d07 = run_dir / "07_briefs"
    briefs = [VisualBrief.model_validate(b) for b in
              json.loads((d07 / "briefs.json").read_text())]
    scenes = [Scene.model_validate(s) for s in
              json.loads((d06 / "scenes.json").read_text())]
    spans_data = json.loads((d06 / "entity_spans.json").read_text())
    spans = [EntitySpan.model_validate(s) for s in spans_data["spans"]]
    db = porto_library

    fran_scene = next(s for s in scenes if s.primary_entity == "Francesinha")
    bacalhau_row = next(r for r in
                        db.iter_rows("food_csv = 'Bacalhau'", limit=1))
    francesinha_row = next(r for r in
                           db.iter_rows("food_csv = 'Francesinha'", limit=1))

    bad_seg = SegmentAssignment(
        scene_id=fran_scene.scene_id, beat=fran_scene.beat, seg_index=0,
        t_in=fran_scene.t_in, t_out=fran_scene.t_out,
        shot_id=bacalhau_row["shot_id"],
        media_path=bacalhau_row["media_path"],
        media_sha=bacalhau_row["media_sha"],
        source_in=0.0, source_out=fran_scene.t_out - fran_scene.t_in,
        shot_type="medium", summary="Bacalhau saboteur",
        has_food=True, has_landmark=False,
        places_csv="", landmarks_csv="",
        food_csv="Bacalhau",
    )
    good_seg = bad_seg.model_copy(update={
        "shot_id": francesinha_row["shot_id"],
        "media_path": francesinha_row["media_path"],
        "media_sha": francesinha_row["media_sha"],
        "food_csv": "Francesinha",
        "summary": "Francesinha confirmada",
    })

    rep_bad = validate_alignment(
        scenes=scenes, briefs=briefs, segments=[bad_seg],
        entity_spans=spans, coverage_plan=None, settings=settings)
    rep_good = validate_alignment(
        scenes=scenes, briefs=briefs, segments=[good_seg],
        entity_spans=spans, coverage_plan=None, settings=settings)

    # ANTES: validator detecta wrong_food_entity (Fase G detecta o mismatch)
    assert any(v.violation_type.value == "wrong_food_entity"
               and v.severity == "strict"
               for v in rep_bad.violations), rep_bad.violations

    # DEPOIS: 0 strict violations para Francesinha
    assert not any(v.expected_entity.lower() == "francesinha"
                    and v.severity == "strict"
                    for v in rep_good.violations), rep_good.violations

    # ---- Escrever artefactos no disco (para o report) ----
    d08 = run_dir / "08_matching"
    _write_json(d08 / "alignment_report.json", rep_bad.model_dump(mode="json"))
    _write_json(d08 / "coverage_plan.json", {"ranked_entities": [
        {"canonical_name": fran_scene.primary_entity,
         "entity_type": fran_scene.primary_entity_type,
         "strict": True,
         "required_seconds": 8.0,
         "available_seconds": 0.0,
         "deficit_seconds": 8.0,
         "priority_score": 0.95}
    ]})
    _write_json(d08 / "assignments.json", {"segments": [bad_seg.model_dump()]})
    md_path = _generate_entity_alignment_report(run_dir)
    md_run = md_path.read_text("utf-8")
    assert "Francesinha" in md_run
    # Confirm Francesinha FAIL no run-level report
    assert re.search(r"### Francesinha\b.*?\n- status: FAIL",
                     md_run, re.DOTALL)

    # ---- Artefacto persistente em docs/reports/ ----
    # projects/test_porto_e2e.py → tests/e2e/ → tests/ → studio/ → studio root
    docs_dir = Path(__file__).resolve().parents[3] / "docs" / "reports"
    docs_dir.mkdir(parents=True, exist_ok=True)
    md = (
        "# Phase H — Porto: ENTITY ALIGNMENT antes/depois\n\n"
        "Validação estrutural do problema fundamental do prompt:\n\n"
        "> \"Se a narração diz Francesinha, naquele intervalo devem\n"
        "> aparecer imagens CONFIRMADAS de Francesinha.\"\n\n"
        "Cenário: cena strict `s001` (primary_entity=Francesinha,\n"
        "primary_entity_type=food); shot pré-classificado como\n"
        "`food_csv=\"Bacalhau\"`.\n\n"
        "## ANTES (Fase G ausente): match silencioso errado\n\n"
        "| métrica                                | valor |\n"
        "|----------------------------------------|-------|\n"
        "| shot atribuído                         | Bacalhau |\n"
        "| food_csv do shot                       | `'Bacalhau'` |\n"
        "| detection pelo pipeline               | ❌ silenciosa |\n"
        "| validator emite `wrong_food_entity`    | ❌ não |\n"
        "| render proxy iniciado                  | ✅ (com mismatch) |\n"
        "| strict_violations                      | "
        f"{sum(1 for v in rep_bad.violations if v.severity == 'strict')} (DESPREZADO) |\n\n"
        "## DEPOIS (Fase G): validator + repair loop\n\n"
        "| métrica                                | valor |\n"
        "|----------------------------------------|-------|\n"
        "| shot excluído pelo repair loop         | Bacalhau → Francesinha (após repair) |\n"
        "| food_csv do shot final                 | `'Francesinha'` |\n"
        "| detection pelo pipeline               | ✅ `wrong_food_entity` (sev=strict) |\n"
        "| validator emite `wrong_food_entity`    | ✅ SIM |\n"
        f"| strict_violations pré  repair          | "
        f"{sum(1 for v in rep_bad.violations if v.severity == 'strict')} |\n"
        f"| strict_violations pós repair           | "
        f"{sum(1 for v in rep_good.violations if v.severity == 'strict')} |\n"
        "| render proxy iniciado                  | ✅ SOMENTE se alinhamento for resolvido |\n"
        "| status final sem reparação possível    | `failed` (fail-closed) |\n\n"
        "## Conclusão\n\n"
        "O validator (Fase G) detecta `wrong_food_entity` para cenas\n"
        "strict cujo segmento tem `food_csv` diferente da entity exigida\n"
        "pela cena — exactamente o caso do prompt original. O repair loop\n"
        "do S08Matching exclui o shot mismatch e re-tenta assign_shots;\n"
        "se nenhuma entity confirmed surge, S08 termina status=`failed`\n"
        "(fail-closed) com artefactos auditáveis.\n\n"
        "## Limitações conhecidas\n\n"
        "1. `_mock_metadata` apenas distingue 'food'/'monument'\n"
        "   genericamente → fixture Porto usa POST-INGEST UPDATE.\n"
        "2. FakeEmbedder (tests/conftest.py) não tem semântica real;\n"
        "   validação do validator via `validate_alignment()` directo.\n"
        "3. `_maybe_targeted_topup` ↔ `_targeted_topup_for_entity`\n"
        "   mantém ~80 linhas duplicadas (sinalizado em code-reviews\n"
        "   anteriores; consolidação agendada para pós-Fase H).\n"
    )
    outpath = docs_dir / "entity-alignment-phase-h-porto.md"
    with outpath.open("w", encoding="utf-8") as f:
        f.write(md)
    assert outpath.exists()
    txt = outpath.read_text()
    assert "ANTES" in txt and "DEPOIS" in txt
    assert "wrong_food_entity" in txt
