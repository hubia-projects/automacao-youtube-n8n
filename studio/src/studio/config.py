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
    whisper_model: str = Field(default="large-v3-turbo", alias="STUDIO_WHISPER_MODEL")
    whisper_device: str = Field(default="cpu", alias="STUDIO_WHISPER_DEVICE")

    # --- Roteiro ---
    words_per_minute: int = Field(default=145, alias="STUDIO_WPM")

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
