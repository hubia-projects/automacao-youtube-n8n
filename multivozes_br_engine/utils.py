import logging
import os
from dotenv import load_dotenv
from config import DEFAULT_CONFIGS

# Carrega as variáveis de ambiente do ficheiro .env
load_dotenv()

def obter_env_bool(nome_variavel: str, valor_padrao: bool = False) -> bool:
    """Lê uma variável de ambiente e a converte para um valor booleano.

    Valores reconhecidos como True:  "true", "1", "yes", "y", "t"
    Valores reconhecidos como False: "false", "0", "no", "n", "f"
    Qualquer outro valor (ex: typo "treu", "flase") dispara um aviso no log
    e retorna o valor_padrao.
    """
    valor = os.getenv(nome_variavel, str(valor_padrao)).strip().lower()
    if valor in ("true", "1", "yes", "y", "t"):
        return True
    if valor in ("false", "0", "no", "n", "f"):
        return False
    # Valor desconhecido: loga aviso e retorna o padrão para não causar
    # bypass de segurança silencioso.
    if valor:
        logging.warning(
            "obter_env_bool: valor desconhecido %s=%r — usando valor_padrao=%s",
            nome_variavel,
            os.getenv(nome_variavel, ""),
            valor_padrao,
        )
    return valor_padrao

# --- Carrega as configurações a partir das variáveis de ambiente ou dos padrões ---
CHAVE_API = os.getenv('API_KEY', DEFAULT_CONFIGS.get("API_KEY"))
EXIGIR_CHAVE_API = obter_env_bool('REQUIRE_API_KEY', DEFAULT_CONFIGS.get("REQUIRE_API_KEY"))
LOG_ERROS_DETALHADO = obter_env_bool('DETAILED_ERROR_LOGGING', DEFAULT_CONFIGS.get("DETAILED_ERROR_LOGGING"))

# Dicionário com os tipos MIME para cada formato de áudio suportado.
TIPOS_MIME_AUDIO = {
    "mp3": "audio/mpeg",
    "opus": "audio/opus",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "wav": "audio/wav",
    "pcm": "audio/L16"
}

