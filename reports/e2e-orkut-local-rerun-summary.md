# E2E local rerun summary

- video_id: `e2e_orkut_fast_1780140215459`
- tema: `A historia do Orkut no Brasil`
- objetivo: rerun local completo sem upload no YouTube
- upload: nao executado

## Resultado validado

O pipeline local chegou ao render final com artefatos gerados em host-local.

- render principal: `pipeline/output-local-e2e-mixed-fast/draft/e2e_orkut_fast_1780140215459/render/final.mp4`
- render com overlays: `pipeline/output-local-e2e-mixed-fast/draft/e2e_orkut_fast_1780140215459/render/final-with-overlays.mp4`
- status observado no state: `render_generated`
- resolucao observada no render: `1920x1080`
- duracao observada no render: `~121.7s`

## O que foi real nesse rerun

- geracao de roteiro com Gemini/Vertex
- TTS real com Multivozes (`multivozes_chunked`, voz `alloy`)
- geracao de captions
- audio intelligence

## O que foi mock/local nesse rerun

- assets em modo deterministico local
- placeholders locais habilitados para evitar bloqueio no gargalo de assets live
- `AI_GENERATED_PLACEHOLDER_ENABLED=false` para impedir placeholder generativo via Gemini nesse rerun

## Gargalos encontrados

- host-local precisava de fallback para `/usr/bin/ffmpeg` e `/usr/bin/ffprobe`
- o caminho totalmente real de `assets_generation` continuou mais lento que o aceitavel por causa de enriquecimento pesado e indexacao/clip-library no caminho critico

## Rerun real apos o ajuste de gargalo

- draft real retomado: `pipeline/output-local-e2e-rerun/draft/e2e_orkut_rerun_1780139621757`
- ponto de retomada: `audio_intelligence_ready`
- resultado do rerun real: `assets_searched`
- render real: nao executado nesse rerun
- motivo: `missing_assets=true`

Resumo observado no rerun real apos o fix:

- `approved_items: 15`
- `approved_windows: 90`
- `blocking_scene_indexes: [1,2,4,5,6,7,8,9,10,11,12,13,14,15,16,17]`
- `render_path: ""`

Conclusao pratica:

- o problema principal desta rodada era o travamento/lentidao do `assets_generation`
- esse ponto foi corrigido: a etapa agora conclui e grava estado
- ainda existe insuficiencia editorial/visual de assets aprovados para o rerun totalmente real seguir ate render sem fallback adicional

## E2E completo limpo com busca expandida e geracao Vertex

- draft completo novo: `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737`
- fluxo executado: roteiro real + TTS real + captions + audio intelligence + assets live + geracao Vertex
- estado salvo mais avancado validado: `assets_searched`
- render: nao executado
- motivo do bloqueio: `missing_assets=true`

Checkpoint salvo no primeiro passe completo de assets:

- `raw_items: 29`
- `generated_assets: 5`
- `approved_items: 18`
- `approved_windows: 108`
- `blocking_scene_indexes: [1,2,3,4,5,6,7,8,9,10,11,12,13,14]`

Diagnostico observado nesse E2E completo:

- o pipeline entrou automaticamente em uma rodada extra de repair logo apos salvar `assets_searched`
- esse repair reabriu o bloco `introducao` com `queries_count: 13`
- Vertex/Gemini continuou respondendo com `429 Resource exhausted`, retornos sem inline image e timeouts de descricao
- o teste completo desta rodada ficou limitado por quota/latencia externa do provider e nao chegou a render final

## Acoes aplicadas no codigo

- fallback para binarios de sistema em `mediaUtils.js`
- `ttsService.js` passou a usar o caminho resolvido de ffmpeg
- `integrationHealthService.js` passou a refletir o binario executavel real
- `assetsService.js` agora limita a concorrencia da analise semantica, respeita um budget menor de janelas por asset e nao gera microclips fisicos de forma sincronica por padrao durante `assets_generation`
- `assetsService.js` agora tambem busca queries por bloco com concorrencia limitada e respeita `maxAssets` baixo de forma real nos budgets de busca/shortlist/finalistas
- `localVideoUnderstandingService.js` agora aplica timeout na chamada Python
- `geminiService.js` agora aplica retry/backoff nas chamadas Vertex `predict` e `predictLongRunning`
- `assetsService.js` agora reconstrói `raw_items` a partir de `assets/raw`, reaproveita assets ja materializados em refresh seletivo e evita reanalisar assets que ja possuem `analysis_windows`

## Validacao apos patch de reuse/retry

Validacao offline mais barata, sem Gemini/Pexels/Pixabay, para provar que o refresh seletivo nao zera mais a cena ativa:

- draft reutilizado: `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737`
- cena validada: `14`
- duracao: `~3.1s`
- `before_scene14_raw_items: 6`
- `after_scene14_raw_items: 6`
- `before_scene14_approved_windows: 36`
- `after_scene14_approved_windows: 36`

Repair live apos o patch, reutilizando o mesmo draft salvo:

- resultado final: `assets_searched`
- render: nao executado
- `raw_items: 40`
- `generated_assets: 5`
- `approved_items: 28`
- `approved_windows: 144`
- `blocking_scene_indexes: [1,2,3,4,5,6,7,8,9,10,11,12,13,14]`

Conclusao desta rodada:

- o patch resolveu o desperdicio de repair: o refresh seletivo agora reutiliza assets e analises existentes em vez de recomecar vazio
- o repair live melhorou o inventario aprovado (`18 -> 28` assets aprovados e `108 -> 144` janelas aprovadas)
- o bloqueio atual deixou de ser perda de assets no refresh e passou a ser aprovacao editorial/cobertura de slots criticos
- cenas como `7` e `10` ainda falham por `scene_has_no_editorially_approved_assets` e `scene_missing_exact_visual_proof`
- outras cenas continuam sem cobrir slots como `first_clip_of_block`, `hard_boundary_first_clip`, `chapter_opening`, `intro`, `hook` e `closing`, por isso o teste completo ainda nao chegou ao render final

## Teste completo apos fix das imagens geradas

- o bug das cenas `7` e `10` foi confirmado como reaproveitamento indevido de `metadata_fallback` em imagens `vertex_ai_generated`
- apos o fix, as duas cenas passaram para `ai_generated_scene_alignment` e deixaram de bloquear o repair
- novo teste completo no mesmo draft chegou a `render_generated` e depois `render_validated`
- render final gerado em `pipeline/output-local-e2e-full-repair/draft/e2e_orkut_full_repair_1780166684737/render/final-with-overlays.mp4`
- estado final observado:
	- `raw_items: 58`
	- `approved_items: 45`
	- `approved_windows: 195`
	- `blocking_scene_indexes: [1,2,3,4,5,6,8,9,11,12,13,14]`
	- `render_validation.is_publishable: false`
	- `render_validation.final_hard_boundary_status: pass`

Bloqueios finais do publish:

- `CRITICAL_SLOT_UNCERTAIN`
- `CRITICAL_SLOT_NOT_CONFIRMED`
- `NO_PROOF_FOR_PROMISE`
- `COVERAGE_SEARCH_INSUFFICIENCY`
- `CRITICAL_SLOT_ONLY_GENERIC`
- `DIVERSITY_BYPASS_ON_CRITICAL_SLOT`

Resumo pratico:

- o pipeline agora renderiza e valida ate o fim sem crash tecnico
- o gargalo residual passou a ser qualitativo/editorial, nao mais operacional
- ha um relatorio completo desta rodada em `reports/orkut-full-postfix-claude-report.md`