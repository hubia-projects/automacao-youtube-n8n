"""Embeddings visuais — SigLIP-base (ADR-0003).

REGRA: o text tower do SigLIP é English-centric — queries de texto têm de
chegar aqui SEMPRE em inglês (o brief LLM garante isso; ver ADR-0003).

Carga lazy; GPU se disponível (GTX 1050 Ti, 4 GB — nunca co-residente com
whisper: cada fase carrega/descarrega o seu modelo).
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

import numpy as np

MODEL_ID = "google/siglip-base-patch16-384"
DIM = 768


class Embedder(Protocol):
    dim: int

    def embed_images(self, paths: list[Path]) -> np.ndarray: ...
    def embed_text(self, text_en: str) -> np.ndarray: ...


def _normalize(arr: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(arr, axis=-1, keepdims=True)
    return arr / np.clip(norms, 1e-8, None)


def _is_cuda_oom(exc: Exception) -> bool:
    """torch.OutOfMemoryError é a exceção esperada, mas CUDA por vezes
    devolve um RuntimeError genérico com "out of memory" na mensagem —
    apanhar os dois, senão o fallback para CPU nunca dispara."""
    return "out of memory" in str(exc).lower() or type(exc).__name__ == "OutOfMemoryError"


class SiglipEmbedder:
    dim = DIM

    def __init__(self, device: str | None = None):
        self._model = None
        self._processor = None
        self._device = device

    def _load(self):
        if self._model is not None:
            return
        import os

        import torch
        from transformers import AutoModel, AutoProcessor

        self._device = (self._device
                        or os.environ.get("STUDIO_EMBED_DEVICE")
                        or ("cuda" if torch.cuda.is_available() else "cpu"))
        self._processor = AutoProcessor.from_pretrained(MODEL_ID)
        model = AutoModel.from_pretrained(MODEL_ID)
        if self._device == "cuda":
            try:
                model = model.to("cuda")
            except (torch.OutOfMemoryError, RuntimeError) as exc:
                if not _is_cuda_oom(exc):
                    raise
                # VRAM ocupada (desktop partilha os 4 GB) — fallback CPU (ADR-0003)
                import logging

                logging.getLogger("studio.embed").warning(
                    "VRAM insuficiente para SigLIP — fallback para CPU")
                torch.cuda.empty_cache()
                self._device = "cpu"
        self._model = model.to(self._device).eval()

    def _run_with_oom_fallback(self, fn):
        import torch

        try:
            return fn()
        except (torch.OutOfMemoryError, RuntimeError) as exc:
            if not _is_cuda_oom(exc):
                raise
            import logging

            logging.getLogger("studio.embed").warning(
                "CUDA OOM em inferência — a mudar SigLIP para CPU")
            torch.cuda.empty_cache()
            self._device = "cpu"
            self._model = self._model.to("cpu")
            return fn()

    def unload(self):
        """Liberta VRAM (4 GB obrigam a carga sequencial de modelos)."""
        if self._model is not None:
            import torch

            self._model = None
            self._processor = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    def embed_images(self, paths: list[Path]) -> np.ndarray:
        import torch
        from PIL import Image

        self._load()
        images = [Image.open(p).convert("RGB") for p in paths]

        def _run():
            inputs = self._processor(images=images, return_tensors="pt").to(self._device)
            with torch.no_grad():
                feats = self._model.get_image_features(**inputs)
            return _normalize(feats.cpu().numpy().astype(np.float32))

        return self._run_with_oom_fallback(_run)

    def embed_text(self, text_en: str) -> np.ndarray:
        import torch

        self._load()

        def _run():
            # SigLIP foi treinado com padding max_length=64 — obrigatório usar igual
            inputs = self._processor(
                text=[text_en], return_tensors="pt", padding="max_length", max_length=64,
                truncation=True,
            ).to(self._device)
            with torch.no_grad():
                feats = self._model.get_text_features(**inputs)
            return _normalize(feats.cpu().numpy().astype(np.float32))[0]

        return self._run_with_oom_fallback(_run)


def mean_pool(vectors: np.ndarray) -> np.ndarray:
    """Embedding do shot = média normalizada dos keyframes."""
    return _normalize(vectors.mean(axis=0, keepdims=True))[0]
