# Relatorio de healthcheck do fluxo completo - 2026-06-02

## Objetivo

Este documento resume o que funciona e o que ainda nao funciona no pipeline hoje, com base em duas fontes de evidencia:

1. uma execucao real iniciada nesta sessao para medir o comportamento atual do fluxo ponta a ponta
2. o draft `e2e_orkut_full_repair_1780166684737`, que ja estava renderizado e validado com sucesso e serve como prova do que as etapas finais conseguem fazer quando recebem entrada boa

## Execucao real rodada nesta sessao

### Comando executado

Rodado em `pipeline/` com output isolado:

```bash
OUTPUT_ROOT="$PWD/output-local-complete-flow-report" \
TEST_REPORTS_ROOT="$PWD/output-local-complete-flow-report/test_reports" \
CLIP_LIBRARY_ROOT_DIR="$PWD/output-local-complete-flow-report/clips" \
CLIP_LIBRARY_DB_PATH="$PWD/output-local-complete-flow-report/system/clip-library.sqlite" \
SCENE_INDEX_DB_PATH="$PWD/output-local-complete-flow-report/system/scene-index.sqlite" \
CLIP_LIBRARY_SHADOW_REPORT_DIR="$PWD/output-local-complete-flow-report/reports/clip-library-shadow" \
node tests/complete-flow-test.js
```

### Importante sobre este teste

`tests/complete-flow-test.js` e o entrypoint E2E mais direto exposto em `package.json`, mas ele nao cobre literalmente todo o funil de produto:

- ele cria o `state` diretamente
- injeta `script_text` e `visual_plan` manualmente
- roda `generateAudio -> generateAssets -> renderVideo -> validateRender -> uploadToYoutube(mock)`

Ou seja: ele mede muito bem o miolo operacional do pipeline, mas nao mede ideia, pesquisa, outline, geracao real de roteiro e captions.

Para um fluxo mais completo no codigo, existem pelo menos estes testes:

- `tests/final-validation-flow-test.js`
- `tests/youtube-private-gemini-travel-e2e.js`

Eles nao foram rodados nesta sessao porque a execucao observada ja mostrou gargalo antes mesmo de chegar nessas etapas adicionais.

## Resultado observado ao vivo

### O que passou

#### 1. Persistencia inicial de estado

O draft `security_test_1780405730017` foi criado corretamente em:

- `pipeline/output-local-complete-flow-report/draft/security_test_1780405730017/state.json`

O estado inicial foi salvo com sucesso em `script_generated`.

#### 2. TTS real

O audio foi gerado com provider real, sem cair em mock:

- provider: `multivozes_chunked`
- voice: `alloy`

Eventos persistidos:

- `2026-06-02T13:08:50.025Z` - `audio start`
- `2026-06-02T13:09:07.875Z` - `audio end status=ok`

Duracao da etapa de audio observada no `pipeline-events.jsonl`:

- `duration_ms=17849`

#### 3. Entrada na etapa de assets

O pipeline entrou em `generateAssets` e iniciou a etapa com evento persistido:

- `2026-06-02T13:09:07.883Z` - `stage=assets`, `event=start`, `status=running`

#### 4. Download real de assets

Mesmo sem fechar a etapa inteira, a execucao materializou arquivos reais em `assets/raw`, provando que a busca/download com providers externos estava ativa.

Arquivos observados:

- `scene-01-01-pixabay.jpg`
- `scene-01-02-pixabay.mp4`
- `scene-01-03-pixabay.mp4`
- `scene-01-04-pixabay.mp4`
- `scene-01-05-pixabay.mp4`
- `scene-02-01-pixabay.mp4`
- `scene-02-02-pixabay.jpg`
- `scene-02-03-pixabay.mp4`
- `scene-02-04-pixabay.mp4`
- `scene-02-05-pixabay.mp4`

#### 5. Fallback de analise visual do Gemini sem abortar imediatamente o fluxo

Foram observados warnings reais nesta etapa:

- `Gemini image description unavailable, using fallback`
- erro `429 Resource exhausted` em `gemini-2.5-flash-lite`
- timeout de `20000ms exceeded` em `gemini-2.5-flash`

Mesmo assim, o bloco `introducao` foi concluido e o fluxo prosseguiu para `lisboa`.

Metricas logadas para `introducao`:

- `downloaded: 5`
- `enriched: 5`
- `raw_candidates: 40`
- `shortlist: 15`
- `finalists: 5`

Em seguida, o log registrou:

- inicio do bloco `lisboa`

Isso prova que o fallback atual do Gemini e fail-open o suficiente para nao derrubar o fluxo na primeira falha de provider.

## O que nao fechou nesta execucao

### 1. A etapa de assets nao concluiu dentro da janela observada

Embora o bloco 1 tenha concluido e o bloco 2 tenha iniciado, a etapa `assets` como um todo nao chegou a salvar evento de fim nem a mudar o topo do estado para `assets_searched`.

Evidencia:

- `pipeline/output-local-complete-flow-report/draft/security_test_1780405730017/history/pipeline-events.jsonl` terminou em `assets start`
- `state.json` do draft continuou com `status=audio_generated` e `current_step=audio_generated`
- nao houve `render_path`
- `approved_items` e `approved_windows` ainda nao haviam sido persistidos no topo do estado na hora em que a observacao foi encerrada

### 2. O healthcheck nao chegou a render, validate ou upload

Como a etapa de assets nao fechou dentro da janela observada, esta execucao ao vivo nao produziu evidencia direta para:

- `renderVideo`
- `validateRender`
- `uploadToYoutube(mock)`

### 3. A etapa de assets continua sendo o gargalo atual do fluxo ao vivo

O comportamento observado hoje nao e uma falha seca com stacktrace. E pior para operacao: e um fluxo que continua vivo, gera parte dos arquivos, toma fallback de provider e segue andando por blocos, mas sem concluir a etapa inteira em tempo razoavel.

Em outras palavras:

- o pipeline nao morreu logo no inicio
- mas tambem nao fechou `generateAssets` no tempo observado
- hoje o gargalo operacional mais evidente do fluxo ao vivo e `generateAssets`

### 4. A execucao foi interrompida manualmente

O terminal foi encerrado manualmente depois de coletar evidencia suficiente para este relatorio, para evitar deixar chamadas externas abertas sem necessidade.

Portanto, a leitura correta nao e `fluxo falhou com exception final`, e sim:

- `fluxo parcial observado ate assets, com degradacao de provider e sem conclusao da etapa durante a janela acompanhada`

## O que esta comprovadamente funcionando no pipeline hoje

Esta secao combina a execucao ao vivo acima com o draft do Orkut que ja foi fechado com sucesso.

### Funciona agora, com evidencia forte

#### 1. Persistencia e ciclo de estado por draft

O pipeline cria draft, grava `history/`, salva `state.json` e registra eventos de etapa.

#### 2. TTS real com `multivozes_chunked`

Comprovado ao vivo nesta sessao.

#### 3. Busca/download real de assets externos

Comprovado ao vivo nesta sessao com arquivos de `scene-01` e `scene-02` baixados em `assets/raw`.

#### 4. Fallback do Gemini na analise visual

O sistema suporta `429` e timeout sem abortar imediatamente o bloco corrente.

#### 5. Render final

Comprovado no draft:

- `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737/render/final-with-overlays.mp4`

Esse draft fechou com:

- resolucao `1920x1080`
- duracao `88.6s`
- `final_hard_boundary_status=pass`

#### 6. QA visual final

Comprovado no draft do Orkut:

- `render_validation.is_publishable=true`
- `needs_regeneration=false`
- `needs_manual_review=false`
- `editorial_failure_codes=[]`
- `publish_blocked_codes=[]`

Artefatos confiaveis gerados:

- `pipeline/output-local-e2e-full-repair/test_reports/e2e_orkut_full_repair_1780166684737-contact-sheet.jpg`
- `pipeline/output-local-e2e-full-repair/test_reports/e2e_orkut_full_repair_1780166684737-visual-audit.json`

#### 7. Preflight de publicacao

No draft do Orkut, `getProductionPreflightStatus()` ficou verde em runtime `prod_strict`:

- `has_youtube_credentials=true`
- `has_provider_credentials=true`
- `has_gemini_key=true`
- `has_render_validation=true`
- `render_publishable=true`
- `hard_boundary_pass=true`
- `ready_for_real_publish=true`

## O que ainda nao funciona bem ou ainda nao esta fechado

### 1. `generateAssets` ainda e o gargalo do fluxo ao vivo

Hoje o problema mais claro do pipeline real e este:

- a etapa de assets consegue iniciar
- baixa material real
- sofre degradacao de Gemini
- fecha pelo menos um bloco
- mas nao conclui a etapa inteira em tempo razoavel no healthcheck observado

### 2. O preflight nao reflete todo o gate real de upload

No draft do Orkut, o preflight ficou verde, mas o upload real ainda falharia porque `runPreUploadQA()` exige duracao minima de `480s`.

Resultado medido nesta sessao para o draft do Orkut:

- `pre_upload_qa.ok=false`
- erro: `[M8] QA FAIL: duracao 88.6s < 480s minimos`

Portanto:

- `getProductionPreflightStatus()` hoje pode dizer que esta pronto para publicar
- mas `uploadToYoutube()` ainda pode bloquear no gate M8 real

### 3. Aprovacao final humana ainda bloqueia upload real

No draft do Orkut:

- `approved=false`

Mesmo com o render validado, o upload real nao segue sem a aprovacao final registrada em `POST /videos/final/approve`.

### 4. O writer do relatorio final visual ainda usa caminho fixo

`syncValidator.js` ainda grava `pipeline/reports/visual-truth-final-report.md` em caminho fixo, o que pode deixar relatorio stale de outro video.

Isso nao invalida o render nem o QA, mas invalida esse markdown como evidencia por video.

## Leitura honesta do status atual

### Se a pergunta for "o pipeline esta morto?"

Nao.

O pipeline esta vivo e hoje faz isto com evidencia real:

- cria draft
- gera audio
- entra em assets
- baixa assets reais
- sobrevive a falhas pontuais do Gemini via fallback
- em outro draft comprovadamente renderiza, valida e fecha QA final

### Se a pergunta for "o fluxo completo esta estavel ponta a ponta hoje?"

Ainda nao.

Motivo principal observado ao vivo:

- a etapa `generateAssets` continua lenta e fragil sob degradacao de provider, a ponto de nao fechar dentro da janela observada

Motivos secundarios no fim do funil:

- diferenca entre preflight e gate real de upload
- exigencia de `approved=true`
- exigencia de `480s` no M8

## Recomendacoes objetivas para o Claude

### Prioridade 1

Atacar `generateAssets` como gargalo operacional real do fluxo ao vivo.

O foco nao deve ser apenas qualidade semantica; deve ser tambem previsibilidade de encerramento da etapa sob:

- `429` do Gemini
- timeout de analise visual
- progresso por bloco sem persistencia de estado intermediario suficiente

### Prioridade 2

Alinhar `getProductionPreflightStatus()` com `runPreUploadQA()`.

Hoje existe uma divergencia pratica:

- preflight verde
- upload real ainda bloqueado

### Prioridade 3

Corrigir o writer de relatorio final visual para gerar caminho por `video_id`, nao um arquivo compartilhado.

### Prioridade 4

Se o produto pretende subir videos curtos, revisar a regra M8 de `480s` antes de continuar depurando upload.

## Arquivos que o Claude deve abrir primeiro

- `pipeline/tests/complete-flow-test.js`
- `pipeline/tests/final-validation-flow-test.js`
- `pipeline/tests/youtube-private-gemini-travel-e2e.js`
- `pipeline/src/services/assetsService.js`
- `pipeline/src/services/geminiService.js`
- `pipeline/src/services/visualIntentService.js`
- `pipeline/src/services/syncValidator.js`
- `pipeline/src/services/youtubeService.js`
- `pipeline/output-local-complete-flow-report/draft/security_test_1780405730017/state.json`
- `pipeline/output-local-complete-flow-report/draft/security_test_1780405730017/history/pipeline-events.jsonl`
- `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737/state.json`

## Conclusao curta

Hoje o pipeline nao esta quebrado de ponta a ponta, mas tambem nao esta estavel de ponta a ponta.

O miolo final `render -> validate` ja provou que consegue fechar bem quando recebe insumo suficiente. O gargalo operacional mais forte observado ao vivo nesta sessao esta antes disso, em `generateAssets`, com degradacao real de Gemini e encerramento lento/inconclusivo da etapa.