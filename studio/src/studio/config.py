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
    whisper_device: str = Field(default="cpu", alias="STUDIO_WHISPER_DEVICE")

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

    @property
    def runs_root(self) -> Path:
        return self.data_root / "runs"

    @property
    def library_root(self) -> Path:
        return self.data_root / "library"


@lru_cache
def get_settings() -> Settings:
    return Settings()
