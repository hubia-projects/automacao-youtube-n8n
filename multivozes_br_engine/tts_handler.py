import edge_tts
import os
import traceback
import tempfile
import json # NOVO: Para carregar o ficheiro JSON
import asyncio
from pathlib import Path
from pydub import AudioSegment # NOVO: Para conversão de áudio
from dotenv import load_dotenv

from config import DEFAULT_CONFIGS
from utils import LOG_ERROS_DETALHADO

load_dotenv()

# --- Carregamento de Configurações ---
PROXY = os.getenv("PROXY", None)
EDGE_TTS_ATTEMPTS = max(1, int(os.getenv("EDGE_TTS_ATTEMPTS", "3")))
EDGE_TTS_TIMEOUT_SEC = max(8.0, float(os.getenv("EDGE_TTS_TIMEOUT_SEC", "45")))
EDGE_TTS_RETRY_DELAY_MS = max(100, int(os.getenv("EDGE_TTS_RETRY_DELAY_MS", "600")))

# --- Mapeamento e Dados de Vozes ---

# ALTERADO: Carrega o mapeamento de vozes de um ficheiro JSON externo
def carregar_mapeamento_vozes():
    """Carrega o mapeamento de vozes do ficheiro voices.json."""
    caminho_ficheiro = Path(__file__).parent / "voices.json"
    if not caminho_ficheiro.exists():
        # Retorna um mapeamento padrão caso o ficheiro não exista, para evitar erros
        print("AVISO: Ficheiro 'voices.json' não encontrado. A usar mapeamento padrão.")
        return {
            'alloy': 'pt-BR-FranciscaNeural',
            'echo': 'pt-BR-AntonioNeural',
        }
    with open(caminho_ficheiro, 'r', encoding='utf-8') as f:
        return json.load(f)

MAPEAMENTO_VOZES = carregar_mapeamento_vozes()

# Dados dos modelos para compatibilidade com a API OpenAI
DADOS_MODELOS = [
    {"id": "tts-1", "name": "Text-to-speech v1"},
    {"id": "tts-1-hd", "name": "Text-to-speech v1 HD"},
]

def _voz_invalida(mensagem: str) -> bool:
    texto = str(mensagem or "").lower()
    return "voice" in texto and ("invalid" in texto or "not found" in texto or "unsupported" in texto)

def _lista_vozes_fallback(voz: str):
    candidatos = []
    voz_recebida = str(voz or "").strip()
    voz_mapeada = str(MAPEAMENTO_VOZES.get(voz_recebida, voz_recebida) or "").strip()
    voz_padrao = str(os.getenv('DEFAULT_VOICE', DEFAULT_CONFIGS.get("DEFAULT_VOICE")) or "").strip()
    fallback_alias = str(MAPEAMENTO_VOZES.get("alloy", "pt-BR-FranciscaNeural") or "").strip()
    fallback_hardcoded = ["pt-BR-FranciscaNeural", "pt-BR-AntonioNeural", "pt-BR-ThalitaMultilingualNeural"]
    for item in [voz_mapeada, voz_recebida, voz_padrao, fallback_alias, *fallback_hardcoded]:
        if item and item not in candidatos:
            candidatos.append(item)
    return candidatos

async def _salvar_audio_com_retry(texto: str, vozes, taxa: str, caminho_temp_mp3: str) -> str:
    erros = []
    for voz_edge_tts in vozes:
        for tentativa in range(1, EDGE_TTS_ATTEMPTS + 1):
            try:
                Path(caminho_temp_mp3).unlink(missing_ok=True)
                comunicador = edge_tts.Communicate(texto, voz_edge_tts, rate=taxa, proxy=PROXY)
                await asyncio.wait_for(comunicador.save(caminho_temp_mp3), timeout=EDGE_TTS_TIMEOUT_SEC)
                if Path(caminho_temp_mp3).exists() and Path(caminho_temp_mp3).stat().st_size > 0:
                    return voz_edge_tts
                raise RuntimeError("Audio vazio gerado pelo edge-tts.")
            except Exception as e:
                mensagem = str(e)
                erros.append(f"voz={voz_edge_tts} tentativa={tentativa}: {mensagem}")
                if _voz_invalida(mensagem):
                    break
                if tentativa < EDGE_TTS_ATTEMPTS:
                    await asyncio.sleep((EDGE_TTS_RETRY_DELAY_MS * tentativa) / 1000.0)
    raise RuntimeError("Falha no edge-tts apos retries/fallback de voz. " + " | ".join(erros[-5:]))

def velocidade_para_taxa(velocidade: float) -> str:
    """Converte um multiplicador de velocidade (ex: 1.5) para o formato de taxa do edge-tts (ex: '+50%')."""
    if not 0.25 <= velocidade <= 2.0:
        raise ValueError("A velocidade deve estar entre 0.25 e 2.0.")
    percentagem = int((velocidade - 1) * 100)
    return f"+{percentagem}%" if percentagem >= 0 else f"{percentagem}%"

async def gerar_audio(texto: str, voz: str, formato_resposta: str, velocidade: float) -> str:
    """
    Gera o áudio usando edge-tts (sempre como mp3 inicialmente), e depois converte
    para o formato final desejado, salvando num ficheiro temporário.
    """
    # Verifica se a voz solicitada é um apelido da OpenAI e monta fallback de vozes
    vozes_candidatas = _lista_vozes_fallback(voz)
    taxa = velocidade_para_taxa(velocidade)

    # Cria um ficheiro temporário para a saída inicial do edge-tts (sempre mp3)
    ficheiro_temp_mp3 = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3")
    caminho_temp_mp3 = ficheiro_temp_mp3.name
    ficheiro_temp_mp3.close()

    caminho_final_audio = None # Variável para guardar o caminho do ficheiro final

    try:
        # 1. Gera o áudio com edge-tts e salva como MP3 (com timeout/retry/fallback de voz)
        await _salvar_audio_com_retry(texto, vozes_candidatas, taxa, caminho_temp_mp3)

        # 2. Converte o áudio se o formato de resposta for diferente de mp3
        if formato_resposta.lower() != "mp3":
            # Cria um novo ficheiro temporário para o formato final
            ficheiro_temp_final = tempfile.NamedTemporaryFile(delete=False, suffix=f".{formato_resposta}")
            caminho_final_audio = ficheiro_temp_final.name
            ficheiro_temp_final.close()

            # Usa pydub para carregar o MP3 e exportar no formato desejado
            audio = AudioSegment.from_mp3(caminho_temp_mp3)
            audio.export(caminho_final_audio, format=formato_resposta.lower())
            
            # Remove o ficheiro mp3 intermediário
            Path(caminho_temp_mp3).unlink()
        else:
            # Se o formato for mp3, o ficheiro temporário já é o final
            caminho_final_audio = caminho_temp_mp3

    except Exception as e:
        # Se ocorrer um erro, remove os ficheiros temporários para não deixar lixo
        if caminho_temp_mp3 and Path(caminho_temp_mp3).exists():
            Path(caminho_temp_mp3).unlink(missing_ok=True)
        if caminho_final_audio and Path(caminho_final_audio).exists():
            Path(caminho_final_audio).unlink(missing_ok=True)
            
        if LOG_ERROS_DETALHADO:
            print(f"Erro detalhado em gerar_audio: {traceback.format_exc()}")
        raise RuntimeError(f"Falha ao gerar ou converter áudio: {e}")

    # Retorna o caminho do ficheiro de áudio final
    return caminho_final_audio
