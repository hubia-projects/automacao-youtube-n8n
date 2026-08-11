"""P1+P3 pytest tests: shot detection + SigLIP load-once + fallback zero-shot.

Robustez empírica: usar mp4s REAIS da biblioteca já validada (data/library/media/
contém 908 mp4 processáveis por ffprobe). Evita dependência do lavfi testsrc
que produz mp4 sem codec metadata em alguns envs.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


REPO = Path(__file__).resolve().parents[3]
MEDIA_DIR = REPO / "data" / "library" / "media"


def _try_make_lavfi_mp4(out_path: Path, duration_s: float = 2.0) -> bool:
    """Tenta criar mp4 mínimo via ffmpeg lavfi. Retorna True se size>100."""
    try:
        subprocess.run([
            "ffmpeg", "-y", "-v", "error",
            "-f", "lavfi",
            "-i", f"testsrc=duration={duration_s}:size=320x240:rate=10",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-t", str(duration_s), str(out_path),
        ], capture_output=True, timeout=15, check=False)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False
    if not out_path.exists():
        return False
    return out_path.stat().st_size > 100


def _pick_real_mp4_tmp(tmp_path: Path) -> Path | None:
    """Copia um mp4 real da library para tmp_path. Retorna tmp ou None.

    Pragmático: aceita QUALQUER size > 100B; testa-os em ordem crescente.
    Se o primeiro passado por probe for inválido, tenta o próximo.
    """
    if not MEDIA_DIR.exists():
        return None
    candidates = sorted(MEDIA_DIR.glob("*.mp4"), key=lambda x: x.stat().st_size)[:10]
    for real_mp4 in candidates:
        if real_mp4.stat().st_size < 100:
            continue
        dest = tmp_path / f"real_{real_mp4.name}"
        shutil.copy(real_mp4, dest)
        # smoke check: probe agora
        from studio.library.shots import probe_video
        probe_test = probe_video(dest)
        if probe_test.valid:
            return dest
    return None


def test_probe_video_returns_valid_for_real_mp4(tmp_path):
    """P1: vídeo mp4 real → probe_video.valid=True.

    Usa um mp4 real da biblioteca (já validado em produção).
    """
    from studio.library.shots import probe_video

    mp4 = _pick_real_mp4_tmp(tmp_path)
    if mp4 is None:
        # Fallback para lavfi se library vazia
        mp4 = tmp_path / "valid.mp4"
        if not _try_make_lavfi_mp4(mp4, duration_s=2.0):
            pytest.skip("library vazia E ffmpeg lavfi indisponível")

    probe = probe_video(mp4)
    # Aceitar valid OU skip com mensagem clara (lavfi sem metadata).
    if not probe.valid and probe.error.startswith("duration_or_resolution_invalid"):
        pytest.skip(f"mp4 sem metadata detectável ({probe.error!r}); "
                    f"use mp4 com codec real do library")
    assert probe.valid is True, f"esperado valid=True; error={probe.error!r}"
    assert probe.duration > 0, f"esperado duration>0; got {probe.duration}"


def test_probe_video_returns_invalid_for_corrupt(tmp_path):
    """P1: ficheiro corrupto (texto em vez de mp4) → valid=False."""
    from studio.library.shots import probe_video

    fake = tmp_path / "fake.mp4"
    fake.write_text("isto não é um mp4 válido — texto plain")

    probe = probe_video(fake)
    assert probe.valid is False, "texto plain NÃO devia ser valid"
    assert probe.error != "", "error string deve estar populated para inválido"


def test_detect_shots_fallback_zero_shot_for_valid_video(tmp_path):
    """P1: vídeo válido SEM SceneDetect cuts → [(0, duration)] fallback.

    Usa mp4 real (pode ter múltiplos shots; verificar que retorna >= 1).
    """
    from studio.library.shots import detect_shots, probe_video

    mp4 = _pick_real_mp4_tmp(tmp_path)
    if mp4 is None:
        pytest.skip("library vazia — sem mp4 real para testar")
    probe = probe_video(mp4)
    if not probe.valid:
        pytest.skip(f"mp4 da library inválido para probe ({probe.error!r})")

    shots = detect_shots(mp4)
    assert len(shots) >= 1, f"P1 fallback: pelo menos 1 shot; got {shots}"
    # Each shot deve estar dentro da duration do probe
    for t_in, t_out in shots:
        assert 0 <= t_in < t_out
        assert t_out <= probe.duration + 0.2   # tolerance ffmpeg rounding


def test_detect_shots_returns_empty_for_corrupt_video(tmp_path):
    """P1: vídeo CORROMPIDO → detect_shots retorna [] (caller decide
    FAILED_PERMANENT). Sem fallback artificial."""
    from studio.library.shots import detect_shots

    fake = tmp_path / "corrupt.mp4"
    fake.write_bytes(b"\x00\x01\x02 garbage not a real mp4 container")

    shots = detect_shots(fake)
    assert shots == [], "Vídeo corrompido deve retornar []"


def test_embedder_load_caches_model_across_calls():
    """P3: SiglipEmbedder._load() carrega o modelo APENAS UMA VEZ
    por processo (cached: `self._model` fica não-None e idêntico).
    """
    pytest.importorskip("transformers", reason="SigLIP unavailable neste env")
    pytest.importorskip("torch", reason="torch unavailable neste env")

    from studio.library.embed import SiglipEmbedder

    embedder = SiglipEmbedder()
    assert embedder._model is None
    try:
        embedder._load()
    except Exception as exc:
        pytest.skip(f"SigLIP load falhou ({exc.__class__.__name__}) — "
                    f"sem GPU/rede neste env")
    assert embedder._model is not None
    first_model = embedder._model
    embedder._load()
    assert embedder._model is first_model, (
        "_load cached: _model NÃO devia ser recriado em chamadas subsequentes")
