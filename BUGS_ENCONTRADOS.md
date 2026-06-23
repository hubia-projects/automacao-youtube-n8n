# BUGS ENCONTRADOS (fora do escopo M1–M8)

Bugs graves encontrados durante a auditoria do pipeline (2026-05-28). **Todos corrigidos.** ✅

| ID | Severidade | Componente | Data da Correção |
|---|---|---|---|
| BUG-01 | 🔴 CRÍTICA | `analyze_video.py` — análise visual fake | ≈ 2026-06 |
| BUG-02 | 🟠 GRAVE | `utils.py` — `obter_env_bool()` frágil | 2026-06-23 |
| BUG-03 | 🟡 MODERADA | `main.py` — auth com IndexError | 2026-06-23 |
| BUG-04 | 🟡 MODERADA | `tts_handler.py` — race condition temp files | 2026-06-23 |

---

## BUG-01 — analyze_video.py: análise visual completamente fake ✅ CORRIGIDO

**Arquivo:** `pipeline/tools/video-understanding/analyze_video.py`
**Severidade:** CRÍTICA
**Status:** Corrigido. O script foi reescrito com integração real ao Gemini Vision (AI Studio + Vertex AI fallback), extração de frames com FFmpeg, validação de payload e tratamento de erros adequado.
**Data da correção:** ≈ 2026-06 (ver histórico git)

---

## BUG-02 — utils.py (multivozes_br_engine): `obter_env_bool()` com lógica frágil ✅ CORRIGIDO

**Arquivo:** `multivozes_br_engine/utils.py`
**Severidade:** GRAVE
**Status:** Corrigido. A função agora valida explicitamente valores positivos (`true`, `1`, `yes`, `y`, `t`) e negativos (`false`, `0`, `no`, `n`, `f`). Valores desconhecidos disparam um aviso no log e retornam o `valor_padrao` em vez de falharem silenciosamente.
**Data da correção:** 2026-06-23

---

## BUG-03 — main.py (multivozes_br_engine): lógica de autenticação simplificada ✅ CORRIGIDO

**Arquivo:** `multivozes_br_engine/main.py`
**Severidade:** MODERADA
**Status:** Corrigido. O código morto (dupla verificação de `obter_env_bool`) já tinha sido removido. A extração do token foi melhorada: usa `.split(" ", 1)` com bounds check em vez de `split('Bearer ')[1]`, eliminando qualquer risco de `IndexError`. A verificação do header é agora feita numa única condição clara.
**Data da correção:** 2026-06-23

---

## BUG-04 — tts_handler.py: race condition em temp files ✅ CORRIGIDO

**Arquivo:** `multivozes_br_engine/tts_handler.py`
**Severidade:** MODERADA (baixo risco em produção single-instance)
**Status:** Corrigido. A race condition de nomes de ficheiros foi resolvida com `tempfile.NamedTemporaryFile(delete=False)`, que gera nomes únicos automaticamente. Adicionalmente, foi implementado um mecanismo de limpeza fallback via `atexit`: todos os ficheiros temp são registados e limpos no encerramento do processo, cobrindo o caso em que os `background_tasks` do FastAPI não executam (ex: crash).
**Data da correção:** 2026-06-23

---

*Criado em: 2026-05-28 durante auditoria para implementação de M1–M8.*  
*Última atualização: 2026-06-23 — todos os bugs corrigidos e validados.*
