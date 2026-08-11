"""Diagnóstico de latência Gemini (custo ~$0.001 por chamada).

Testa:
  1) gemini-flash-latest texto-only      (latência base da conta/key)
  2) gemini-2.5-flash texto-only         (alias estável vs -latest)
  3) gemini-flash-latest + 1 imagem 384px (vision real, 1 keyframe)
  4) gemini-flash-latest + 3 imagens     (replica analyze_shot)

Cada chamada tem cap de 150s. Mostra o ledger gemini_calls.jsonl (últimas 10).

Uso: uv run python scripts/diag_gemini_latency.py
"""
from __future__ import annotations

import base64
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from studio.config import get_settings
from studio.library.embed import SiglipEmbedder

URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def log(msg: str) -> None:
    print(f"{datetime.now().strftime('%H:%M:%S')}  {msg}", flush=True)


def call(model: str, parts: list[dict], cap_s: float = 150.0) -> tuple[float, dict]:
    settings = get_settings()
    t0 = time.perf_counter()
    try:
        resp = httpx.post(
            URL.format(model=model),
            params={"key": settings.gemini_api_key},
            json={"contents": [{"parts": parts}],
                  "generationConfig": {"response_mime_type": "application/json",
                                       "temperature": 0.1}},
            timeout=httpx.Timeout(connect=15.0, read=cap_s, write=30.0, pool=30.0),
        )
        dt = time.perf_counter() - t0
        body = resp.json() if resp.status_code == 200 else {"err": resp.text[:200]}
        return dt, {"status": resp.status_code, "body": body}
    except Exception as exc:
        return time.perf_counter() - t0, {"status": "EXC", "err": f"{type(exc).__name__}: {exc}"}


def main() -> None:
    settings = get_settings()
    log(f"api_key presente: {bool(settings.gemini_api_key)}  "
        f"model_flash={settings.model_flash}  mock={settings.mock_mode}")

    # 1) texto-only no modelo default
    dt, r = call(settings.model_flash, [{"text": "responde apenas: ok"}])
    log(f"1) texto-only {settings.model_flash}: {dt:.1f}s -> {r['status']}")

    # 2) texto-only num modelo estável (se diferente)
    alt = "gemini-2.5-flash" if settings.model_flash != "gemini-2.5-flash" else "gemini-flash-latest"
    dt, r = call(alt, [{"text": "responde apenas: ok"}])
    log(f"2) texto-only {alt}: {dt:.1f}s -> {r['status']}")

    # 3+4) vision com 1 e 3 keyframes reais
    emb = SiglipEmbedder()
    import subprocess
    media = Path("../data/library/media")
    cand = sorted(media.glob("*.mp4"))[0]
    tmp = Path("/tmp/diag_kf")
    tmp.mkdir(exist_ok=True)
    for i in range(3):
        t = i * 3.0
        out = tmp / f"kf_{i}.jpg"
        if not out.exists():
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.1f}", "-i", str(cand),
                 "-frames:v", "1",
                 "-vf", "scale=384:384:force_original_aspect_ratio=increase,crop=384:384",
                 str(out)], check=True, capture_output=True)
    b64 = [{"inline_data": {"mime_type": "image/jpeg",
                            "data": base64.b64encode(p.read_bytes()).decode()}}
           for p in sorted(tmp.glob("kf_*.jpg"))]
    log(f"payload: {len(b64)} keyframes, {sum(len(p['inline_data']['data']) for p in b64)//1024} KB base64")

    dt, r = call(settings.model_flash, [{"text": "describe the image in JSON"},
                                        b64[0]])
    log(f"3) vision 1 img {settings.model_flash}: {dt:.1f}s -> {r['status']}")

    dt, r = call(settings.model_flash, [{"text": "describe the images in JSON"},
                                        *b64])
    log(f"4) vision 3 imgs {settings.model_flash}: {dt:.1f}s -> {r['status']}")

    # ledger
    ledger = settings.data_root / "gemini_calls.jsonl"
    if ledger.exists():
        lines = ledger.read_text().strip().splitlines()
        log(f"ledger: {len(lines)} chamadas totais; últimas 8:")
        for ln in lines[-8:]:
            try:
                d = json.loads(ln)
                log(f"  {d.get('at','')} tag={d.get('tag','')} model={d.get('model','')} "
                    f"prompt_tok={d.get('prompt_tokens')} cost=${d.get('cost_usd_estimate')}")
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
