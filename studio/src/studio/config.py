"""Configuração central (Pydantic Settings).

Lê o .env da raiz do repositório (partilhado com o pipeline legacy) e permite
override via STUDIO_ENV_FILE. Nenhum outro módulo lê variáveis de ambiente
diretamente — tudo passa por Settings.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# studio/src/studio/config.py → raiz do repo = 3 níveis acima de src/
STUDIO_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = STUDIO_ROOT.parent


def _env_file() -> Path:
    override = os.environ.get("STUDIO_ENV_FILE")
    if override:
        return Path(override)
    return REPO_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_env_file(),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    # --- Modo de execução ---
    # mock_mode: nenhum serviço externo é contactado; gates auto-aprovam.
    mock_mode: bool = Field(default=False, alias="STUDIO_MOCK")
    # auto_approve_gates: gate humano prossegue sem Telegram, mas mantém
    # todos os serviços externos reais (Gemini, review, render). Tunado
    # para runs conduzidos por agente / cron — override no shell via
    # `STUDIO_AUTO_APPROVE_GATES=1 uv run studio ...`. NÃO colocar
    # permanentemente no .env (voltar a humano quando voltar a operar).
    auto_approve_gates: bool = Field(default=False, alias="STUDIO_AUTO_APPROVE_GATES")

    # --- Caminhos ---
    data_root: Path = Field(default=REPO_ROOT / "data", alias="STUDIO_DATA_ROOT")
    prompts_root: Path = STUDIO_ROOT / "prompts"

    # --- Orçamento (doutrina fail-closed: exceder = parar) ---
    budget_usd_per_run: float = Field(default=15.0, alias="STUDIO_BUDGET_USD")

    # --- Credenciais LLM ---
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")

    # --- Vertex AI (rota preferencial quando disponível) ---
    # True = Gemini via Vertex AI (service account, projeto GCP dedicado);
    # False = Gemini AI Studio direto (?key= na query string).
    # FAIL-LOUD: quando True, NÃO há fallback silencioso para AI Studio —
    # Vertex indisponível = raise (apaga-se o billing cross-account e o
    # data-residency cross-project que era a razão de usar Vertex).
    gemini_vertex_enabled: bool = Field(default=False, alias="GEMINI_VERTEX_ENABLED")
    # ID do projeto GCP onde o Vertex AI está habilitado. Vazio +
    # gemini_vertex_enabled=True = erro na primeira chamada.
    google_cloud_project: str = Field(default="", alias="GOOGLE_CLOUD_PROJECT")
    # Região Vertex (us-central1 default; europe-west4 se cliente exigir
    # data-residency na UE). Endpoint URL deriva desta var.
    google_cloud_location: str = Field(
        default="us-central1", alias="GOOGLE_CLOUD_LOCATION")
    # Path absoluto para o ficheiro JSON da service account (NÃO o PEM
    # inline). O `.env` tem GOOGLE_APPLICATION_CREDENTIALS=/caminho/*.json.
    google_application_credentials: str = Field(
        default="", alias="GOOGLE_APPLICATION_CREDENTIALS")
    google_service_account_email: str = Field(
        default="", alias="GOOGLE_SERVICE_ACCOUNT_EMAIL")

    # --- Telegram (gates humanos) ---
    telegram_bot_token: str = Field(default="", alias="TELEGRAM_BOT_TOKEN")
    telegram_chat_id: str = Field(default="", alias="TELEGRAM_CHAT_ID")
    telegram_poll_interval_s: float = Field(default=3.0, alias="STUDIO_TELEGRAM_POLL_S")
    telegram_gate_timeout_s: float = Field(default=86400.0, alias="STUDIO_GATE_TIMEOUT_S")

    # --- Fontes de footage ---
    pexels_api_key: str = Field(default="", alias="PEXELS_API_KEY")
    pixabay_api_key: str = Field(default="", alias="PIXABAY_API_KEY")
    vimeo_client_id: str = Field(default="", alias="VIMEO_CLIENT_ID")
    vimeo_client_secret: str = Field(default="", alias="VIMEO_CLIENT_SECRET")
    # Veo (geração de vídeo) — último degrau do matching; OFF até smoke real
    veo_enabled: bool = Field(default=False, alias="STUDIO_VEO_ENABLED")
    veo_model: str = Field(default="veo-3.1-fast-generate-001", alias="STUDIO_VEO_MODEL")
    veo_max_per_video: int = Field(default=4, alias="STUDIO_VEO_MAX_PER_VIDEO")

    # --- TTS local ---
    multivozes_base_url: str = Field(
        default="http://localhost:5050/v1", alias="MULTIVOZES_BR_BASE_URL"
    )
    multivozes_api_key: str = Field(default="", alias="MULTIVOZES_BR_ENGINE")
    tts_voice: str = Field(default="pt-BR-AntonioNeural", alias="STUDIO_TTS_VOICE")
    elevenlabs_api_key: str = Field(default="", alias="ELEVENLABS_API_KEY")
    elevenlabs_voice_id: str = Field(default="", alias="ELEVENLABS_VOICE_ID")

    # --- Whisper local (faster-whisper) ---
    # Fase 1B: default 'base' (~75MB, ms-accuracy suficiente para A/V sync).
    # 'large-v3-turbo' ainda disponível via STUDIO_WHISPER_MODEL=large-v3-turbo
    # em .env (24GB VRAM obrigatórios; útil em GPUs topo-de-gama).
    whisper_model: str = Field(default="base", alias="STUDIO_WHISPER_MODEL")
    # Fase 1 — Whisper device. 3 modos explícitos:
    #   "auto" (default): detecta CUDA via torch.cuda.is_available(); cai
    #     para CPU se indisponível (compatibilidade Pascal + hosts sem GPU).
    #   "cuda": força CUDA; se indisponível/erro na inicialização do
    #     faster-whisper, faz fail-closed (não finge GPU) com log claro.
    #   "cpu": força CPU.
    whisper_device: str = Field(default="auto", alias="STUDIO_WHISPER_DEVICE")

    # --- Roteiro ---
    words_per_minute: int = Field(default=145, alias="STUDIO_WPM")

    # --- Fase C — Coverage Plan ---
    # 1.25 = a biblioteca precisa ter 25% a mais do que o mínimo exigido
    # (cobrir fades + duplicação segura para relaxações no matching). Ajustar
    # conservadoramente: subir = cobre mais redundância mas top-up mais caro.
    coverage_buffer: float = Field(default=1.25, alias="STUDIO_COVERAGE_BUFFER")
    # 8.0 s = cada shot cobre em média ~8s no timeline (calibrado nos vídeos
    # 8 min produzidos em 2026-07). min_distinct_shots = ceil(required_s / 8).
    min_shots_by_duration: float = Field(
        default=8.0, alias="STUDIO_MIN_SHOTS_DURATION")
    # 4 = níveis de pesquisa: entity+features → entity+location → entity
    # → contexto genérico. Menos = queries mais barulhentas; mais = ruído.
    query_levels: int = Field(default=4, alias="STUDIO_QUERY_LEVELS")

    # --- Fase E — Metadata Confidence via Vision ---
    # 0.85 = somente shots com confiança >=85% contam como "confirmados".
    # Abaixo disso → rejeitados do matching de entity strict. Ajustar
    # conservadoramente: subir = mais rigoroso mas menos shots disponíveis.
    entity_confirm_min_confidence: float = Field(
        default=0.85, alias="STUDIO_ENTITY_CONFIRM_MIN_CONFIDENCE")
    # 4 = máximo de shots a confirmar numa única chamada Vision batched
    # (Vision Flash aceita multi-imagem; abaixo do limite = I/O eficiente).
    entity_confirm_max_k: int = Field(
        default=4, alias="STUDIO_ENTITY_CONFIRM_MAX_K")
    # False = shots rejeitados (confidence < limiar) NÃO podem ser
    # reutilizados noutras cenas strict. True = reuse permitido (modo
    # permissivo, útil quando a biblioteca é pequena).
    entity_reuse_allowed: bool = Field(
        default=False, alias="STUDIO_ENTITY_REUSE_ALLOWED")

    # --- Fase F — Strict Matching: pesos do _score (SSoT) ---
    # Antes eram constantes hardcoded no assigner; agora são Settings para
    # afinação sem tocar lógica. DEFAULTS == valores pré-Fase F (regressão
    # byte-igual em runs sem confirmação / sem Fase F).
    # 1.0 = peso da similaridade ANN (baseline do ranking).
    assign_score_similarity: float = Field(
        default=1.0, alias="STUDIO_ASSIGN_SCORE_SIMILARITY")
    # 0.02 = bónus por ponto de quality (0-10) do shot.
    assign_score_quality_bonus: float = Field(
        default=0.02, alias="STUDIO_ASSIGN_SCORE_QUALITY_BONUS")
    # 0.15 = cooldown entre vídeos (usage_count) — penaliza shots repetidos.
    assign_score_usage_cooldown: float = Field(
        default=0.15, alias="STUDIO_ASSIGN_SCORE_USAGE_COOLDOWN")
    # 0.10 = diversidade de fonte (mesmo ficheiro usado N vezes neste vídeo).
    assign_score_source_diversity: float = Field(
        default=0.10, alias="STUDIO_ASSIGN_SCORE_SOURCE_DIVERSITY")
    # 0.20 = bónus entity em landmarks_csv (match preciso);
    # 0.15 = bónus menor quando só places_csv tem a entity.
    assign_score_entity_match_bonus: float = Field(
        default=0.20, alias="STUDIO_ASSIGN_SCORE_ENTITY_MATCH_BONUS")
    assign_score_entity_match_place_bonus: float = Field(
        default=0.15, alias="STUDIO_ASSIGN_SCORE_ENTITY_MATCH_PLACE_BONUS")
    # 0.10 = penalidade por entity pedida mas ausente nos metadados do shot.
    assign_score_entity_miss_penalty: float = Field(
        default=0.10, alias="STUDIO_ASSIGN_SCORE_ENTITY_MISS_PENALTY")
    # 0.15 = bónus por shot CONFIRMADO pelo oráculo Vision (DetectedEntity
    # ≥ limiar) — Fase F. Só se aplica em cenas strict (confirmed_ids).
    assign_score_confirmation_bonus: float = Field(
        default=0.15, alias="STUDIO_ASSIGN_SCORE_CONFIRMATION_BONUS")
    # 0.30 = penalidade por geografia errada (metadados citam lugar
    # excluído — segunda linha de defesa atrás do filtro duro do search).
    assign_score_geography_penalty: float = Field(
        default=0.30, alias="STUDIO_ASSIGN_SCORE_GEOGRAPHY_PENALTY")

    # --- Fase G — Entity Alignment Validator + Repair Loop ---
    # 2 = até duas rondas de repair após a 1ª passage (rematch excluindo
    # shots rejeitados + targeted top-up para entity_coverage_gap).
    # Subir = mais resiliência mas pode esticar timings em vídeos longos.
    alignment_max_repair_rounds: int = Field(
        default=2, alias="STUDIO_ALIGNMENT_MAX_REPAIR_ROUNDS")
    # 1 = mínimo nº de rondas em que o loop tenta melhorar. Não descer:
    # 0 = falha imediata ao 1º strict violation, sem hipótese de recovery.
    alignment_min_rounds_in_repair: int = Field(
        default=1, alias="STUDIO_ALIGNMENT_MIN_REPAIR_ROUNDS")
    # "strict" = só violações com severity "strict" entram no repair loop;
    # "warning" (não recomendado para produção) = warning também.
    # Não tocar — strict é o que reportamos para o repair.
    alignment_min_severity: str = Field(
        default="strict", alias="STUDIO_ALIGNMENT_MIN_SEVERITY")
    # 4 = nº máx de shots a confirmar no warm-up do S08 (Fase F). Subir =
    # pool certificado maior, mas mais $Vision por run. Vai ter de bater
    # certo com entity_confirm_max_k na estrutura de cache.
    s08_warmup_top_k: int = Field(
        default=4, alias="STUDIO_S08_WARMUP_TOP_K")
    # True ⇒ devolve o assignment.json v1 (1ª tentativa) antes do repair
    # para auditoria. False em DEBUG se quiseres esconder artefactos.
    alignment_keep_assignment_v1: bool = Field(
        default=True, alias="STUDIO_ALIGNMENT_KEEP_V1")
    # 0.5 s = limiar mínimo de overlap entre um segmento e 2 EntitySpans
    # strict em simultâneo para reportar `segment_crosses_entity_boundary`.
    # Subir = mais tolerância a mudanças rápidas de entity (menos FP).
    # Descer = mais sensível (mais violações). 0.5 tunado para vídeos 8 min.
    alignment_boundary_overlap_min_s: float = Field(
        default=0.5, alias="STUDIO_ALIGNMENT_BOUNDARY_OVERLAP_MIN_S")
    # 0.05 s = tolerância a arredondamentos de Whisper para considerar
    # "intersecção" entre dois intervalos. Mantém conservador (sub-second).
    alignment_time_epsilon_s: float = Field(
        default=0.05, alias="STUDIO_ALIGNMENT_TIME_EPSILON_S")

    # --- Render ---
    output_width: int = Field(default=1920, alias="STUDIO_OUTPUT_WIDTH")
    output_height: int = Field(default=1080, alias="STUDIO_OUTPUT_HEIGHT")
    render_preset: str = Field(default="medium", alias="STUDIO_RENDER_PRESET")
    burn_captions: bool = Field(default=False, alias="STUDIO_BURN_CAPTIONS")

    # --- Fase 1 Optimização — perf instrumentation + render parallel + DAG ---
    # True ⇒ escreve <run>/performance.json + linha resumo PERF; quase
    # zero overhead (time.perf_counter + agregador thread-safe).
    perf_enabled: bool = Field(default=True, alias="STUDIO_PERF_ENABLED")
    # 2 = nº de workers ffmpeg para render paralelo de segmentos
    # (Fase 3). NÃO subir sem benchmarking real — cada worker compete por
    # CPU + I/O; > 4 normalmente piora wall-clock em vez de melhorar.
    render_segment_workers: int = Field(
        default=2, alias="STUDIO_RENDER_SEGMENT_WORKERS")
    # 8 KB chunks para hashing SHA-256 no ingest — equilíbrio entre
    # syscalls e velocidade (testes mostraram 64 KB não muda throughput).
    ingest_sha_chunk_bytes: int = Field(
        default=1 << 20, alias="STUDIO_INGEST_SHA_CHUNK_BYTES")
    # 128 MB = limiar para skipping SceneDetect em ficheiros tão
    # grandes (cost ~30s/vídeo em testes 2026-08-08 Porto real). Ainda
    # ingerir o ficheiro (shots=0) caso SceneDetect falhe — explica
    # a queda de cobertura no S08 sem o ficheiro aparecer.
    ingest_max_scene_detect_bytes: int = Field(
        default=128 << 20, alias="STUDIO_INGEST_MAX_SCENEDETECT_BYTES")

    # --- YouTube (mesmas credenciais do pipeline legacy) ---
    youtube_client_id: str = Field(default="", alias="YOUTUBE_CLIENT_ID")
    youtube_client_secret: str = Field(default="", alias="YOUTUBE_CLIENT_SECRET")
    youtube_refresh_token: str = Field(default="", alias="YOUTUBE_REFRESH_TOKEN")
    youtube_default_privacy: str = Field(default="private", alias="YOUTUBE_DEFAULT_PRIVACY")

    # --- Routing de modelos (IDs em config, nunca em código) ---
    # aliases *-latest: imunes a renames/descontinuações (2.5-pro deu 404 a novos users)
    model_pro: str = Field(default="gemini-pro-latest", alias="STUDIO_MODEL_PRO")
    model_flash: str = Field(default="gemini-flash-latest", alias="STUDIO_MODEL_FLASH")
    model_humanize: str = Field(default="gpt-4o", alias="STUDIO_MODEL_HUMANIZE")

    # --- Fase 2 Optimização — aquisição + ingest producer/consumer ---
    # 2 = download workers (I/O bound, network). Subir se Pexels latency
    # alto; descer se rate-limit começar a aparecer nos logs.
    topup_dl_workers: int = Field(default=2, ge=1, alias="STUDIO_TOPUP_DL_WORKERS")
    # 1 = ingest workers. `ge=1` garante >=1 worker (0 crasha). `le=1` é
    # CAP RÍGIDO POR DETERMINISMO: qualquer ingest worker >1 quebra a ordem
    # canónica do S08 (keyframe batching = ordem de inserção LanceDB).
    # Trade-off VRAM (4GB GTX 1050 Ti) é independente — não é motivo para
    # >1; subir quebra em silêncio. Pydantic reject em runtime é melhor
    # que determinismo corrompido no output.
    topup_ingest_workers: int = Field(
        default=1, ge=1, le=1, alias="STUDIO_TOPUP_INGEST_WORKERS")
    # 32 = maxsize da queue.Queue entre download workers e ingest worker.
    # Backpressure automática: downloads pausam quando ingest worker lento.
    # NÃO subir acima de 64 (memory pressure com downloads 50-100MB).
    topup_queue_max: int = Field(default=32, ge=1, alias="STUDIO_TOPUP_QUEUE_MAX")
    # 5.0 = palpite calibrado com vídeos 8 min produzidos 2026-07 (cada
    # asset Pexels cobre em média ~5s no timeline após cobertas cenas
    # restantes). Usado em topup.py micro_batch_count() para dimensionar
    # nº de downloads pelo deficit real. Subir = pede menos assets por
    # round; descer = pede mais (mas tem hard_max=5 clamp).
    topup_asset_useful_s_default: float = Field(
        default=5.0, ge=0.1, alias="STUDIO_TOPUP_ASSET_USEFUL_S_DEFAULT")
    # 8 = batch_size inicial do SigLIP (Pass 4). Auto-tune iterativo
    # increment-and-decay (AIMD-like) em embed.py sobe até o cap=64 em
    # ~3 chunks de sucesso. Floor seguro para GTX 1050 Ti 4 GB VRAM
    # (calibrado arranque 2026-08) — subir em GPUs topo-de-gama via
    # STUDIO_INGEST_BATCH_SIZE_START no .env.
    ingest_batch_size_start: int = Field(
        default=8, alias="STUDIO_INGEST_BATCH_SIZE_START")
    # 64 = batch_size max (Pass 4). Teto hard do auto-tune para SigLIP.
    # Subir implica VRAM >= 6 GB + benchmark real (não mexer sem teste).
    ingest_batch_size_max: int = Field(
        default=64, alias="STUDIO_INGEST_BATCH_SIZE_MAX")
    # 720 = resolução mínima aceitável (paisagem). Rejeitar abaixo (mobile /
    # thumbnails / shorts verticais re-encodeados).
    early_reject_min_resolution: int = Field(
        default=720, alias="STUDIO_EARLY_REJECT_MIN_RESOLUTION")
    # 2.0 = duração mínima do ficheiro em segundos. Rejeitar abaixo
    # (giros curtos, B-roll sem narrativa).
    early_reject_min_duration_s: float = Field(
        default=2.0, alias="STUDIO_EARLY_REJECT_MIN_DURATION_S")
    # 90 dias = TTL para a provider_cache. Após o TTL, o item é candidato
    # a re-fetch (mantém-se rejeitado se Vision voltar a rejeitar).
    negative_cache_ttl_days: int = Field(
        default=90, alias="STUDIO_NEGATIVE_CACHE_TTL_DAYS")
    # True = buckets.py update_topic_hit NÃO copia MP4 para bucket/shots/.
    # Cada MP4 vive UMA única vez em media/<sha>.<ext>; o workset guarda
    # apenas referências (shot_id + media_sha) em topic_topics.json e
    # selected_shots.json. False = legacy: mantém cópia física para
    # retro-compatibilidade com runs/workspaces antigos.
    # Migrar para True em novos worksets (default desde 2026-08-11).
    bucket_logical_only: bool = Field(
        default=True, alias="STUDIO_BUCKET_LOGICAL_ONLY")

    @property
    def runs_root(self) -> Path:
        return self.data_root / "runs"

    @property
    def library_root(self) -> Path:
        return self.data_root / "library"


@lru_cache
def get_settings() -> Settings:
    return Settings()
