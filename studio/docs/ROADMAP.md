# ROADMAP — Studio v2

**Versão:** 1.0 · **Data:** 2026-07-12
Fases dimensionadas por milestones coerentes, não por tempo. Cada fase só fecha quando o teste E2E de saída passa. A coluna "Reforma" lista o que do sistema antigo deixa de ser necessário — nada é apagado antes do cutover (Fase 7).

---

## Fases

### Fase 0 — Documentação (esta entrega)
- **Entrega:** `PRD.md`, `ARCHITECTURE.md`, `ADR/0001–0006`, `ROADMAP.md`, `LIBRARY_POLICY.md`.
- **Verificação:** leitura e aprovação pelo utilizador.
- **Reforma:** —

### Fase 1 — Skeleton + orquestrador + estado
- **Entrega:** pacote `studio` (uv, Python 3.12), CLI (`run|resume|ingest|approve|status`), protocolo Stage, runner com skip/resume, `RunState` + cost ledger (Pydantic, escrita atómica), config Pydantic Settings, bot Telegram (enviar + botões inline), LLM router com budget breaker.
- **Teste E2E:** pipeline dummy de 3 stages: stage 2 falha → `studio resume` completa sem refazer o stage 1; round-trip aprovar/rejeitar no Telegram.
- **Reforma:** o *padrão* dos 3 runners divergentes.

### Fase 2 — Ingestão + biblioteca + busca vetorial
- **Entrega:** shot detection (PySceneDetect), embeddings SigLIP, metadados Gemini Flash vision, schema LanceDB, registo de licenças fail-closed, fontes Pexels/Pixabay + watch folder + yt-dlp CC, busca híbrida, `studio ingest`. **Seed: ≥ 2.000 shots do nicho.**
- **Teste E2E:** query "prato de bacalhau em close-up" (via brief EN) devolve comida e zero monumentos no top-10 (verificado em contact sheet); re-ingerir o mesmo ficheiro é no-op; asset sem licença é rejeitado.
- **Reforma:** `assetQueryPlanner` (dicionários keyword), `clipLibraryService`, caches JSON de embeddings/vision.

### Fase 3 — Roteiro + áudio
- **Entrega:** research pack grounded, roteiro multi-pass (outline→draft→critique→humanize), lint anti-slop determinístico, cliente multivozes, faster-whisper large-v3-turbo int8, segmentação de cenas (silêncio + frase + beat tagging LLM).
- **Teste E2E:** tema → roteiro aprovado → `narration.wav` + `words.json` + `scenes.json`; drift de timestamps < 80 ms em 5 frases verificadas à mão; roteiro passa o lint.
- **Reforma:** `scriptService`, `ttsService`, Whisper cloud (custo), `audioIntelligence`.

### Fase 4 — Matching + timeline
- **Entrega:** briefs visuais, retrieval híbrido, filtros duros must_not, scoring, MMR + histórico de uso, fitting de duração por beat, beat grid musical (librosa), `timeline.json`.
- **Teste E2E (regressão direta do bug monumento/comida):** script real de 12 min → 0 cenas por preencher, 0 shots duplicados, **toda** a cena de comida tem shot com `food_items != []` (check mecânico sobre metadados).
- **Reforma:** `semanticMatcher`, `timelinePlanner` (2.821 linhas), `contentSlotPlanner`, `coverageGate`, `diversityGuard`, stack visual-contract/evidence (~10k linhas).

### Fase 5 — Render + pós-produção
- **Entrega:** builder de filtergraph tipado, taxonomia de transições, Ken Burns v2 dirigido por metadados, LUTs, sidechain ducking, legendas ASS, chapter cards, cache de segmentos, renders proxy + final.
- **Teste E2E:** render de timeline fixture em proxy e final; loudness -14 ±0.5 LUFS medido; cortes no beat ±180 ms (check scriptado); humano vê 1 vídeo completo.
- **Reforma:** `renderService`, `overlayService`, `captionsService`, `renderQualityService`.

### Fase 6 — Loop revisor
- **Entrega:** upload de proxy à Gemini Files API, rubrica, executor de fixes (replace_shot via re-matching, trims, transições), loop de 2 rondas com monotonicidade, verificação por contact sheets, gate final Telegram com relatório.
- **Teste E2E (sabotagem):** atribuir deliberadamente um shot de monumento a uma cena de comida → o revisor tem de sinalizar **essa** cena com `replace_shot`; o loop corrige; score final ≥ 90.
- **Reforma:** `editorialQaService`, `repairPlanner*`, `timelineRepair*`, `manualReviewService`, `syncValidator`.

### Fase 7 — Upload + publicação + thumbnail — **ponto de cutover**
- **Entrega:** port do fluxo YouTube OAuth/upload/captions para `google-api-python-client` (mesmas credenciais, sem re-auth), geração de metadata (título/descrição/capítulos/tags), compositor de thumbnail (frame real + Pillow), agendamento.
- **Teste E2E:** pipeline completo → upload `private` com legendas + thumbnail + capítulos visíveis no YouTube Studio.
- **Reforma:** `youtubeService.js`, `metadataService`, runtime Node inteiro.

### Fase 8 — Descoberta de temas + escala
- **Entrega:** agente de discovery (YouTube Data API, pytrends com degradação graciosa, calendário sazonal YAML, outliers de concorrentes), sinal de cobertura da biblioteca, shortlist semanal Telegram, cron de ingestão nightly, paralelização async onde seguro, dashboard de custos a partir dos ledgers.
- **Teste E2E:** discovery propõe ≥ 5 temas com score + % de cobertura da biblioteca; 1 é aprovado e flui até vídeo publicado tocado por humano só nos 2 gates.
- **Reforma:** `ideasService`, scripts legacy restantes; `pipeline/` arquivado.

---

## Critérios de cutover (todos obrigatórios)

1. 3 vídeos consecutivos produzidos 100% no `studio/` com revisor ≥ 90 e aprovação humana.
2. Julgamento lado-a-lado: utilizador prefere o output novo em 3/3.
3. Custo por vídeo ≤ $5, medido pelo ledger.
4. `resume` demonstrado num crash real a meio de um run.
5. Upload + legendas + capítulos verificados no canal real.

**Depois:** `git tag legacy-final` → mover `pipeline/` para `legacy/` → remover deps Node.

---

## Riscos e mitigações

| # | Risco | Mitigação |
|---|---|---|
| 1 | **Licenciamento de footage (yt-dlp)** — YouTube não-CC viola ToS/direitos | Allow-list de fontes CC/PD verificadas; registo de licença obrigatório fail-closed; atribuição automática na descrição; sem caminho de exceção no código (ver `LIBRARY_POLICY.md`) |
| 2 | **VRAM 4 GB (GTX 1050 Ti)** | whisper large-v3-turbo int8 (~1.6 GB) ou medium; SigLIP-base; modelos carregados sequencialmente; fallback CPU sempre presente |
| 3 | **Cold start da biblioteca** — semana 1 pareceria o sistema antigo | Saída da Fase 2 exige seed ≥ 2.000 shots; seleção de temas consulta cobertura; top-up JIT desde o dia 1 |
| 4 | **Instabilidade do loop revisor** (defeitos alucinados, oscilação, custo) | Teto de 2 iterações; vocabulário fechado de fixes; monotonicidade (score desce → reverter e ir a humano); budget breaker; artefactos gravados para iteração de prompts |
| 5 | **Gap PT-BR↔EN no SigLIP** — degradação silenciosa de retrieval | Briefs sempre em inglês por construção (lint no output do LLM); multilingual-e5 no lado dos metadados; eval set de 30 pares em CI |
