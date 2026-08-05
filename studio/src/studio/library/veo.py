"""Geração Veo (Gemini API) — ÚLTIMO degrau da escada do matching.

Só corre quando biblioteca + stock + top-up falham numa cena. Regras:
- STUDIO_VEO_ENABLED=1 obrigatório (default OFF — nunca gera por acidente);
- cap STUDIO_VEO_MAX_PER_VIDEO gerações por run;
- clip entra na biblioteca com ai_generated=true no meta_json (YouTube exige
  disclosure de sintético realista) e license=owned;
- nunca gerar pessoas identificáveis nem "provar" monumentos reais.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

import httpx

from studio.config import Settings
from studio.llm.gemini import log_call

log = logging.getLogger("studio.veo")

BASE = "https://generativelanguage.googleapis.com/v1beta"
COST_PER_CLIP_USD = 2.0  # ~8s Veo fast (aprox. p/ ledger)


def generate_clip(prompt_en: str, dest: Path, settings: Settings) -> tuple[Path, float]:
    """Gera ~8s de vídeo. Devolve (ficheiro, custo aprox.). Levanta em falha."""
    resp = httpx.post(
        f"{BASE}/models/{settings.veo_model}:predictLongRunning",
        params={"key": settings.gemini_api_key},
        json={"instances": [{"prompt": prompt_en}],
              "parameters": {"aspectRatio": "16:9"}},
        timeout=60,
    )
    resp.raise_for_status()
    op_name = resp.json()["name"]

    for _ in range(60):  # até ~5 min
        time.sleep(5)
        op = httpx.get(f"{BASE}/{op_name}",
                       params={"key": settings.gemini_api_key}, timeout=30).json()
        if op.get("error"):
            raise RuntimeError(f"Veo falhou: {op['error'].get('message','')[:200]}")
        if op.get("done"):
            videos = (op.get("response", {}).get("generateVideoResponse", {})
                      .get("generatedSamples")
                      or op.get("response", {}).get("generatedVideos") or [])
            if not videos:
                raise RuntimeError("Veo done sem vídeo na resposta")
            uri = (videos[0].get("video", {}).get("uri")
                   or videos[0].get("uri", ""))
            dest.parent.mkdir(parents=True, exist_ok=True)
            with httpx.stream("GET", uri, params={"key": settings.gemini_api_key},
                              timeout=300, follow_redirects=True) as r:
                r.raise_for_status()
                with dest.open("wb") as fh:
                    for chunk in r.iter_bytes(1 << 20):
                        fh.write(chunk)
            log.info("Veo gerou %s (%s)", dest.name, prompt_en[:60])
            log_call(settings, tag="veo_generate", model=settings.veo_model,
                    prompt_tokens=0, output_tokens=0, cost_usd=COST_PER_CLIP_USD)
            return dest, COST_PER_CLIP_USD
    raise RuntimeError("Veo timeout (5 min)")
