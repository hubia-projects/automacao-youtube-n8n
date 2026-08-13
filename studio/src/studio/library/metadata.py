"""Metadados estruturados por shot — Gemini Flash vision (ARCHITECTURE.md §6).

Mock mode: heurística por nome de ficheiro (determinística, para testes).
Prompt versionado em prompts/vision/shot_metadata.v1.md.

UPSTREAM-CHANGE 2026-08-11 §P2-P4:
  analyze_shots_batch agora tem:
  - 1 Gemini HTTP call por batch (já tinha).
  - Rate-limit wired: acquire() pré-HTTP via GeminiRateLimiter singleton.
  - 429 handling SEM fan-out: report_rate_limit(retry_after) → retry BATCH
    intacto (settings.library_gemini_max_retries). Sem retry budget
    disponível → todos os shots do batch = METADATA_INCOMPLETE (NÃO
    fan-out per-shot que transformaria throttling em tempestade).
  - Split progressivo SÓ em parse/timeout/tamanho:
      len(shots)==1 → METADATA_INCOMPLETE (stop recursion).
      senão → mid=len//2, left+right recursivo.
  - Profiler categorias novas: gemini_queue_wait (acquire do token),
    gemini_rate_limit_wait (sleep após 429 antes de retry), gemini_http,
    gemini_parse (json.loads).
"""

from __future__ import annotations

import base64
import json
import logging
import time
from pathlib import Path

import httpx
from pydantic import BaseModel, Field

from studio.config import Settings
from studio.llm.gemini import log_call
from studio.perf import Profiler
from studio.library.rate_limit import get_gemini_limiter

log = logging.getLogger("studio.metadata")

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


# === P13 (2026-08-11) — Gemini actual HTTP telemetry (REAL, não logical) ====
# Singleton que conta cada httpx.post REAL disparado por este módulo,
# categorizado por 4xx (fail-fast) / 429 (retry-after) / 5xx (bounded) /
# parse fail (split progressivo). Test 11/12/13 validam.
class _GeminiTelemetry:
    actual_http_requests: int = 0
    actual_http_4xx_failfast: int = 0
    actual_http_429_retries: int = 0
    actual_http_5xx_retries: int = 0
    actual_retries: int = 0
    actual_parsed_failed: int = 0
    actual_split_count: int = 0
    actual_queue_wait_s: float = 0.0
    actual_rate_limit_wait_s: float = 0.0
    actual_http_s: float = 0.0

    def as_dict(self) -> dict:
        return {
            "actual_http_requests": self.actual_http_requests,
            "actual_http_4xx_failfast": self.actual_http_4xx_failfast,
            "actual_http_429_retries": self.actual_http_429_retries,
            "actual_http_5xx_retries": self.actual_http_5xx_retries,
            "actual_retries": self.actual_retries,
            "actual_parsed_failed": self.actual_parsed_failed,
            "actual_split_count": self.actual_split_count,
            "actual_queue_wait_s": round(self.actual_queue_wait_s, 3),
            "actual_rate_limit_wait_s": round(self.actual_rate_limit_wait_s, 3),
            "actual_http_s": round(self.actual_http_s, 3),
        }


_GEMINI_TELEMETRY: _GeminiTelemetry | None = None


def get_gemini_telemetry() -> _GeminiTelemetry:
    global _GEMINI_TELEMETRY
    if _GEMINI_TELEMETRY is None:
        _GEMINI_TELEMETRY = _GeminiTelemetry()
    return _GEMINI_TELEMETRY


def reset_gemini_telemetry() -> None:
    global _GEMINI_TELEMETRY
    _GEMINI_TELEMETRY = _GeminiTelemetry()
# Preços Gemini 2.5 Flash (aprox., para o ledger)
_USD_IN, _USD_OUT = 0.15 / 1e6, 0.60 / 1e6


class ShotAnalysisError(RuntimeError):
    """Vision devolveu output inutilizável — o shot é saltado (não o ficheiro)."""


class ShotMetadata(BaseModel):
    summary: str = ""
    places: list[str] = Field(default_factory=list)
    landmarks: list[str] = Field(default_factory=list)
    food_items: list[str] = Field(default_factory=list)
    objects: list[str] = Field(default_factory=list)
    ocr_text: str = ""
    shot_type: str = "medium"
    camera_motion: str = "static"
    time_of_day: str = "day"
    indoor_outdoor: str = "outdoor"
    people_present: bool = False
    quality: int = 5
    defects: list[str] = Field(default_factory=list)

    @property
    def has_food(self) -> bool:
        return bool(self.food_items)

    @property
    def has_landmark(self) -> bool:
        return bool(self.landmarks)


def _prompt(settings: Settings) -> str:
    return (settings.prompts_root / "vision" / "shot_metadata.v1.md").read_text("utf-8")


def _mock_metadata(keyframes: list[Path], source_hint: str = "") -> ShotMetadata:
    """Determinística por nome de ficheiro — só para testes/mock."""
    hint = (source_hint + " " + (keyframes[0].as_posix() if keyframes else "")).lower()
    meta = ShotMetadata(summary=f"mock shot from {hint}", quality=7)
    if "food" in hint or "pastel" in hint or "bacalhau" in hint:
        meta.food_items = ["mock dish"]
        meta.objects = ["plate", "table"]
        meta.shot_type = "close-up"
        meta.indoor_outdoor = "indoor"
    if "monument" in hint or "tower" in hint or "church" in hint:
        meta.landmarks = ["Mock Monument"]
        meta.shot_type = "wide"
    return meta


def analyze_shot(keyframes: list[Path], settings: Settings,
                 source_hint: str = "") -> tuple[ShotMetadata, float]:
    """Devolve (metadados, custo_usd). source_hint = nome do media original
    (usado apenas pelo mock determinístico).

    NÃO tem rate-limit wired por design: este é o caminho legacy/per-shot.
    Em produção, callers devem usar analyze_shots_batch (com rate-limit).
    """
    if settings.mock_mode or not settings.gemini_api_key:
        return _mock_metadata(keyframes, source_hint), 0.0

    parts: list[dict] = [{"text": _prompt(settings)}]
    for kf in keyframes:
        parts.append({
            "inline_data": {
                "mime_type": "image/jpeg",
                "data": base64.b64encode(kf.read_bytes()).decode(),
            }
        })

    total_cost = 0.0
    last_err: Exception | None = None
    for temperature in (0.1, 0.0):
        resp = httpx.post(
            GEMINI_URL.format(model=settings.model_flash),
            params={"key": settings.gemini_api_key},
            json={
                "contents": [{"parts": parts}],
                "generationConfig": {
                    "response_mime_type": "application/json",
                    "temperature": temperature,
                },
            },
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        usage = data.get("usageMetadata", {})
        prompt_tokens = usage.get("promptTokenCount", 0)
        output_tokens = usage.get("candidatesTokenCount", 0)
        step_cost = prompt_tokens * _USD_IN + output_tokens * _USD_OUT
        total_cost += step_cost
        log_call(settings, tag="library_vision", model=settings.model_flash,
                prompt_tokens=prompt_tokens, output_tokens=output_tokens,
                cost_usd=step_cost)
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        try:
            return ShotMetadata.model_validate(json.loads(text)), total_cost
        except (json.JSONDecodeError, ValueError) as exc:
            last_err = exc
            log.warning("metadados JSON inválido (temp=%s): %s", temperature, exc)
    raise ShotAnalysisError(f"JSON inválido após retry: {last_err}")


# ==========================================================================
# Fase 2C — Batched metadata analysis COM rate-limit + 429 retry + split
# ==========================================================================
# Design (2026-08-11 §P2-P4):
#   - Mock: per-shot analyze_shot (compat).
#   - Real:
#       * limiter.acquire() antes de HTTP. FAIL-FAST se CB aberto.
#       * HTTP 200: parse → summary != "" && has_evidence → ShotMetadata.
#                   shot_id missing → METADATA_INCOMPLETE (NÃO copiar de outro).
#       * HTTP 429: limiter.report_rate_limit(retry_after).
#                   retry BATCH intacto se attempt < settings.library_gemini_max_retries.
#                   caso contrário: TODOS shots do batch = METADATA_INCOMPLETE.
#       * Parse/timeout/KeyError/IndexError: SPLIT halves recursivo (NÃO
#         confundir com 429). Stop condição: len(shots)==1 → stop, devolve
#         {sid: (None, 0.0)} (i.e. METADATA_INCOMPLETE).
#   - Cost ledger proporcional (mesma heurística).
#
# Profiler categorias:
#   - gemini_queue_wait (acquire do token, primeiro request)
#   - gemini_rate_limit_wait (sleep após 429 antes de retry)
#   - gemini_http (httpx.post)
#   - gemini_parse (json.loads devolvido)
#   - gemini_metadata (caller-side total; mantido em ingest.py)

SPLIT_OVERLOAD_RECURSION_MAX = 6   # log2(64) → safe para batch_size até 64


def analyze_shots_batch(
    shots: list[tuple[str, list[Path]]],
    settings: Settings,
    *,
    source_hint: str = "",
) -> dict[str, tuple[ShotMetadata | None, float]]:
    """Batched metadata analysis — 1 Gemini HTTP call por chunk com rate-limit.

    Returns:
        dict[shot_id -> (ShotMetadata|None, cost_usd)].

        None no valor significa METADATA_INCOMPLETE para esse shot
        (Gemini não respondeu — NÃO copiamos metadata de outro shot).
    """
    out: dict[str, tuple[ShotMetadata | None, float]] = {}
    if not shots:
        return out

    # mock_mode → compat: per-shot mock determinístico.
    if settings.mock_mode or not settings.gemini_api_key:
        return _per_shot_fallback(shots, settings, source_hint)

    return _gemini_batched_with_retry(shots, settings, source_hint, attempt=0)


# -----------------------------------------------------------------------------
# Helpers internos (rate-limit + 429 retry + split progressivo)
# -----------------------------------------------------------------------------
def _gemini_batched_with_retry(
    shots: list[tuple[str, list[Path]]],
    settings: Settings,
    source_hint: str,
    *,
    attempt: int = 0,
) -> dict[str, tuple[ShotMetadata | None, float]]:
    """1 batch HTTP call com rate-limit + recursão de split para parse.

    Args:
        shots: lista (shot_id, keyframes) ainda por resolver.
        attempt: contador de retries em 429 (até settings.library_gemini_max_retries).
                 NÃO usado para split (split usa recursion depth).

    Returns:
        dict[shot_id -> (ShotMetadata|None, cost_usd)].
    """
    out: dict[str, tuple[ShotMetadata | None, float]] = {}
    if not shots:
        return out

    limiter = get_gemini_limiter(settings)

    # 1) acquire token — mede gemini_queue_wait (esperar pelo token do bucket).
    t_qwait = time.perf_counter()
    if not limiter.acquire(timeout=30.0):
        # CB aberto (cb_open_until ativo) — fail-fast sem gastar HTTP quota.
        log.warning("_gemini_batched_with_retry: circuit breaker open — "
                    "fail-fast para %d shots (não chamamos Gemini)", len(shots))
        for sid, _ks in shots:
            out[sid] = (None, 0.0)
            log.debug("shot_cb_open_incomplete: %s (circuit-breaker deny)", sid)
        return out
    Profiler.record("gemini_queue_wait", time.perf_counter() - t_qwait, items=len(shots))

    # 2) construir prompt + parts ensemble
    prompt_text = (
        _prompt(settings)
        + "\n\nFor EACH [shot_id=...] block below, output ONE JSON object\n"
        + "(all inside a single JSON array). Required keys per object:\n"
        + "  shot_id: string,\n"
        + "  summary, places[], landmarks[], food_items[], objects[],\n"
        + "  ocr_text, shot_type, camera_motion, time_of_day,\n"
        + "  indoor_outdoor, people_present (bool), quality (int 1-10),\n"
        + "  defects[].\n\n"
        + "CRITICAL: do NOT copy metadata from one shot to another. If a shot\n"
        + "is unreadable or you cannot analyse it, return only that entry\n"
        + 'with summary = "METADATA_INCOMPLETE".\n\n'
        + "Image order matches [shot_id=...]:\n"
    )
    parts: list[dict] = [{"text": prompt_text}]
    for sid, kfs in shots:
        parts.append({"text": f"\n[shot_id={sid}]"})
        for kf in kfs:
            parts.append({
                "inline_data": {
                    "mime_type": "image/jpeg",
                    "data": base64.b64encode(kf.read_bytes()).decode(),
                }
            })

    # 3) HTTP call (P13: telemetry REAL — não logical ceil(N/batch_size))
    t_http = time.perf_counter()
    _t = get_gemini_telemetry()
    try:
        resp = httpx.post(
            GEMINI_URL.format(model=settings.model_flash),
            params={"key": settings.gemini_api_key},
            json={
                "contents": [{"parts": parts}],
                "generationConfig": {
                    "response_mime_type": "application/json",
                    "temperature": 0.1,
                },
            },
            timeout=120,
        )
        # P13 (2026-08-11): incrementa telemetry com categoria REAL (4xx/429/5xx).
        _t.actual_http_requests += 1
        if 400 <= resp.status_code < 500 and resp.status_code != 429:
            _t.actual_http_4xx_failfast += 1     # 401/403/404 fail-fast policy
        elif resp.status_code == 429:
            _t.actual_http_429_retries += 1       # counted in retry loop below
            _t.actual_retries += 1
        elif resp.status_code >= 500:
            _t.actual_http_5xx_retries += 1
            _t.actual_retries += 1
    except (httpx.HTTPError, httpx.TimeoutException) as exc:
        # Network/timeout → SPLIT (parse/timeout path), NÃO fan-out per-shot.
        _t.actual_http_requests += 1
        _t.actual_http_s += time.perf_counter() - t_http
        Profiler.record("gemini_http", time.perf_counter() - t_http, items=len(shots))
        log.warning("_gemini_batched_with_retry: HTTP fail (%s) — split halves",
                    exc.__class__.__name__)
        _t.actual_split_count += 1
        return _split_on_failure(shots, settings, source_hint, reason=f"http:{exc.__class__.__name__}")

    Profiler.record("gemini_http", time.perf_counter() - t_http, items=len(shots))
    _t.actual_http_s += time.perf_counter() - t_http

    # BUG CORRIGIDO (item M — closure pass): 401/403/404/... (4xx permanente,
    # excepto 429) já incrementava actual_http_4xx_failfast acima, mas
    # depois caía no MESMO `_split_on_failure` progressivo (8→4+4→2+2→1)
    # usado para timeouts/parse errors — um erro de credencial/permissão
    # gastava N chamadas HTTP redundantes (todas com o mesmo 403) antes de
    # desistir. Um erro permanente não melhora ao dividir o batch: fail-fast
    # com 1 única request, sem split, sem fan-out per-shot.
    if 400 <= resp.status_code < 500 and resp.status_code != 429:
        log.error("_gemini_batched_with_retry: status %d (4xx permanente) — "
                  "fail-fast, %d shots METADATA_INCOMPLETE (1 request, "
                  "sem split)", resp.status_code, len(shots))
        for sid, _ks in shots:
            out[sid] = (None, 0.0)
        return out

    # 4) 429 → retry BATCH (NÃO split).
    if resp.status_code == 429:
        retry_after = _parse_retry_after(resp.headers)
        limiter.report_rate_limit(retry_after)
        # UPSTREAM-FIX 2026-08-11 (code-reviewer #1): off-by-one corrigido.
        # Semântica: max_retries=N significa N retries APÓS initial (total
        # N+1 HTTP calls). attempt=0 é initial; attempt<N são retries.
        if attempt < max(0, settings.library_gemini_max_retries):
            # gemini_rate_limit_wait = tempo de espera antes de retry
            t_rl = time.perf_counter()
            sleep_for = retry_after if (retry_after is not None and retry_after > 0) else 1.0
            time.sleep(min(sleep_for, 30.0))  # cap para não travar run indefinido
            Profiler.record("gemini_rate_limit_wait",
                            time.perf_counter() - t_rl, items=1)
            log.info("analyze_shots_batch: 429 retry batch "
                     "attempt=%d/%d after %.1fs",
                     attempt + 1, settings.library_gemini_max_retries, sleep_for)
            return _gemini_batched_with_retry(
                shots, settings, source_hint, attempt=attempt + 1)
        # retry budget exhausted → NUNCA fan-out per-shot. FAIL e sinaliza.
        log.error("analyze_shots_batch: 429 exhausted retry budget (%d) — "
                  "todos os %d shots do batch são METADATA_INCOMPLETE",
                  settings.library_gemini_max_retries, len(shots))
        for sid, _ks in shots:
            out[sid] = (None, 0.0)
        return out

    # item 16 (automation closure): 5xx é erro do SERVIDOR, não do payload —
    # dividir o batch não melhora nada (o mesmo problema persiste em
    # metade); antes disto caía no mesmo `_split_on_failure` de parse/
    # timeout. Retry BOUNDED da MESMA batch (espelha o branch 429 acima);
    # ao esgotar, METADATA_INCOMPLETE — nunca split por causa de 5xx.
    if resp.status_code >= 500:
        if attempt < max(0, settings.library_gemini_max_retries):
            t_rl = time.perf_counter()
            sleep_for = min(2.0 * (attempt + 1), 30.0)
            time.sleep(sleep_for)
            Profiler.record("gemini_5xx_retry_wait",
                            time.perf_counter() - t_rl, items=1)
            log.warning("_gemini_batched_with_retry: HTTP %d (5xx) retry "
                       "SAME batch attempt=%d/%d after %.1fs",
                       resp.status_code, attempt + 1,
                       settings.library_gemini_max_retries, sleep_for)
            return _gemini_batched_with_retry(
                shots, settings, source_hint, attempt=attempt + 1)
        log.error("_gemini_batched_with_retry: 5xx exhausted retry budget "
                  "(%d) — %d shots METADATA_INCOMPLETE (sem split)",
                  settings.library_gemini_max_retries, len(shots))
        for sid, _ks in shots:
            out[sid] = (None, 0.0)
        return out

    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        log.warning("_gemini_batched_with_retry: status %d — split halves",
                    resp.status_code)
        return _split_on_failure(shots, settings, source_hint,
                                reason=f"http_status:{resp.status_code}")

    # 5) 200 → parse + validate per-entry
    try:
        data = resp.json()
    except (json.JSONDecodeError, ValueError) as exc:
        # UPSTREAM-CHANGE 2026-08-11 (code-reviewer #5): Profiler category
        # renameada para distinguir gemini_http_decode (HTTP-level JSON parse
        # do response envelope) vs gemini_text_parse (Gemini text payload JSON).
        # Mantemos `gemini_parse` como alias para NÃO quebrar consumidores
        # legacy que aggregam em performance.json.
        Profiler.record("gemini_http_decode",
                        time.perf_counter() - t_http, items=len(shots))
        Profiler.record("gemini_parse",
                        time.perf_counter() - t_http, items=len(shots))
        log.warning("_gemini_batched_with_retry: JSONDecodeError (%s) — split halves",
                    exc.__class__.__name__)
        return _split_on_failure(shots, settings, source_hint,
                                reason=f"json_decode:{exc.__class__.__name__}")

    limiter.report_success()
    t_parse = time.perf_counter()
    usage = data.get("usageMetadata", {})
    prompt_tokens = int(usage.get("promptTokenCount", 0))
    output_tokens = int(usage.get("candidatesTokenCount", 0))
    total_cost = prompt_tokens * _USD_IN + output_tokens * _USD_OUT
    log_call(settings, tag="library_vision_batch", model=settings.model_flash,
             prompt_tokens=prompt_tokens, output_tokens=output_tokens,
             cost_usd=total_cost,
             # shots_in_batch tracking em Profiler.record (gemini_metadata);
             # não duplicamos no log_call que não aceita kwarg.
    )

    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as exc:
        log.warning("_gemini_batched_with_retry: response shape (%s) — split halves",
                    exc.__class__.__name__)
        return _split_on_failure(shots, settings, source_hint,
                                reason=f"shape:{exc.__class__.__name__}")

    t_inner_parse = time.perf_counter()
    try:
        items = json.loads(text)
    except (json.JSONDecodeError, ValueError) as exc:
        log.warning("_gemini_batched_with_retry: Gemini text parse fail (%s) — split halves",
                    exc.__class__.__name__)
        return _split_on_failure(shots, settings, source_hint,
                                reason=f"text_json:{exc.__class__.__name__}")
    # UPSTREAM-CHANGE 2026-08-11 (code-reviewer #5): rename gemini_parse →
    # gemini_text_parse (Gemini text payload JSON, distinto de envelope).
    # Mantemos `gemini_parse` como alias para compat com consumidores legacy.
    Profiler.record("gemini_text_parse",
                    time.perf_counter() - t_inner_parse, items=1)
    Profiler.record("gemini_parse",
                    time.perf_counter() - t_inner_parse, items=1)

    if isinstance(items, dict):
        items = [items]   # tolerate single-entry shape
    if not isinstance(items, list):
        log.warning("_gemini_batched_with_retry: response tipo inesperado %s — split",
                    type(items).__name__)
        return _split_on_failure(shots, settings, source_hint, reason="type_unexpected")

    shot_ids = [sid for sid, _ in shots]
    matched = 0
    for entry in items:
        if not isinstance(entry, dict):
            continue
        sid = str(entry.get("shot_id") or entry.get("id") or "")
        if not sid or sid not in shot_ids:
            continue
        try:
            summary_v = (entry.get("summary") or "").strip()
            evidence_v = any([
                entry.get("places") or [],
                entry.get("landmarks") or [],
                entry.get("food_items") or [],
                entry.get("objects") or [],
            ])
            if summary_v == "METADATA_INCOMPLETE" or not summary_v:
                out[sid] = (None, 0.0)
                continue
            meta = ShotMetadata.model_validate(entry)
            if not evidence_v:
                out[sid] = (None, 0.0)
                continue
            out[sid] = (meta, round(total_cost / max(len(shot_ids), 1), 6))
            matched += 1
        except Exception as exc:
            log.debug("_gemini_batched_with_retry: validate '%s' falhou (%s) — "
                      "METADATA_INCOMPLETE para esse shot",
                      sid, exc.__class__.__name__)
            out[sid] = (None, 0.0)
    # shots não devolvidos na resposta → METADATA_INCOMPLETE explícito
    # NÃO copiar metadata de outro shot (regra de segurança).
    for sid in shot_ids:
        if sid not in out:
            out[sid] = (None, 0.0)
    return out


# NOTA 2026-08-11 (code-reviewer dead-code-fix):
# O helper `t_http_prior()` + ref `_t_http_prior_ref` foram REMOVIDOS — eram
# vestígios de uma versão anterior que fazia t_http em dois pontos. Agora
# usamos uma única medição `t_http` no local do httpx.post.


def _split_on_failure(
    shots: list[tuple[str, list[Path]]],
    settings: Settings,
    source_hint: str,
    *,
    reason: str,
    depth: int = 0,
) -> dict[str, tuple[ShotMetadata | None, float]]:
    """Split halves recursivo em parse/timeout/tamanho/shape. NÃO em 429.

    Stop condition: len(shots)==1 OR depth >= SPLIT_OVERLOAD_RECURSION_MAX (=6,
    cobre batch até 64 shots = log2(64) = 6 split levels). Para batches
    maiores (raro), o stop no max depth dispara METADATA_INCOMPLETE — log
    explícito no caller.

    Quando stop: cada shot fica METADATA_INCOMPLETE (None, 0.0).
    """
    if len(shots) == 1 or depth >= SPLIT_OVERLOAD_RECURSION_MAX:
        out: dict[str, tuple[ShotMetadata | None, float]] = {}
        for sid, _ks in shots:
            out[sid] = (None, 0.0)
        log.warning("_split_on_failure: stop (depth=%d, n_shots=%d, reason=%s)",
                    depth, len(shots), reason)
        return out
    mid = len(shots) // 2
    log.info("_split_on_failure: split %d → %d + %d (reason=%s, depth=%d)",
             len(shots), mid, len(shots) - mid, reason, depth)
    # FIX 2026-08-11 (code-reviewer §P3): sub-batches do split começam SEMPRE
    # com attempt=0. O `depth` não tem relação com 429-retry-budget; tentar
    # um sub-batch com `attempt=depth` herdaria o contador de retry do
    # parent e poderia esgotar budget cedo em chains 429-induced. Os dois
    # namespaces (split-depth vs 429-attempt) ficam isolados.
    left = _gemini_batched_with_retry(shots[:mid], settings, source_hint, attempt=0)
    right = _gemini_batched_with_retry(shots[mid:], settings, source_hint, attempt=0)
    return {**left, **right}


def _parse_retry_after(headers) -> float | None:
    """Parse Retry-After header (seconds ou HTTP-date)."""
    try:
        v = headers.get("retry-after") if headers else None
    except Exception:
        return None
    if not v:
        return None
    try:
        return max(0.0, float(v))
    except (TypeError, ValueError):
        return None


def _per_shot_fallback(
    shots: list[tuple[str, list[Path]]],
    settings: Settings,
    source_hint: str,
    *,
    original_exc=None,
) -> dict[str, tuple[ShotMetadata | None, float]]:
    """Fallback gracioso: per-shot analyze_shot() APENAS para mock_mode
    (ou settings sem gemini_api_key). NÃO é invocado em 429/parse failure
    pelo analyze_shots_batch (substituído por split recursivo)."""
    out: dict[str, tuple[ShotMetadata | None, float]] = {}
    if original_exc is not None:
        log.info("_per_shot_fallback activado (motivo: %s / %s) — %d shots",
                 original_exc.__class__.__name__ if hasattr(original_exc, "__class__") else type(original_exc).__name__,
                 str(original_exc)[:120], len(shots))
    for sid, kfs in shots:
        try:
            sm, cost = analyze_shot(kfs, settings, source_hint=source_hint)
            out[sid] = (sm, cost)
        except Exception as exc:
            log.debug("_per_shot_fallback: '%s' falhou (%s) — METADATA_INCOMPLETE",
                      sid, exc.__class__.__name__)
            out[sid] = (None, 0.0)
    return out


# ============== Fase E — Metadata Confidence ==============
class DetectedEntity(BaseModel):
    """Resultado estruturado de Vision Gemini Flash sobre keyframes.

    confidence: 0..1 (≥ settings.entity_confirm_min_confidence → confirmado).
    evidence: lista de strings ("OCR: 'Lello'", "visual: iconic staircase",
               "metadata: Exif date 2025"). Mínimo 3 evidências para high conf.
    rejected: True ⇒ confirm_shot_entity() rejeitou (motivo em rejection_reason).
    infra_failure: item 15 (automation closure) — True ⇒ este `rejected=True`
        veio de uma falha de INFRA (rede, timeout, parse, circuit breaker,
        helper ausente), NÃO de Vision ter visto o shot e decidido que a
        entity não está presente. Distinção crítica: um `rejected` genuíno
        nunca deve ser re-tentado (RequirementIndex.CS_REJECTED); uma falha
        de infra deve poder ser re-tentada em runs futuras
        (RequirementIndex.CS_FAILED_RETRYABLE). Antes desta distinção, TODOS
        os caminhos de falha marcavam `rejected=True` indistintamente —
        um erro de rede permanecia "rejeitado para sempre" no cache/index.
    """
    name: str = ""
    entity_type: str = ""
    confidence: float = 0.0
    evidence: list[str] = Field(default_factory=list)
    rejected: bool = False
    rejection_reason: str = ""
    infra_failure: bool = False
    confirmed_by: str = ""  # "gemini-flash" / "metadata-only" / "cache"
    at: str = ""  # ISO timestamp

    def is_confirmed(self, threshold: float) -> bool:
        return (not self.rejected
                and self.confidence >= threshold
                and bool(self.name))
