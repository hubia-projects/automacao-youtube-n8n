# ADR-0006 — Greenfield Python, não refactor do Node

**Estado:** Aceite · **Data:** 2026-07-12

## Contexto

O pipeline Node tem 71 ficheiros / ~27.700 linhas, dos quais ~10.000 são gates/repair/contract/evidence a combater sintomas do defeito central (matching texto-sobre-texto + pool faminto). Três runners divergentes, estado mutável fail-open, prompts inline, DALL-E fallback morto, SQLite desligado por env var indefinida. O ecossistema necessário à solução (SigLIP, PySceneDetect, faster-whisper, LanceDB, librosa) é Python-first. O motor TTS (multivozes) já é Python.

## Decisão

Reescrita **greenfield em Python 3.12** (pinado via uv; sistema tem 3.14, sem wheels estáveis de torch) num diretório novo `studio/`. O `pipeline/` antigo fica intocado e executável até aos critérios de cutover (ver `ROADMAP.md`).

**Porta-se (lógica comprovada, traduzida):** fluxo OAuth/upload/captions do `youtubeService.js` (incl. QA pré-upload M8); matemática FFmpeg do `renderService.js`; UX de aprovação Telegram; conhecimento de parâmetros Pexels/Pixabay. Media da biblioteca antiga é re-ingerida (metadados regenerados).

**Reescreve-se do zero (explicitamente não portado):** todo o matching/scoring/gates/repair/evidence/contract; gestão de estado; orquestração; todos os prompts (para ficheiros versionados).

## Alternativas rejeitadas

- **Refactor incremental do Node:** manteria a arquitetura texto-sobre-texto; cada melhoria real (embeddings visuais locais, shot detection, beat analysis) lutaria contra o ecossistema. O histórico do repo mostra ~20 commits de fixes sintomáticos sem movimento na causa raiz.
- **Híbrido Python+Node permanente:** dois runtimes para manter para sempre; a fronteira cairia exatamente no meio do fluxo mais quente (matching→render).

## Consequências

- Coexistência: nada partilhado exceto multivozes (HTTP 5050) e credenciais.
- Risco de "segundo sistema" mitigado por fases com testes E2E de saída e coluna explícita de "o que reforma" (ROADMAP).
- Node desaparece por completo no cutover (Fase 7).
