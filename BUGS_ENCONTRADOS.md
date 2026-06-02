# BUGS ENCONTRADOS (fora do escopo M1–M8)

Bugs graves encontrados durante a auditoria do pipeline. **Não corrigidos ainda** — aguardando aprovação.

---

## BUG-01 — analyze_video.py: análise visual completamente fake

**Arquivo:** `pipeline/tools/video-understanding/analyze_video.py` (linhas 42–73)
**Severidade:** CRÍTICA
**Descrição:** O script nunca analisa frames reais. Retorna dados hardcoded:
- `confidence` sempre `0.22`
- `method` sempre `"weak_fallback"`
- `summary` sempre `"visual evidence unavailable - weak fallback"`
- `quality.sharpness` sempre `0.65`
- `location.city` sempre vazio, `location.confidence` sempre `0`

**Impacto:** Toda análise de cena via `localVideoUnderstandingService.js` retorna resultados sem valor semântico. O pipeline não consegue distinguir visualmente cenas relevantes das irrelevantes.

**Correção sugerida:** Implementar análise real com Gemini Vision (`geminiService.js` já está disponível) ou OpenAI vision (`describeImagesWithOpenAI` em `openaiService.js`).

---

## BUG-02 — utils.py (multivozes_br_engine): `obter_env_bool()` interpreta "false" como True

**Arquivo:** `multivozes_br_engine/utils.py` (linha 11)
**Severidade:** GRAVE
**Descrição:**
```python
def obter_env_bool(nome_variavel, valor_padrao=False):
    valor = os.environ.get(nome_variavel, "").strip().lower()
    return valor in ("yes", "y", "true", "1", "t")
```
A função só verifica se o valor está na lista positiva. `"false"`, `"False"`, `"no"`, `"0"` são strings não-vazias e **não estão na lista** → retornam `False`. Mas qualquer outro valor (como um typo `"treu"`) também retorna `False` sem aviso.

**Impacto:** `REQUIRE_API_KEY=false` funciona corretamente (retorna False), mas `REQUIRE_API_KEY=False` (capital F) também retorna False. O comportamento é correto por acidente, não por design. O real risco é que `REQUIRE_API_KEY=True` (capital T) retorna False (auth bypass).

**Correção sugerida:**
```python
return valor in ("yes", "y", "true", "1", "t") and valor not in ("false", "no", "0", "n", "f")
# ou simplesmente:
if valor in ("true", "1", "yes", "y", "t"): return True
if valor in ("false", "0", "no", "n", "f"): return False
return valor_padrao
```

---

## BUG-03 — main.py (multivozes_br_engine): lógica de autenticação com bypass possível

**Arquivo:** `multivozes_br_engine/main.py` (linhas 35–46)
**Severidade:** MODERADA
**Descrição:**
```python
async def verificar_chave_api(request: Request):
    if not obter_env_bool("REQUIRE_API_KEY"):
        return  # ← retorna sem checar nada
    # só chega aqui se REQUIRE_API_KEY=True
    if not obter_env_bool("REQUIRE_API_KEY") or not CHAVE_API:
        raise HTTPException(...)  # código morto quando REQUIRE_API_KEY=True e CHAVE_API existe
```
A segunda condição `not obter_env_bool("REQUIRE_API_KEY")` é sempre `False` neste branch (já passamos pelo primeiro `if`), tornando o código redundante e confuso.

**Impacto:** Nenhum bypass real em produção com `REQUIRE_API_KEY=True`, mas o código é difícil de auditar e a extração do token Bearer não tem bounds check (`split(" ")[1]` sem verificar tamanho da lista → `IndexError` possível).

**Correção sugerida:** Simplificar para:
```python
async def verificar_chave_api(request: Request):
    if not EXIGIR_CHAVE_API:
        return
    auth_header = request.headers.get("Authorization", "")
    parts = auth_header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or parts[1] != CHAVE_API:
        raise HTTPException(status_code=401, detail="API key inválida")
```

---

## BUG-04 — tts_handler.py: race condition em temp files

**Arquivo:** `multivozes_br_engine/tts_handler.py` (linhas 67, 120–121)
**Severidade:** MODERADA (baixo risco em produção single-instance)
**Descrição:** `gerar_audio()` cria arquivos temporários sem lock. Múltiplas requisições simultâneas podem criar arquivos com mesmo nome base e deletar uns dos outros. Cleanup depende de background tasks que podem não executar se a resposta for interrompida.

**Correção sugerida:** Usar `tempfile.NamedTemporaryFile(delete=False)` com UUID para garantir nomes únicos.

---

*Criado em: 2026-05-28 durante auditoria para implementação de M1–M8*
*Para corrigir algum bug, abrir uma discussão antes de alterar os arquivos afetados.*
