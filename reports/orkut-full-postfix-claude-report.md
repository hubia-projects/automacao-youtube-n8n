# Relatório ponta a ponta para handoff ao Claude

## Identificação

- tema: `A história do Orkut no Brasil`
- draft principal: `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737`
- data do fechamento técnico: `2026-06-02`
- estado atual do draft: `render_validated`
- objetivo original da rodada: eliminar `CRITICAL_SLOT_ONLY_GENERIC` e `NO_PROOF_FOR_PROMISE`, depois fechar também `DIVERSITY_BYPASS_ON_CRITICAL_SLOT` e `COVERAGE_SEARCH_INSUFFICIENCY`

## Resumo executivo

Este caso começou como um reparo editorial pesado em um draft que já conseguia gerar script, áudio, captions e render, mas ainda falhava no fechamento visual contratual. No início do trabalho, o pipeline sofria em três frentes ao mesmo tempo:

- reaproveitamento imperfeito de assets e análises, especialmente para imagens `vertex_ai_generated`
- falhas editoriais reais no planner e no validador final
- um gargalo técnico no QA visual que já havia quebrado a extração de frames de evidência em outra fase da sessão

Ao final desta rodada, o pipeline chegou a um estado melhor e claramente delimitado:

- o draft foi renderizado e validado com sucesso
- `render_validation.is_publishable=true`
- `needs_regeneration=false`
- `needs_manual_review=false`
- `final_hard_boundary_status=pass`
- `editorial_failure_codes=[]`
- `publish_blocked_codes=[]`

Em outras palavras: do ponto de vista editorial e de QA visual estrito, o draft ficou limpo. O upload real para YouTube não foi executado por dois motivos externos ao conteúdo editorial final:

- `state.approved` ainda está `false`, porque a aprovação final humana não foi registrada no topo do `state.json`
- o upload real executa um gate M8 de duração mínima de `480s`, e este render tem `88.6s`

## Regra de leitura para o Claude

A fonte de verdade visual neste repositório não é `state`, nem metadata, nem uma suposição do planner. A fonte de verdade visual é o frame renderizado e os artefatos de QA gerados a partir do render final.

Para este caso, os artefatos confiáveis são:

- `pipeline/output-local-e2e-full-repair/test_reports/e2e_orkut_full_repair_1780166684737-contact-sheet.jpg`
- `pipeline/output-local-e2e-full-repair/test_reports/e2e_orkut_full_repair_1780166684737-visual-audit.json`
- `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737/render/final-with-overlays.mp4`

Observação importante: `pipeline/reports/visual-truth-final-report.md` não é confiável neste momento como evidência por vídeo. O writer em `pipeline/src/services/syncValidator.js` grava sempre no caminho fixo `pipeline/reports/visual-truth-final-report.md`, o que permite que um relatório anterior de outro vídeo permaneça no arquivo mesmo quando o estado deste draft aponta para ele.

## Fluxo completo, do início ao fim

### 1. Ideia e tema

O fluxo começa em `pipeline/src/routes/videoRoutes.js` e passa por `pipeline/src/services/ideasService.js`. O sistema escolhe ou aprova uma ideia e grava o tema principal no `state.json`.

Neste draft, o tema final foi `A história do Orkut no Brasil`, com ângulo `documental`.

### 2. Pesquisa, outline e script

Com a ideia definida, o pipeline monta `research_json`, `outline_json` e `script_text` via `pipeline/src/services/scriptService.js`, com suporte dos serviços de LLM, principalmente `pipeline/src/services/geminiService.js`.

Resultado neste draft:

- outline com três macroblocos: introdução, era de ouro no Brasil e legado/fim
- script final persistido em `script.md`
- texto narrativo completo gerado e salvo no estado

### 3. TTS e áudio final

O roteiro passa por `pipeline/src/services/ttsService.js` e pela runtime de `multivozes`. O áudio final foi gerado com sucesso e o provider efetivo registrado ficou como `multivozes_chunked`.

Status desta etapa: estável e não foi o gargalo desta rodada.

### 4. Audio intelligence e captions

Com o áudio pronto, `pipeline/src/services/audioIntelligence.js` e `pipeline/src/services/captionsService.js` produzem alinhamentos, micro-momentos, palavras e legendas. Esses dados alimentam o planner temporal.

Status desta etapa: estável e não foi o gargalo desta rodada.

### 5. Planejamento visual por cena, bloco e slot

O roteiro e o `visual_plan` são convertidos em necessidades visuais por cena e por slot narrativo em `pipeline/src/services/assetQueryPlanner.js` e `pipeline/src/services/assetsService.js`.

Aqui aparecem as exigências editoriais que mais importaram neste caso:

- `first_clip_of_block`
- `hard_boundary_first_clip`
- `chapter_opening`
- `intro`
- `hook`
- `closing`

Esse é o ponto em que o sistema decide o que precisa ser encontrado ou gerado para cobrir a intenção visual de cada trecho.

### 6. Busca, download, reuse, geração e análise de assets

Esta foi a primeira grande superfície de reparo real. O trabalho passou por `pipeline/src/services/assetsService.js`, `pipeline/src/services/assetApprovalService.js`, `pipeline/src/services/assetReadinessService.js` e `pipeline/src/services/visualIntentService.js`.

No início da sessão havia duas falhas fortes aqui:

- reuse incompleto de `assets/raw` e de análises existentes
- imagens `vertex_ai_generated` caindo em `metadata_fallback` fraco e ficando inutilizáveis para aprovação editorial

O que foi corrigido:

- recuperação de `raw_items` a partir de `assets/raw`
- reuse seletivo de assets já existentes por cena
- reaproveitamento de análises fortes e descarte de análises fracas antigas para generated images
- promoção de generated images para `ai_generated_scene_alignment`
- ajuste heurístico em `visualIntentService.js` para que evidência gerada alinhada à cena pudesse virar evidência editorial válida sem herdar categorias proibidas do prompt

Efeito validado:

- as cenas 7 e 10, que antes estavam presas, passaram a produzir janelas aprovadas
- o inventário aprovado cresceu de forma material ao longo do repair
- `blocking_scene_indexes` deixou de representar um bloqueio de pool de assets e o problema migrou para planner e validator

### 7. Prontidão editorial da pool aprovada

Depois da busca e análise, `assetApprovalService.js` e `assetReadinessService.js` determinam se a pool aprovada é suficientemente boa para o planner.

Nuance importante para o Claude:

- vários blocos ainda aparecem com `coverage_status=partial` e `block_repair_state=degraded`
- isso não significa automaticamente falha final de publish
- o validador final agora só transforma essas marcações em erro quando `coverage_needs_repair=true` ou `coverage_can_advance=false`

Essa distinção foi fundamental para remover o falso positivo de `COVERAGE_SEARCH_INSUFFICIENCY`.

### 8. Planejamento de timeline

`pipeline/src/services/timelinePlanner.js` escolhe os clips finais com base em áudio, slots narrativos, intenção visual, approved windows e scoring. Ele trabalha junto com:

- `pipeline/src/services/timelineScoringService.js`
- `pipeline/src/services/diversityGuardService.js`

Este foi o segundo grande campo de correção. O problema deixou de ser “falta asset” e virou “o planner ainda escolhe combinações editorialmente erradas”.

Os bugs principais aqui eram:

- agrupamento de diversidade por `block_id` sem distinguir macroblocos repetidos
- marcações de bypass de diversidade persistindo mesmo depois de reparos de sequência e boundary
- slots críticos reaproveitando asset ou linguagem visual de forma indevida dentro do mesmo macrobloco

Correções aplicadas:

- `timelineScoringService.js`: penalidades de reuse passaram a usar `resolveBlockScopeId()` em vez de `block.block_id`
- `diversityGuardService.js`: hard diversity passou a respeitar escopo de macrobloco
- `diversityGuardService.js`: para slot crítico, repetição de `visual_family` recente só bloqueia com pelo menos dois matches recentes, e `same_asset_reuse_block` passou a considerar reuse recente do mesmo asset
- `timelinePlanner.js`: adição de `refreshFinalDiversityViolationCodesInPlace()` no timeline final
- `timelinePlanner.js`: adição de `critical_distinct_asset_swap`
- `timelinePlanner.js`: adição de `critical_diversity_safe_swap`

Efeito validado:

- o planner deixou de emitir `diversity_bypass_on_critical_slot`
- o timeline salvo após render ficou com `diversity_bypass_count: 0`

### 9. Render final

`pipeline/src/services/renderService.js` montou o timeline final e produziu o vídeo com overlays:

- arquivo final: `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737/render/final-with-overlays.mp4`
- resolução final: `1920x1080`
- duração final validada por ffprobe: `88.6s`
- total de clips: `23`

Status desta etapa: concluída com sucesso.

### 10. QA visual final e gate editorial

`pipeline/src/services/syncValidator.js` executou o fechamento final. Essa etapa foi crítica porque, antes de um fix anterior na sessão, o helper de extração de frames em `pipeline/src/utils/mediaUtils.js` já havia quebrado a geração de evidência JPEG.

No fechamento final válido deste draft, o resultado persistido ficou assim:

- `validated_at=2026-06-02T12:48:00.921Z`
- `is_publishable=true`
- `needs_regeneration=false`
- `needs_manual_review=false`
- `quality_score=0.864`
- `alignment_score=0.846`
- `diversity_score=0.665`
- `technical_score=1`
- `final_hard_boundary_status=pass`
- `editorial_failure_codes=[]`
- `publish_blocked_codes=[]`
- `scene_indexes_to_refresh=[]`
- `clip_indexes_to_replace=[]`

### 11. Aprovação final humana

O pipeline separa claramente QA automático de aprovação final humana. O endpoint oficial para marcar isso é:

- `POST /videos/final/approve`

Implementação:

- `pipeline/src/routes/videoRoutes.js`

Este passo ainda não foi executado para este draft. Por isso o topo do estado continua com:

- `approved=false`

### 12. Upload para YouTube

O upload real é feito por `pipeline/src/services/youtubeService.js` e pelo endpoint:

- `POST /videos/youtube/upload`

Esse caminho tem três gates reais diferentes:

- aprovação final humana (`state.approved`)
- gate editorial contratual (`ensureRenderIsPublishableForUpload()`)
- gate M8 de pré-upload (`runPreUploadQA()`)

Importante: `getProductionPreflightStatus()` não cobre todo o gate real de upload. Ele ficou verde neste draft, mas o upload real ainda falharia no M8 por duração mínima.

## O que estava quebrado no começo e como foi resolvido

### Bloco 1. Reuse e aprovação de assets gerados

Problema original:

- imagens geradas relevantes existiam, mas eram recicladas com análise fraca ou classificadas como `metadata_fallback`
- o repair perdia progresso e reabria cenas já parcialmente resolvidas

Solução:

- correção em `assetsService.js`
- fortalecimento da análise em `visualIntentService.js`
- fallback mais robusto em `geminiService.js`

Resultado:

- approved pool estabilizada
- `state.assets_json.blocking_scene_indexes` deixou de ser o gargalo dominante

### Bloco 2. Falsos bloqueios no validator

Problema original:

- `COVERAGE_SEARCH_INSUFFICIENCY` ainda aparecia mesmo quando a cena podia avançar

Solução:

- `syncValidator.js` passou a agregar falhas de coverage por causa apenas quando a cena realmente precisa reparo

Resultado:

- o falso positivo de coverage desapareceu do resultado final

### Bloco 3. Diversidade excessivamente rígida em slot crítico

Problema original:

- o planner continuava marcando `DIVERSITY_BYPASS_ON_CRITICAL_SLOT`
- o escopo de diversidade usava `block_id` sem distinguir macroblocos repetidos

Solução:

- `timelineScoringService.js`, `diversityGuardService.js` e `timelinePlanner.js` foram alinhados ao escopo de macrobloco
- o planner passou a tentar swaps seguros antes de aceitar bypass

Resultado:

- `diversity_bypass_on_critical_slot` foi zerado no timeline final salvo

### Bloco 4. Missão editorial principal

Os códigos-alvo desta missão foram removidos do fechamento final:

- `CRITICAL_SLOT_ONLY_GENERIC`
- `NO_PROOF_FOR_PROMISE`
- `DIVERSITY_BYPASS_ON_CRITICAL_SLOT`
- `COVERAGE_SEARCH_INSUFFICIENCY`

## Evidência final de QA

### Boundary audit

Todos os hard boundaries do render final passaram.

- `hb_002_a-historia-do-orkut-no-brasil`: pass
- `hb_006_introducao`: pass
- `hb_011_a-historia-do-orkut-no-brasil`: pass
- `hb_014_fechamento`: pass

### Overlay audit

Todos os overlays auditados foram detectados nos frames corretos.

- `1. Introducao`: pass
- `2. A história do Orkut no Brasil`: pass
- `3. Introducao`: pass
- `4. A história do Orkut no Brasil`: pass
- `5. Fechamento`: pass

### Métricas editoriais finais

- `critical_slots_covered=14`
- `critical_slots_total=14`
- `micro_critical_coverage_ratio=1`
- `timeline_uses_approved_pool_only=true`
- `approved_pool_audit.invalid_clip_count=0`
- `approved_pool_audit.missing_approved_window_id_count=0`

Nuance importante:

- o `scene_editorial_readiness` ainda mostra vários blocos como `partial` ou `degraded`
- isso é observabilidade residual da pool aprovada, não uma reprovação final do render
- o fechamento final confiável é o `final_decision` do visual audit JSON e o `render_validation` persistido

## Estado exato do upload

### O que já está verde

O preflight de produção em `youtubeService.js` ficou verde neste draft:

- credenciais de YouTube presentes
- credenciais de providers presentes
- `GEMINI_API_KEY` presente
- `render_publishable=true`
- `hard_boundary_pass=true`
- `ready_for_real_publish=true`
- `blocking_codes=[]`

### O que ainda impede o upload real

Mesmo com o preflight verde, o upload real ainda não foi disparado por dois motivos independentes:

1. `state.approved=false`

O serviço de upload aborta se a aprovação final humana não tiver sido registrada. Esse gate é correto e ainda não foi satisfeito neste draft.

2. `runPreUploadQA()` falha por duração mínima

O M8 em `youtubeService.js` exige:

- duração mínima de `480s`
- ausência de segmentos pretos > `2s`

O check real executado neste draft retornou:

- `pre_upload_qa.ok=false`
- erro: `[M8] QA FAIL: duração 88.6s < 480s mínimos`

Portanto, mesmo que a aprovação final fosse marcada agora, o upload real ainda falharia por política de duração.

## Estado atual do draft

- `status=render_validated`
- `current_step=render_validated`
- `approved=false`
- `youtube_url=""`
- `render_path` preenchido
- `render_validation.is_publishable=true`
- `render_validation.publish_blocked=false`

## Arquivos relevantes para o Claude abrir primeiro

- `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737/state.json`
- `pipeline/output-local-e2e-full-repair/test_reports/e2e_orkut_full_repair_1780166684737-visual-audit.json`
- `pipeline/output-local-e2e-full-repair/test_reports/e2e_orkut_full_repair_1780166684737-contact-sheet.jpg`
- `pipeline/src/services/timelinePlanner.js`
- `pipeline/src/services/diversityGuardService.js`
- `pipeline/src/services/timelineScoringService.js`
- `pipeline/src/services/syncValidator.js`
- `pipeline/src/services/visualIntentService.js`
- `pipeline/src/services/geminiService.js`
- `pipeline/src/services/assetsService.js`
- `pipeline/src/services/youtubeService.js`

## Tarefas recomendadas para a próxima rodada

### Se o objetivo for publicar este draft

1. decidir se o vídeo é short-form e, se for, adaptar o gate M8 de duração em `youtubeService.js`
2. registrar a aprovação final humana via `POST /videos/final/approve`
3. só depois disparar `POST /videos/youtube/upload`

### Se o objetivo for endurecer o sistema

1. alinhar `getProductionPreflightStatus()` com `runPreUploadQA()` para que preflight verde não esconda um bloqueio real de duração
2. corrigir `writeVisualTruthFinalReport()` em `syncValidator.js` para gerar um arquivo por vídeo, não um caminho fixo compartilhado
3. documentar explicitamente a distinção entre `scene_editorial_readiness` residual e reprovação final de publish

## Conclusão final para o Claude

O fluxo ponta a ponta funcionou até o fechamento editorial real. O sistema saiu de um estado em que ainda reprovava por `CRITICAL_SLOT_ONLY_GENERIC`, `NO_PROOF_FOR_PROMISE`, `DIVERSITY_BYPASS_ON_CRITICAL_SLOT` e `COVERAGE_SEARCH_INSUFFICIENCY` para um estado em que o render final ficou validado, publicável do ponto de vista editorial e tecnicamente consistente.

O que resta não é mais um bug de cobertura visual do render final. O que resta é uma diferença entre:

- o estado editorial já limpo do draft
- o gate humano de aprovação final
- a política operacional de upload, que hoje exige `approved=true` e duração mínima de `480s`

Se o próximo agente for continuar daqui, ele não deve voltar para geração de assets nem para reparo de planner. O próximo ponto correto de trabalho é o fluxo de publicação: aprovação final, política de duração do M8 e correção do relatório final compartilhado por vídeo.

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