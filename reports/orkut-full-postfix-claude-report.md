# Relatorio completo pos-fix - Orkut no Brasil

## Escopo

- objetivo: validar o pipeline local completo sem upload para YouTube, apos os fixes de retry/reuse/reaprovacao de assets gerados
- draft principal validado: `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737`
- tema: `A historia do Orkut no Brasil`
- data: `2026-06-01`

## Mudancas aplicadas nesta rodada

### 1. Resiliencia de provider

- `pipeline/src/services/geminiService.js`
- chamadas Vertex `predict` e `predictLongRunning` agora passam por retry/backoff

### 2. Reuse real no repair de assets

- `pipeline/src/services/assetsService.js`
- recuperacao de `raw_items` a partir de `assets/raw`
- refresh seletivo agora semeia `downloadedItems` com assets ja existentes da cena
- assets com `analysis_windows` existentes sao reutilizados quando a analise nao e fraca

### 3. Fix especifico para imagens geradas

- `pipeline/src/services/assetsService.js`
- assets `vertex_ai_generated` nao caem mais automaticamente em `metadata_fallback` quando sao imagem
- analise fraca antiga (`metadata_fallback` + `visual evidence unavailable - weak fallback`) deixou de ser reutilizada para esses assets
- essas imagens agora passam a usar `ai_generated_scene_alignment`

### 4. Fix do QA final

- `pipeline/src/utils/mediaUtils.js`
- `extractVideoFrame()` foi ajustado para JPEG com `yuvj420p` + `-strict unofficial`
- isso destravou o `validateRender`, que antes quebrava ao exportar frames de evidencia visual via ffmpeg

## Validacoes executadas

### Validacao focada das cenas 7 e 10

Com Gemini desligado, para isolar o comportamento local do fix:

- entrada anterior: cenas 7 e 10 tinham `vertex_ai_generated`, mas com `analysis_provider=metadata_fallback`
- resultado apos o fix:
  - cena 7: `analysis_provider=ai_generated_scene_alignment`, `approved_windows=1`
  - cena 10: `analysis_provider=ai_generated_scene_alignment`, `approved_windows=2`

Conclusao: o gargalo dessas duas cenas era um bug de reaproveitamento de analise fraca, nao falta de render ou de merge em `approved_items`.

### Teste completo pos-fix

Script executado no draft salvo, com refresh completo de assets + tentativa de render + validacao final.

#### Estado antes do teste completo

- `status=assets_searched`
- `raw_items=42`
- `approved_items=32`
- `approved_windows=156`
- `blocking_scene_indexes=[1,2,3,4,5,6,8,9,11,12,13,14]`

#### Resultado de assets apos o teste completo

- `duration_ms=335754`
- `raw_items=58`
- `approved_items=45`
- `approved_windows=195`
- `generated_assets=5`
- `blocking_scene_indexes=[1,2,3,4,5,6,8,9,11,12,13,14]`
- `scene 7 = ready=true`
- `scene 10 = ready=true`

Observacao importante:

- o auto-repair deixou de reabrir as cenas 7 e 10
- depois do primeiro passe, a rodada automatica de repair atacou apenas `1,6,8,9`
- isso confirma que o fix deslocou o bloqueio real para as cenas restantes, em vez de continuar perdendo progresso nas cenas ja resolvidas

#### Resultado de render

- `status=render_generated` e depois `render_validated`
- render final gerado com sucesso em:
  - `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737/render/final-with-overlays.mp4`
- resolucao final observada: `1920x1080`
- duracao final observada: `81.233s`
- timeline final: `23` clips
- `final_hard_boundary_status=pass`

## O que funciona agora

### Funciona de forma validada

- reaproveitamento de `assets/raw` durante repair
- reaproveitamento de analise forte preexistente
- nao reutilizacao de analise fraca em imagens `vertex_ai_generated`
- promocao de imagens geradas das cenas 7 e 10 para janelas aprovadas
- refresh completo de assets sem resetar progresso anterior
- render completo com overlays ate arquivo final
- validacao final volta a rodar sem quebrar no ffmpeg JPEG export
- geracao dos artefatos de QA obrigatorios:
  - `pipeline/output-local-e2e-full-repair/test_reports/e2e_orkut_full_repair_1780166684737-contact-sheet.jpg`
  - `pipeline/output-local-e2e-full-repair/test_reports/e2e_orkut_full_repair_1780166684737-visual-audit.json`

### Evidencia de melhoria quantitativa

Comparando o checkpoint limpo anterior com o resultado atual:

- `raw_items: 29 -> 58`
- `approved_items: 18 -> 45`
- `approved_windows: 108 -> 195`
- cenas prontas adicionais: `7` e `10`

## O que ainda trava ou impede publish

O pipeline agora chega ate `render_validated`, mas o render final ainda **nao e publishable**.

### Estado final de publish

- `is_publishable=false`
- `quality_score=0.673`
- `needs_regeneration=true`
- `publish_blocked=true`

### Codigos finais de bloqueio

- `CRITICAL_SLOT_UNCERTAIN`
- `CRITICAL_SLOT_NOT_CONFIRMED`
- `NO_PROOF_FOR_PROMISE`
- `COVERAGE_SEARCH_INSUFFICIENCY`
- `CRITICAL_SLOT_ONLY_GENERIC`
- `DIVERSITY_BYPASS_ON_CRITICAL_SLOT`

### Issues finais registradas pelo QA

- `diversity_bypass_on_critical_slot` (critical)
  - `count=6`
  - `clip_indexes=[6,8,13,15,19,21]`
- `critical_slot_only_generic` (critical)
  - `count=9`
  - `clip_indexes=[4,6,8,10,11,13,15,19,21]`
- `overlay_not_rendered` (medium)
- `critical_slot_not_visually_confirmed` (critical)
- `uncertain_in_critical_slot` (critical)
  - `count=15`
- `coverage_search_insufficiency` (high)
  - `scene_indexes=[1,2,3,4,5,6,8,9,11,12,13,14]`
- `no_proof_for_promise` (critical)
  - `scene_indexes=[6,8,9,11]`
- `too_many_uncertain_clips` (high)
  - `ratio=0.652`

### Leitura pratica desses bloqueios

- o pipeline ja nao trava mais na perda de assets ou no reset de repair
- o gargalo agora e editorial/visual
- ainda faltam provas visuais confiaveis para slots criticos em 12 cenas
- varios slots criticos foram preenchidos com material `generic` ou `uncertain`
- o hard boundary passou, mas isso sozinho nao basta para liberar publish

## Artifacts principais

- state final:
  - `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737/state.json`
- render final:
  - `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737/render/final-with-overlays.mp4`
- contact sheet:
  - `pipeline/output-local-e2e-full-repair/test_reports/e2e_orkut_full_repair_1780166684737-contact-sheet.jpg`
- visual audit:
  - `pipeline/output-local-e2e-full-repair/test_reports/e2e_orkut_full_repair_1780166684737-visual-audit.json`

## Diagnostico executivo para o Claude

### Resumo curto

O pipeline agora consegue:

- reaproveitar assets e analises antigas corretamente
- corrigir a aprovacao de imagens geradas relevantes
- completar novo repair de assets
- gerar render final
- completar a validacao final sem crash tecnico

O pipeline ainda **nao consegue publicar automaticamente** porque a cobertura editorial dos slots criticos continua insuficiente em 12 cenas. O problema dominante deixou de ser infraestrutura/execucao e passou a ser qualidade semantica/visual do pool aprovado.

### Proximo foco recomendado

1. atacar a estrategia de busca/repair para `critical slots`, nao apenas aumentar volume bruto de assets
2. reduzir material `generic` em slots criticos e aumentar `exact/regional` com prova visual real
3. revisar por que o QA marcou `overlay_not_rendered`, mesmo com render final em `final-with-overlays.mp4`
4. auditar os `clip_indexes` criticos listados pelo QA para descobrir se o problema esta na selecao de janela, na classificacao visual ou no query planning

### Conclusao final

O sistema saiu de um estado em que o repair desperdicava progresso e a validacao final quebrava tecnicamente para um estado em que:

- o repair preserva e melhora o inventario
- as cenas 7 e 10 foram efetivamente destravadas
- o render final e produzido com sucesso
- a validacao final conclui e entrega diagnostico real

O bloqueio restante nao e mais operacional; e editorial/semantico.

## Fluxo detalhado do pipeline, da ideia ao upload

Observacao de leitura para o Claude:

- a sequencia abaixo mistura duas bases de evidencia
- etapas de roteiro, TTS, captions e audio intelligence foram validadas anteriormente nesta mesma sessao
- o teste completo pos-fix desta rodada partiu do draft salvo e revalidou principalmente `assets -> render -> validateRender`
- quando uma etapa nao foi reexecutada nesta ultima rodada, isso esta indicado explicitamente

### Sequencia ponta a ponta

1. Tema / ideia inicial.
O fluxo entra por `/videos/ideas/generate` em `pipeline/src/routes/videoRoutes.js` e delega para `pipeline/src/services/ideasService.js`. A geracao da ideia depende de prompt em `pipeline/src/services/geminiService.js` ou `pipeline/src/services/openaiService.js`. Status: funciona no codigo e foi usada na sessao, mas nao foi reexecutada no ultimo teste pos-fix.

2. Aprovacao da ideia.
Depois da geracao, a ideia selecionada e gravada no `state.json` e vira a base para roteiro e metadata. Status: funciona como etapa de estado e persistencia; nao foi o gargalo desta rodada.

3. Criacao do prompt de roteiro.
O tema aprovado vira prompt em `pipeline/src/services/scriptService.js`, que chama `generateScriptPackageWithGemini()` em `pipeline/src/services/geminiService.js`. Aqui o sistema monta angle, duracao alvo, estrutura e exigencias do roteiro. Status: funciona e foi validado anteriormente na sessao; nao foi reexecutado no ultimo teste pos-fix.

4. Geracao do roteiro.
O prompt acima produz `script_text`, `visual_plan`, titulos, descricoes e metadados associados. Status: funciona. Nao ha indicio atual de bloqueio nesta etapa.

5. Conversao de texto para audio.
O roteiro vai para `pipeline/src/services/ttsService.js`, com runtime auxiliar em `pipeline/src/services/multivozesRuntimeService.js`. Nesta sessao isso foi validado com TTS real e audio gerado corretamente. Status: funciona.

6. Audio intelligence.
Com o audio pronto, `pipeline/src/services/audioIntelligence.js` gera palavras, segmentos, pauses e boundaries que alimentam o planner temporal. Status: funciona. Esta etapa ja tinha sido validada antes desta rodada e nao reapareceu como gargalo.

7. Captions.
As legendas sao geradas em `pipeline/src/services/captionsService.js`. Status: funciona. Tambem ja estava validada anteriormente na sessao.

8. Planejamento de queries visuais por cena e bloco.
`pipeline/src/services/assetQueryPlanner.js` e `pipeline/src/services/assetsService.js` transformam o roteiro e o `visual_plan` em queries por bloco, slot e micro-need. Aqui sao montados os termos de busca que tentam cobrir `intro`, `hook`, `chapter_opening`, `first_clip_of_block`, `closing` e outros slots editoriais. Status: funciona operacionalmente, mas ainda produz cobertura insuficiente para varios slots criticos. Este e o primeiro ponto onde o gargalo atual aparece de forma consistente.

9. Busca, download, reuse e enriquecimento semantico de assets.
`pipeline/src/services/assetsService.js` faz busca em providers, download, reuse de `assets/raw`, recuperacao de `raw_items`, enriquecimento por janelas e geracao Vertex quando necessario. Nesta rodada, esta etapa foi corrigida e revalidada. Status: funciona operacionalmente apos os fixes. Evidencia: `raw_items 42 -> 58`, `approved_items 32 -> 45`, `approved_windows 156 -> 195`, e as cenas 7 e 10 deixaram de bloquear.

10. Analise de imagens geradas.
Este era um bug real. Imagens `vertex_ai_generated` ficavam presas em `metadata_fallback` dentro de `pipeline/src/services/assetsService.js`, o que impedia aprovacao editorial. Depois do fix, essas imagens passaram para `ai_generated_scene_alignment`. Status: funciona apos o fix. Evidencia: cena 7 com `approved_windows=1` e cena 10 com `approved_windows=2`.

11. Aprovacao editorial e `scene_asset_readiness`.
`pipeline/src/services/assetApprovalService.js`, `pipeline/src/services/assetReadinessService.js` e a fase final de `pipeline/src/services/assetsService.js` decidem se cada cena tem prova visual suficiente e se cada slot critico foi realmente coberto. Status: parcial e este e o gargalo central atual. O sistema melhora inventario, mas ainda deixa 12 cenas bloqueadas por `critical`, `generic` ou `uncertain`.

12. Montagem da timeline.
`pipeline/src/services/timelinePlanner.js` usa `audio_intelligence.words`, windows aprovadas e scores semanticos para escolher os clips finais. Status: funciona. Evidencia: o teste completo chegou a timeline final com `23` clips e seguiu para render sem abortar no preflight editorial.

13. Render final.
`pipeline/src/services/renderService.js` renderizou todos os segmentos, aplicou overlays e compôs o arquivo final. Status: funciona. Evidencia: render final gerado em `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737/render/final-with-overlays.mp4`.

14. QA final e validacao de publish.
`pipeline/src/services/syncValidator.js` roda QA semantico, boundaries, overlays, score de qualidade e gate de publish. Nesta rodada havia um bug tecnico no helper de frame extraction em `pipeline/src/utils/mediaUtils.js`, que quebrava a exportacao JPG para evidencia visual. Isso foi corrigido. Status: funciona tecnicamente apos o fix, mas reprova editorialmente o render final.

15. Upload para YouTube.
`pipeline/src/services/youtubeService.js` e o endpoint `/videos/youtube/upload` sao o passo final. Status: nao executado nesta rodada por desenho. O gate fez o correto e bloqueou upload porque `render_validation.is_publishable=false`.

## Mapa sequencial de status, para o Claude localizar o gargalo

1. Geracao de tema / ideias. Status: funciona, mas nao foi reexecutado na rodada final. Onde olhar: `pipeline/src/services/ideasService.js`, `pipeline/src/services/geminiService.js`, `pipeline/src/services/openaiService.js`.

2. Criacao de prompt de roteiro. Status: funciona. Onde olhar: `pipeline/src/services/scriptService.js`, `pipeline/src/services/geminiService.js`.

3. Geracao do roteiro e `visual_plan`. Status: funciona. Onde olhar: `pipeline/src/services/scriptService.js`, `pipeline/src/utils/visualPlan.js`.

4. Conversao de texto para audio. Status: funciona. Onde olhar: `pipeline/src/services/ttsService.js`, `pipeline/src/services/multivozesRuntimeService.js`.

5. Audio intelligence. Status: funciona. Onde olhar: `pipeline/src/services/audioIntelligence.js`.

6. Captions. Status: funciona. Onde olhar: `pipeline/src/services/captionsService.js`.

7. Planejamento de queries e prompts visuais por slot. Status: parcial. Funciona para gerar volume e mover o draft, mas ainda nao foca prova visual suficiente nos slots criticos. Onde olhar: `pipeline/src/services/assetQueryPlanner.js`, `pipeline/src/services/assetsService.js`.

8. Busca, download e reuse de assets. Status: funciona apos os fixes desta rodada. Onde olhar: `pipeline/src/services/assetsService.js`. Fixes ja aplicados: reuse de `assets/raw`, reaproveitamento de analise forte, retry Vertex, e correcao de imagens `vertex_ai_generated`.

9. Aprovacao editorial dos assets. Status: nao funciona de forma suficiente para publish. Este e o gargalo principal. Onde olhar: `pipeline/src/services/assetApprovalService.js`, `pipeline/src/services/assetReadinessService.js`, `pipeline/src/services/assetsService.js`. Sintoma atual: excesso de `generic` e `uncertain` em slots criticos, cobertura insuficiente e falta de `proof_for_promise`.

10. Selecao da timeline. Status: funciona com o pool que recebe, mas herda a fraqueza editorial do pool aprovado. Onde olhar: `pipeline/src/services/timelinePlanner.js`, `pipeline/src/services/renderService.js`. O problema aqui parece mais consequencia do pool do que bug primario de montagem.

11. Render de segmentos e composicao final. Status: funciona. Onde olhar: `pipeline/src/services/renderService.js`.

12. Overlay no render. Status: parcial. O render final saiu com overlays, mas o QA ainda registrou `overlay_not_rendered`. Onde olhar: `pipeline/src/services/renderService.js`, qualquer helper de overlay aplicado pelo render, e `pipeline/src/services/syncValidator.js`. Hipotese local: ou o overlay esta fraco para OCR/vision, ou a verificacao de evidencia do overlay esta desalinhada do frame real.

13. Validacao final. Status: funciona tecnicamente apos o fix de JPEG em `pipeline/src/utils/mediaUtils.js`, mas reprova editorialmente. Onde olhar: `pipeline/src/services/syncValidator.js`, `pipeline/src/services/assetApprovalService.js`.

14. Upload. Status: bloqueado corretamente pelo gate; nao e bug operacional. Onde olhar: `pipeline/src/services/youtubeService.js`, mas o foco nao deve ser aqui enquanto `render_validation.is_publishable` estiver falso.

## Onde exatamente esta o gargalo hoje

O gargalo atual esta entre as etapas 8 e 9, com reflexo nas 10, 12 e 13:

1. o sistema ja consegue buscar muito mais asset e gerar render final
2. mas ainda nao consegue transformar esse volume em prova editorial forte para slots criticos
3. a montagem final entao usa material `generic` ou `uncertain` em partes onde o QA exige confirmacao mais forte
4. por isso o render passa em hard boundary, mas falha em publishability

## Como o Claude deve priorizar a analise

1. primeiro inspecionar `pipeline/src/services/assetApprovalService.js` para entender por que ainda ha tantos `critical_slot_only_generic`, `uncertain_in_critical_slot` e `no_proof_for_promise`

2. depois inspecionar `pipeline/src/services/assetQueryPlanner.js` e `pipeline/src/services/assetsService.js` para verificar se os prompts/queries de repair estao amplos demais e pouco orientados a prova visual real

3. por fim inspecionar `pipeline/src/services/timelinePlanner.js` para ver se clips `generic` estao entrando por falta de opcao ou por score indevidamente alto

4. em paralelo, revisar o caso `overlay_not_rendered` em `pipeline/src/services/syncValidator.js` e no ponto do render que aplica overlays, porque este issue agora nao bloqueia sozinho o fluxo, mas continua sinalizando uma divergencia entre overlay esperado e overlay detectado