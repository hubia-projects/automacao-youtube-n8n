# Block Transition Upgrade Report

Data: 2026-05-06
Escopo: hard-boundary editorial lock ponta a ponta (planner, scoring, QA, n8n, gates de publicacao, testes e documentacao de fluxo)

## 1) Resumo executivo

Foi implementado um gate estrutural de transicao entre blocos narrativos (hard boundary), removendo a dependencia de penalidade de score para garantir troca visual correta.

Resultado pratico:
- Primeiro clip apos boundary hard agora e bloqueado para o bloco/cidade novo.
- Neutral fallback no primeiro slot hard e proibido por politica.
- Crossing de boundary vira falha estrutural.
- QA passa a validar boundary de forma deterministica (nao so por amostragem).
- Upload fica bloqueado sem render publicavel e sem hard boundary aprovado.
- W2 para antes do W3 quando faltar asset real publicavel.

## 2) Checklist requisito -> status

| ID | Requisito | Status | Evidencia principal |
| --- | --- | --- | --- |
| R1 | Contrato de dados de boundary (boundary_id, transition_type, expected_location, chapter_trigger, chapter_card_required, block_intro_asset) | DONE | src/services/narrativeBlockPlanner.js, src/services/timelinePlanner.js |
| R2 | Flags de ambiente para hard boundary e politica de fallback | DONE | src/config/env.js, .env.example |
| R3 | Deteccao de chapter trigger no audio | DONE | src/services/audioIntelligence.js |
| R4 | Lock do primeiro clip no boundary hard | DONE | src/services/timelinePlanner.js |
| R5 | Anti-crossing de boundary | DONE | src/services/timelinePlanner.js, src/services/syncValidator.js |
| R6 | Fallback controlado por readiness de asset (sem mascarar falta em producao) | DONE | src/services/assetReadinessService.js, src/services/assetsService.js |
| R7 | Rejeicao estrita de candidatos no primeiro slot hard | DONE | src/services/assetRejectionService.js, src/services/timelineScoringService.js |
| R8 | Overlay de capitulo ancorado no primeiro clip do bloco | DONE | src/services/overlayService.js |
| R9 | Scoring sem "resgate" de violacao hard | DONE | src/services/timelineScoringService.js |
| R10 | Validador deterministico de hard boundary e lag maximo | DONE | src/services/syncValidator.js |
| R11 | Gate de publicacao no backend por hard boundary/publicabilidade | DONE | src/routes/videoRoutes.js, src/services/youtubeService.js |
| R12 | Gate no Workflow 3 por hard_boundary_status + max_visual_lag_sec | DONE | n8n/workflow3_render_youtube.json |
| R13 | Gate no Workflow 2 por missing_assets com manual review | DONE | n8n/workflow2_audio_captions_assets.json |
| R14 | Suite de testes dedicada e regressao atualizada | DONE | tests/chapter-trigger-detector-test.js, tests/hard-boundary-lock-test.js e ajustes em testes existentes |
| R15 | Relatorio tecnico obrigatorio | DONE | reports/block-transition-upgrade-report.md |
| R16 | Sincronizacao dos documentos de fluxo | DONE | ../fluxo.md, ../fluxo-visual.md, ../fluxo-visual.html |

## 3) Mudancas por camada

### 3.1 Planejamento e selecao de clips
- `timelinePlanner` agora aplica politica hard boundary (`hardBoundaryPolicy`) com:
  - proibicao de neutral no primeiro slot hard,
  - exigencia de location no boundary (quando configurado),
  - falha explicita quando nao existe candidato valido para o primeiro slot hard,
  - metrica de lag por `timeline_start_sec`.
- `timelineScoringService` introduz bloqueio hard explicito (`hard_blocked`) e penaliza evidencia fraca de `metadata_fallback`.

### 3.2 Contrato narrativo e sinais de audio
- `narrativeBlockPlanner` passou a emitir `boundary_id`, `expected_visual_start_sec`, `chapter_trigger`, `chapter_card_required` e `block_intro_asset`.
- `audioIntelligence` ganhou detector de `chapter_triggers` por palavras de transicao.

### 3.3 Assets e readiness
- Novo `assetReadinessService` para:
  - classificar placeholder,
  - decidir publicabilidade por cena,
  - sumarizar `missing_assets` e `blocking_scene_indexes`.
- `assetsService` persiste `scene_asset_readiness` e bloqueia caminho normal quando faltar asset real publicavel em producao.

### 3.4 QA e publicacao
- `syncValidator` passou a:
  - calcular `hard_boundary_status`,
  - emitir `hard_boundary_report`,
  - controlar `max_visual_lag_sec`,
  - elevar violacao hard para issue critica.
- `videoRoutes` e `youtubeService` bloqueiam upload se QA nao for publicavel, se `needs_manual_review=true`, se `hard_boundary_status!=pass` ou se `max_visual_lag_sec` exceder o limite.

### 3.5 Workflows n8n
- W2: novo `If Assets Ready`; ramo negativo chama `/api/videos/review/mark-manual-review` e nao segue para W3.
- W3: condicao de continuidade apos validacao/fix exige `is_publishable && hard_boundary_status==='pass' && max_visual_lag_sec <= HARD_BOUNDARY_MAX_LAG_SEC`; ramo de falha marca revisao manual.

### 3.6 Manual review operacional
- Novo `manualReviewService` para marcar estado `needs_manual_review`, publicar draft de revisao e notificar Telegram.

## 4) Evidencias de gate

### Gate de assets (antes do render)
- Condicao: `missing_assets=false`
- Local: `n8n/workflow2_audio_captions_assets.json`
- Acao no fail: marcar `needs_manual_review` e encerrar fluxo normal.

### Gate de hard boundary no QA/render
- Condicoes chave:
  - `hard_boundary_status='pass'`
  - `max_visual_lag_sec <= HARD_BOUNDARY_MAX_LAG_SEC`
- Local: `src/services/syncValidator.js`, `n8n/workflow3_render_youtube.json`

### Gate de upload
- Condicoes chave:
  - `approved=true`
  - `render_validation.is_publishable=true`
  - `needs_regeneration=false`
  - `needs_manual_review=false`
  - `hard_boundary_status='pass'`
- Local: `src/routes/videoRoutes.js`, `src/services/youtubeService.js`

## 5) Validacao executada

Comandos executados (2026-05-06):
- `yarn test:chapter-trigger-detector` -> PASS
- `yarn test:hard-boundary-lock` -> PASS
- `yarn test:narrative-blocks` -> PASS
- `yarn test:semantic-sync` -> PASS (`p95_topic_lag_sec=0`, `wrong_topic_exposure_sec=0`)
- `yarn test:sync-validator` -> PASS
- `yarn test:qa-gastronomy-video` -> PASS
- `yarn test:workflow-sync` -> PASS

Tambem foi validado anteriormente no ciclo desta implementacao:
- correcoes em `semantic-sync-planner-test.js` para refletir o gate estrito de assets publicaveis,
- ausencia de erros estaticos relevantes nos arquivos alterados.

## 6) Compatibilidade e regressao

- Regras antigas que aceitavam fallback neutro no primeiro slot hard foram removidas em modo estrito.
- Placeholder local continua possivel apenas em mock/debug via politica de ambiente; em producao nao mascara falta de asset real.
- Fluxos e documentacao foram sincronizados para evitar divergencia operacional.

## 7) Riscos residuais e recomendacoes

Riscos residuais:
- Nao foi executado, neste fechamento, um e2e real completo com upload publico no YouTube; a validacao ficou em suite focada de regressao/gates.
- Ambientes com assets externos limitados podem aumentar volume de `needs_manual_review` ate ajuste fino das queries.

Recomendacoes de follow-up:
1. Rodar `yarn test:complete-flow` em ambiente com providers reais disponiveis.
2. Monitorar taxa de `missing_assets` por tema/cidade por 1-2 ciclos.
3. Ajustar dicionario de fallback tematico no `assetQueryPlanner` conforme resultados reais.
