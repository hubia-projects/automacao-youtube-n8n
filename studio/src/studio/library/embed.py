"""Embeddings visuais — SigLIP-base (ADR-0003) com batching adaptativo (Pass 4).

REGRA: o text tower do SigLIP é English-centric — queries de texto têm de
chegar aqui SEMPRE em inglês (o brief LLM garante isso; ver ADR-0003).

Carga lazy; GPU se disponível (GTX 1050 Ti, 4 GB — nunca co-residente com
whisper: cada fase carrega/descarrega o seu modelo).

Pass 4 — auto-tune (increment-and-decay com **slow-start puro**,
NÃO AIMD-RTT clássico):
- Latência EMA é SÓ observability (não gate de upsize). AIMD-RTT clássico
  faria `upsize só se RTT diminuiu`; aqui NÃO se faz — o efeito seria
  oscilação em chamadas curtas. O design é **slow-start**: dobra sempre
  após sucesso, halva em OOM, com cooldown 2-chunks pós-OOM (TCP loss
  recovery).
- Fast path: se n_paths <= batch_starts OU dynamic=False, UMA inferência
  com semântica original (OOM→CPU fallback em `_run_with_oom_fallback`).
- Auto-tune path: chunked iterativo com `current_batch` adaptativo.
  - Incremento: após cada chunk bem-sucedido → batch *= 2 (cap=batch_cap).
  - Decay: em CUDA OOM → batch //= 2 (floor=batch_starts) + retry chunk
    em halves recursivos até caber (backpressure).
- Latência observada por item registada em EMA (alpha=0.3) — exposta via
  `ema_per_item_ms` para dashboards; em produção, dashboards mostram
  `max_observed_batch`, `backpressure_count`, `chunks_processed` por run.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Protocol

import numpy as np

MODEL_ID = "google/siglip-base-patch16-384"
DIM = 768

log = logging.getLogger("studio.embed")


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

    def __init__(self, device: str | None = None, *,
                 batch_starts: int = 8, batch_cap: int = 64,
                 dynamic: bool = True):
        """SigLIP-base Embedder com batching adaptativo (Pass 4).

        Args:
        - batch_starts: tamanho de batch inicial (probe). 8 default
          (calibrado para GTX 1050 Ti 4 GB). Subir em GPUs topo-de-gama.
        - batch_cap: teto hard do auto-tune. 64 default (calibrado para os
          vídeos 8-min produzidos 2026-07).
        - dynamic: True ⇒ auto-tune iterativo (increment-and-decay).
          False ⇒ batch fixo em batch_starts (modo determinístico para
          testes unitários e produção controlada).
        """
        self._model = None
        self._processor = None
        self._device = device
        # --- Pass 4: batching adaptativo ---
        self._batch_starts = max(1, int(batch_starts))
        self._batch_cap = max(self._batch_starts, int(batch_cap))
        self._dynamic = bool(dynamic)
        self._current_batch = self._batch_starts
        # observability auto-tune (consumida em testes + log structured):
        self._chunks_processed = 0
        self._chunks_since_last_oom = 999  # cooldown-skip só ativo depois do 1º OOM
        self._backpressure_count = 0   # nº de downsize por OOM
        self._oom_count = 0            # nº de OOM apanhados (antes do CPU fallback final)
        self._ema_per_item_ms: float | None = None
        self._max_observed_batch = self._batch_starts

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
                log.warning("VRAM insuficiente para SigLIP — fallback para CPU")
                torch.cuda.empty_cache()
                self._device = "cpu"
        self._model = model.to(self._device).eval()

    def _run_with_oom_fallback(self, fn):
        """Fallback legacy: OOM → move modelo para CPU e re-corre.

        Usado em embed_text + fast path do embed_images (não conflita com
        o auto-tune porque auto-tune path tem o seu próprio halve-retry).
        """
        import torch

        try:
            return fn()
        except (torch.OutOfMemoryError, RuntimeError) as exc:
            if not _is_cuda_oom(exc):
                raise
            log.warning("CUDA OOM em inferência — a mudar SigLIP para CPU")
            torch.cuda.empty_cache()
            self._device = "cpu"
            if self._model is not None:
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

    # ------------------------------------------------------------------
    # API embed:
    # ------------------------------------------------------------------
    def embed_images(self, paths: list[Path]) -> np.ndarray:
        """Embed batched de imagens com auto-tune (Pass 4).

        Fast path (single batch + OOM→CPU fallback): n_paths <= batch_starts
        OU dynamic=False.

        Auto-tune path: chunked com current_batch adaptativo. Decay com
        halve-retry recursivo em CUDA OOM; após exaustão → CPU fallback.
        """
        import time
        from PIL import Image

        n = len(paths)
        if n == 0:
            return np.zeros((0, DIM), dtype=np.float32)

        # Fast path: batch já pequeno, ou auto-tune desligado.
        if not self._dynamic or n <= self._batch_starts:
            return self._infer_single_via_cpu_fallback(list(paths))

        # Auto-tune: itera chunks adaptativamente.
        self._load()
        out_parts: list[np.ndarray] = []
        cursor = 0
        while cursor < n:
            bs = min(self._current_batch, n - cursor)
            chunk = list(paths[cursor:cursor + bs])
            t0 = time.perf_counter()
            try:
                vecs = self._infer_with_backpressure(chunk, depth=0)
            except Exception as exc:
                # backpressure exausta (depth=max ou já em floor=1 item).
                # Log estruturado ANTES do CPU fallback: operador precisa
                # de causa-raiz visível (sem o log, "caiu para CPU" parece
                # evento benigno quando na verdade foi degradação grave).
                if _is_cuda_oom(exc) and self._device == "cuda":
                    log.error("embed_images: backpressure exausta "
                              "(depth=%d, batch=%d, oom_count=%d) — CPU fallback "
                              "como último reduto", self._current_batch,
                              len(chunk), self._oom_count)
                    self._oom_count += 1
                    self._infer_switch_to_cpu()
                    images = [Image.open(p).convert("RGB") for p in chunk]
                    vecs = self._inner_forward(images)
                else:
                    log.error("embed_images: chunk não recuperável (%s); a abortar",
                              exc.__class__.__name__)
                    raise
            elapsed = time.perf_counter() - t0
            self._chunks_processed += 1
            self._max_observed_batch = max(self._max_observed_batch,
                                           min(self._current_batch, n - cursor))
            per_item_ms = (elapsed / bs * 1000.0) if bs > 0 else 0.0
            self._update_ema_ms(per_item_ms)
            out_parts.append(vecs)
            cursor += bs   # todos os itens cobertos (halve-retry completou)
            self._chunks_since_last_oom += 1   # clean chunk → loss-recovery++
            self._maybe_upsize()
        if not out_parts:
            return np.zeros((0, DIM), dtype=np.float32)
        return np.concatenate(out_parts, axis=0)

    def embed_text(self, text_en: str) -> np.ndarray:
        # Mantém semântica original: OOM → CPU fallback nunca halve (texto
        # é 1 item, halve não faz sentido).
        import torch

        self._load()

        def _run():
            inputs = self._processor(
                text=[text_en], return_tensors="pt", padding="max_length", max_length=64,
                truncation=True,
            ).to(self._device)
            with torch.no_grad():
                feats = self._model.get_text_features(**inputs)
            return _normalize(feats.cpu().numpy().astype(np.float32))[0]

        return self._run_with_oom_fallback(_run)

    # ------------------------------------------------------------------
    # API observability (consumida em test_siglip_batching.py + dashboards):
    # ------------------------------------------------------------------
    @property
    def current_batch(self) -> int:
        return self._current_batch

    @property
    def chunks_processed(self) -> int:
        return self._chunks_processed

    @property
    def backpressure_count(self) -> int:
        return self._backpressure_count

    @property
    def oom_count(self) -> int:
        return self._oom_count

    @property
    def max_observed_batch(self) -> int:
        return self._max_observed_batch

    @property
    def chunks_since_last_oom(self) -> int:
        """Chunks processados desde o último OOM (cooldown loss-recovery).

        Code-reviewer Pass 4 close-out: property PÚBLICA exposta (anteriormente
        acesso fragil via __self__). Quando > 0, significa que temos
        chunks limpos consecutivos; quando < 2, _maybe_upsize() bloqueia
        o upsize (TCP loss recovery)."""
        return self._chunks_since_last_oom

    @property
    def ema_per_item_ms(self) -> float | None:
        return self._ema_per_item_ms

    @property
    def batch_starts(self) -> int:
        """Floor do auto-tune (não muda em runtime)."""
        return self._batch_starts

    @property
    def batch_cap(self) -> int:
        """Teto do auto-tune (não muda em runtime)."""
        return self._batch_cap

    def reset_auto_tune(self) -> None:
        """Reset do estado de auto-tune entre runs / em testes."""
        self._current_batch = self._batch_starts
        self._chunks_processed = 0
        self._chunks_since_last_oom = 999   # nunca houve OOM → upsize livre
        self._backpressure_count = 0
        self._oom_count = 0
        self._ema_per_item_ms = None
        self._max_observed_batch = self._batch_starts

    # ------------------------------------------------------------------
    # Internals (auto-tune + backpressure):
    # ------------------------------------------------------------------
    def _update_ema_ms(self, per_item_ms: float) -> None:
        """EMA alpha=0.3: smooth latency tracking, sem oscilar em chunks curtos."""
        alpha = 0.30
        if self._ema_per_item_ms is None:
            self._ema_per_item_ms = per_item_ms
        else:
            self._ema_per_item_ms = (
                alpha * per_item_ms + (1 - alpha) * self._ema_per_item_ms
            )

    def _maybe_upsize(self) -> None:
        """Incremento AIMD-like: dobra até cap com cooldown pós-OOM.

        NÃO é AIMD-RTT clássico (EMA é só observability, não gate). É
        slow-start puro: dobra após cada sucesso, halva em OOM, E congela
        upsize por 2 chunks depois do backpressure (TCP loss recovery).
        Sem cooldown, um único OOM causaria loop infinito 16→32 (OOM)→
        16 (halve) → 32 (upsize) → OOM → ... — feio em logs e ineficiente.
        """
        if not self._dynamic or self._current_batch >= self._batch_cap:
            return
        # Loss recovery: 2 chunks limpos antes de re-tentar upsize.
        if self._chunks_since_last_oom < 2:
            return
        new_batch = min(self._batch_cap, self._current_batch * 2)
        if new_batch > self._current_batch:
            log.debug("embed: upsize %d -> %d (cap=%d, chunks_since_oom=%d)",
                      self._current_batch, new_batch, self._batch_cap,
                      self._chunks_since_last_oom)
            self._current_batch = new_batch

    def _downsize_on_oom(self) -> None:
        """Decay por OOM: halva respeitando floor=batch_starts. Incrementa
        a métrica backpressure_count (uma entrada por downsize) E reseta
        cooldown de upsize (loss recovery em TCP)."""
        new_batch = max(self._batch_starts, self._current_batch // 2)
        log.warning("embed: backpressure OOM — halve %d -> %d (floor=%d)",
                    self._current_batch, new_batch, self._batch_starts)
        self._current_batch = new_batch
        self._backpressure_count += 1
        self._chunks_since_last_oom = 0   # TCP loss-recovery (freeze upsize 2 chunks)

    def _infer_with_backpressure(self, chunk_paths: list[Path], depth: int = 0
                                  ) -> np.ndarray:
        """Embed chunk com halve-retry em CUDA OOM. depth limita recursão
        para não loopar quando batch=1 ainda OOM (CPU fallback parent).

        max_depth é DINÂMICO baseado em batch_cap/batch_starts: cobre 64→32
        →16→8 para cap=64 starts=8 (depth 0..3); para cap=128 starts=8
        sobe para depth 0..4. Sem isto, utilizador que subir cap em .env
        (>64) atinge depth limit sem cobrir floor completo."""
        import math
        max_depth = max(
            3,
            math.ceil(math.log2(max(1, self._batch_cap // self._batch_starts))) + 1,
        )
        from PIL import Image

        try:
            images = [Image.open(p).convert("RGB") for p in chunk_paths]
            return self._inner_forward(images)
        except Exception as exc:
            if not _is_cuda_oom(exc) or not self._dynamic or depth >= max_depth:
                # Não-recuperável ou já no topo: propaga.
                self._oom_count += 1
                raise
            self._oom_count += 1
            self._downsize_on_oom()
            try:
                import torch
                torch.cuda.empty_cache()
            except Exception:
                pass
            mid = max(1, len(chunk_paths) // 2)
            if mid >= len(chunk_paths):
                # já no mínimo (1 item, ainda OOM) — propaga para CPU fallback parent
                raise
            first = self._infer_with_backpressure(chunk_paths[:mid], depth=depth + 1)
            second = self._infer_with_backpressure(chunk_paths[mid:], depth=depth + 1)
            if first.shape[0] == 0:
                return second
            if second.shape[0] == 0:
                return first
            return np.concatenate([first, second], axis=0)

    def _infer_single_via_cpu_fallback(self, paths: list[Path]) -> np.ndarray:
        """Fast path: UMA inferência com OOM→CPU fallback legacy.

        Para batches pequenos que não justifica overhead de auto-tune.
        Não chama auto-tune loop nem halve-retry.
        """
        from PIL import Image

        self._load()
        if not paths:
            return np.zeros((0, DIM), dtype=np.float32)
        images = [Image.open(p).convert("RGB") for p in paths]
        return self._run_with_oom_fallback(
            lambda: self._inner_forward(images)
        )

    def _infer_switch_to_cpu(self) -> None:
        """Move o modelo atual para CPU (last-resort fallback)."""
        import torch

        try:
            torch.cuda.empty_cache()
        except Exception:
            pass
        if self._model is not None and self._device != "cpu":
            self._model = self._model.to("cpu")
            self._device = "cpu"

    def _inner_forward(self, images):
        """Forward puro (sem fallback). Propaga OOM/erro ao caller."""
        import torch

        inputs = self._processor(images=images, return_tensors="pt").to(self._device)
        with torch.no_grad():
            feats = self._model.get_image_features(**inputs)
        return _normalize(feats.cpu().numpy().astype(np.float32))


def mean_pool(vectors: np.ndarray) -> np.ndarray:
    """Embedding do shot = média normalizada dos keyframes."""
    return _normalize(vectors.mean(axis=0, keepdims=True))[0]
