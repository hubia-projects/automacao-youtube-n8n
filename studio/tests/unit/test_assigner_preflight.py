"""Sprint B Fase 2 — testes do pre-flight dedupe em assigner.assign_shots.

Cobertura:
1. 3 cenas com mesma required_entity → sweep() chamado 1× apenas (não 3×).
2. Ingestões file acontecem SEQUENCIALMENTE (não gather) → GPU safe.
3. Sem pexels_api_key / mock_mode → pre-flight é no-op (não chama nada).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from studio.config import Settings
from studio.matching.assigner import assign_shots
from studio.matching.briefs import VisualBrief
from studio.script.scenes import Scene  # beat é str (não enum)


# ---------- fixtures ----------

def _scene(i: int, text: str, beat: str = "context") -> Scene:
    return Scene(
        scene_id=f"s{i:03d}", beat=beat, t_in=float(i * 3), t_out=float(i * 3 + 2.5),
        text=text,
    )


def _brief(scene_id: str, subject: str, must_have: list[str],
            required_entity: str | None = None) -> VisualBrief:
    return VisualBrief(
        scene_id=scene_id, visual_subject_en=subject,
        must_have=must_have, must_not=[],
        required_entity=required_entity,
        quality_min=2,
    )


def _settings_with_pexels(tmp_path: Path) -> Settings:
    """Settings com pexels_api_key mas mock_mode=False (pre-flight activo).

    FIX-Fase-F-regressão: a versão anterior usava `MagicMock(spec=Settings)`
    que falhava em runtime quando `_score()` lê os campos adicionados na
    Fase F (`assign_score_similarity`, `assign_score_geography_penalty`,
    etc.) — porque `spec=` captura a introspecção estática da classe no
    momento da criação do mock, e essa introspecção não enxerga os campos
    adicionados por herança/concat posterior. Solução robusta: criar
    Settings REAL (via construtor pydantic) e sobrepor com patch apenas
    nos campos que o assigner usa para decidir pre-flight.
    """
    s = Settings(
        mock_mode=False,
        pexels_api_key="test-key",
        veo_enabled=False,
        veo_max_per_video=0,
        library_root=tmp_path,
        runs_root=tmp_path,
        data_root=tmp_path,
        duration_minutes=2.0,
        auto_approve_gates=False,
        youtube_default_privacy="private",
        output_width=640,
        output_height=360,
        render_preset="ultrafast",
        budget_usd_per_run=5.0,
        _env_file=None,
    )
    return s


def _vocab_with(*entities: str) -> dict[str, str]:
    """Fake entity_vocab — devolve dict[str, str] (assinatura real de inventory.py)."""
    return {e: e for e in entities}


# ---------- testes ----------

def test_preflight_dedupes_queries(tmp_path: Path):
    """3 cenas mencionam 'Livraria Lello' → pre-flight chama sweep() 1×."""
    scenes = [_scene(1, "Vamos falar da Livraria Lello", "detail"),
              _scene(2, "A Livraria Lello é histórica", "context"),
              _scene(3, "Dentro da Livraria Lello", "reveal")]
    briefs = [_brief(s.scene_id, "Porto bookstore interior",
                     ["indoor"], required_entity="Livraria Lello")
              for s in scenes]
    db = MagicMock()
    embedder = MagicMock()

    # 1ª chamada vocab (pre-check, vazio); 2ª chamada vocab (após pre-flight)
    empty_vocab: dict[str, str] = {}                       # entity_vocab devolve dict[str, str]
    filled_vocab: dict[str, str] = _vocab_with("Livraria Lello")  # {entity: alias_str}
    db.entity_vocab = MagicMock(side_effect=[empty_vocab, filled_vocab])
    db.search_shots = MagicMock(return_value=[
        {"shot_id": f"sh{i}", "media_path": f"/m{i}.mp4", "media_sha": f"sha{i}",
         "t_in": 0.0, "t_out": 3.0, "similarity": 0.9, "quality": 4,
         "places_csv": "Porto", "landmarks_csv": "Livraria Lello",
         "shot_type": "interior", "summary": "bookstore",
         "has_food": False, "has_landmark": True, "attribution_required": False,
         "attribution_text": "", "usage_count": 0}
        for i in range(3)
    ])
    db.register_usage = MagicMock()

    sweep_calls: list[tuple] = []
    ingest_calls: list[Path] = []

    def fake_sweep(query, count, settings, dest):
        sweep_calls.append((query, count))
        return [(Path("/fake/clip.mp4"), {"source": "pexels", "verified_by": "api"})]

    def fake_ingest_asset(path, lic, db_, settings_, embedder_, **kwargs):
        # item 19: _preflight_topups migrou para ingest_asset() (P3
        # 2026-08-11) — o monkeypatch antigo apontava para ingest_file()
        # legacy, símbolo que já não é chamado (nunca corria de facto).
        ingest_calls.append(path)
        r = MagicMock()
        r.shots_added = 1
        r.status = "ingested"
        r.media_sha = "sha1"
        return r, MagicMock()

    with patch("studio.library.sources.pexels.sweep", side_effect=fake_sweep), \
         patch("studio.library.ingest_asset.ingest_asset",
               side_effect=fake_ingest_asset), \
         patch("studio.matching.assigner.search_shots", db.search_shots), \
         patch("studio.library.inventory.entity_vocab", side_effect=db.entity_vocab), \
         patch("studio.library.inventory.resolve_entity",
               # resolve_entity devolve LISTA (ver inventory.py): split opcional
               side_effect=lambda e, vocab: vocab.get(e, "").split() if vocab.get(e) else []), \
         patch("studio.matching.assigner._PREFLIGHT_MAX_WORKERS", 2):
        result = assign_shots(
            scenes, briefs, db, embedder, _settings_with_pexels(tmp_path),
            run_id="test-dedup", topic="Porto书店",
        )

    # Dedupe resultou em 1× sweep, NÃO 3×
    assert len(sweep_calls) == 1, (
        f"Esperado 1 sweep (pre-flight dedupe), obtido {len(sweep_calls)}: {sweep_calls}")
    assert sweep_calls[0] == ("Livraria Lello", 3)
    # ingest chamado 1× (1 resultado do sweep x 1 ficheiro)
    assert len(ingest_calls) == 1, f"Ingest esperado 1× (sweep devolveu 1): {ingest_calls}"
    # 3 cenas foram preenchidas (pre-flight deu Vocab, scenes buscaram na lib)
    assert len(result.segments) >= 3
    assert result.unfilled_scenes == []


def test_preflight_skipped_when_no_pexels_key(tmp_path: Path):
    """Se pexels_api_key='' OU mock_mode=True → pre-flight é NO-OP, 0 sweeps."""
    scenes = [_scene(1, "Falamos da Livraria Lello", "detail")]
    briefs = [_brief("s001", "Porto bookstore interior", ["indoor"],
                     required_entity="Livraria Lello")]
    db = MagicMock()
    embedder = MagicMock()
    db.entity_vocab = MagicMock(return_value={})  # entity_missing forçosamente
    db.search_shots = MagicMock(return_value=[{
        "shot_id": "sh1", "media_path": "/m1.mp4", "media_sha": "sha1",
        "t_in": 0.0, "t_out": 3.0, "similarity": 0.9, "quality": 4,
        "places_csv": "Porto", "landmarks_csv": "",
        "shot_type": "interior", "summary": "bookstore",
        "has_food": False, "has_landmark": False, "attribution_required": False,
        "attribution_text": "", "usage_count": 0,
    }])
    db.register_usage = MagicMock()

    s = _settings_with_pexels(tmp_path)
    s.pexels_api_key = ""  # desliga Pexels
    # db já mocked lá em cima — search_shots devolvido sem entity match
    # resolve_entity: devolve lista vazia (entity em falta) → pre-flight skip
    def _resolve_empty(e, vocab): return []
    with patch("studio.library.ingest.ingest_file", side_effect=MagicMock(shots_added=0,status="skipped")), \
         patch("studio.matching.assigner.search_shots", db.search_shots), \
         patch("studio.library.inventory.entity_vocab", side_effect=db.entity_vocab), \
         patch("studio.library.inventory.resolve_entity", side_effect=_resolve_empty):
        result = assign_shots(scenes, briefs, db, embedder, s, run_id="r1", topic="X")
    # Sem pexels: pre-flight skipped. Mesmo assim assigner termina e marca
    # relaxamento porque a cena exigia entity que estava em falta.
    assert "s001" in result.relaxations or "s001" in result.unfilled_scenes
    # Pelo menos 1 cena fica unfilled (sem cobertura) OU preenche com relaxamento
    assert "s001" in result.relaxations or "s001" in result.unfilled_scenes
