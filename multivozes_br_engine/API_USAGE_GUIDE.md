# 🚀 Guia de Uso da API e Exemplos

Este guia mostra como interagir diretamente com a API do **Multivozes BR Engine** para gerar áudio.

---

### 📌 Endpoint Principal: `/v1/audio/speech`

#### Parâmetros da Requisição (JSON)

* `input` (obrigatório): O texto a ser convertido.
* `model` (opcional): `"tts-1"` ou `"tts-1-hd"`.
* `voice` (opcional): Um apelido (`alloy`, `echo`) ou nome técnico (`pt-BR-ThalitaMultilingualNeural`). Usa o padrão do `.env` se não for especificado.
* `response_format` (opcional): `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`. Padrão é `mp3`.
* `speed` (opcional): Velocidade da fala (`1.0` = normal).

---

### 🛠️ Exemplos Práticos com `curl`

**Lembre-se:** Substitua `SUA_CHAVE_API_AQUI` e o `localhost` se necessário.

#### Exemplo 1: Gerar um Áudio com Voz Multilingual

Vamos usar a nova voz da Thalita, que fala português e outros idiomas.

```bash
curl -X POST http://localhost:5050/v1/audio/speech \
  -H "Authorization: Bearer SUA_CHAVE_API_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tts-1",
    "input": "Olá, eu sou a Thalita, uma voz multilíngue. Hello, I can also speak English.",
    "voice": "alloy"
  }' \
  --output audio_multilingual.mp3
```

#### Exemplo 2: Gerar um Áudio no formato FLAC

Solicitando um formato de áudio de alta qualidade sem perdas.

```bash
curl -X POST http://localhost:5050/v1/audio/speech \
  -H "Authorization: Bearer SUA_CHAVE_API_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Este áudio será gerado no formato FLAC. This is an audio in FLAC",
    "voice": "echo",
    "response_format": "flac"
  }' \
  --output audio.flac
```

---

### 🐍 Exemplo de Uso em Python

Um script simples para chamar a API e salvar o ficheiro de áudio.

```python
import requests
import shutil

# --- Configurações ---
API_URL = "http://localhost:5050/v1/audio/speech"
API_KEY = "SUA_CHAVE_API_AQUI"
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}
DATA = {
    "model": "tts-1",
    "input": "Este áudio foi gerado a partir de um script Python!",
    "voice": "shimmer"
}
OUTPUT_FILE = "audio_from_python.mp3"

# --- Fazendo a Requisição ---
try:
    response = requests.post(API_URL, headers=HEADERS, json=DATA, stream=True)

    if response.status_code == 200:
        print(f"Sucesso! A salvar o áudio em '{OUTPUT_FILE}'...")
        with open(OUTPUT_FILE, 'wb') as f:
            shutil.copyfileobj(response.raw, f)
        print("Áudio salvo com sucesso!")
    else:
        print(f"Erro ao gerar áudio: {response.status_code} - {response.text}")

except requests.exceptions.RequestException as e:

    print(f"Erro de conexão: {e}")

