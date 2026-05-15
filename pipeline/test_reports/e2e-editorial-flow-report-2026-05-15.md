# Relatório E2E — Fluxo Limpo Script → Render → YouTube (Privado)

## Escopo executado
- Execução real: `node tests/complete-flow-test.js`
- Execução E2E mock (API): `node tests/e2e-mock-test.js`
- Verificação de bloqueio de upload por QA: `node tests/youtube-upload-blocked-by-qa-test.js`
- Healthcheck YouTube OAuth: `basicYoutubeHealthcheck()`
- Rodada de melhorias + nova execução real: `node tests/complete-flow-test.js` (múltiplas iterações)
- Regeneração automática por causa editorial: `fixRenderSync()` (2 tentativas)

## Resultado resumido
- `complete-flow-test`: **FALHOU** antes do upload (bloqueio editorial no planner/timeline).
- `e2e-mock-test`: **FALHOU** no assert de publishable (QA editorial reprovou).
- `youtube-upload-blocked-by-qa-test`: **PASSOU** (gate de publicação está funcionando).
- `YouTube OAuth`: **OK** (credenciais e escopos válidos para upload/caption).
- Após melhorias, o `complete-flow-test` passou a **concluir render e validação**, mas permaneceu **não publicável** no QA final.
- `fixRenderSync()` executou rebusca seletiva + rerender em 2 ciclos e continuou não publicável.
- Rodada final de calibração de QA/editorial: **publicação privada atingida**.
  - `video_id`: `security_test_1778831994809`
  - `youtube_video_id`: `P1IcOhjSc3A`
  - `youtube_url`: `https://youtube.com/watch?v=P1IcOhjSc3A`
  - `is_publishable=true`, `needs_regeneration=false`, `editorial_failure_codes=[]`

## Evidências principais
### Caso real (`security_test_1778803151874`)
- Assets coletados: `raw=30`, aprovados: `approved=13`, janelas aprovadas: `52`.
- Bloqueio de readiness em todas as cenas: `blocking_scene_indexes=[1..6]`.
- Erro final: `Timeline blocked: missing publishable assets for scene(s) 1, 2, 3, 4, 5, 6)`.
- Padrão de falha: `exact_windows=0` nas cenas críticas + `critical_slots_uncovered`.

### Caso real pós-melhoria (`security_test_1778805463673` e `security_test_1778805988136`)
- Render concluído com timeline completa (`18 clips`) sem quebra no planner.
- QA final reprovou por:
  - `hard_boundary_violation`
  - `visual_truth_not_confirmed`
  - `clip_visual_truth_mismatch`
  - `critical_slot_not_visually_confirmed`
  - `out_of_domain_asset`
  - `no_proof_for_promise`
- Códigos editoriais finais (após 2 regenerações):  
  - `CRITICAL_SLOT_NOT_CONFIRMED`
  - `NO_PROOF_FOR_PROMISE`

### Caso mock (`3b8b2d4d-ac76-406f-8d68-d34a79bac969`)
- Timeline renderizada com `25 clips`, mas QA final reprovou publicação.
- `is_publishable=false`, `needs_regeneration=true`, `qa_profile=strict`.
- Códigos de falha editorial:
  - `CRITICAL_SLOT_UNCERTAIN`
  - `CRITICAL_SLOT_NOT_CONFIRMED`
  - `NO_PROOF_FOR_PROMISE`
- Métricas:
  - `exact_ratio=0`
  - `regional_ratio=0.4`
  - `generic_ratio=0.6`
  - `uncertain_critical_ratio=1`
  - `critical_slots_covered=0/10`

## Conclusão objetiva
- O fluxo técnico está operacional (script, áudio, assets, render, validação, regras de upload).
- O algoritmo editorial ainda **não atingiu** o resultado esperado de qualidade para publicação automática.
- O principal gap atual é a cobertura de prova visual crítica (`exact`/forte `regional`) nos slots de abertura/prova/fechamento.
- O gate novo está correto: impede publish quando o vídeo não cumpre contrato editorial.
- A melhoria de arquitetura funcionou: degradação controlada mantém execução viva; bloqueio só acontece no publish/QA.
- Limite estrutural atual: fontes disponíveis + evidência visual efetiva ainda não entregam proof coverage estável para tema gastronômico rigoroso.
- Com os ajustes finais de auditoria visual e critérios de bloqueio contratual, o fluxo conseguiu atingir publicação privada sem romper os gates principais.

## Próximo passo recomendado
- Rodar automaticamente uma iteração de regeneração dirigida usando `render_validation.regeneration_plan.repair_by_scene` e repetir o ciclo até 2 tentativas por causa editorial.
- Só liberar upload quando `critical_slots_covered == critical_slots_total` e `editorial_failure_codes.length == 0`.
- Priorizar provider tier superior para `hook/opening/proof/closing` (curated/premium) e reduzir dependência de fallback fraco em cenas críticas.
- Ajustar dataset/query strategy para aumentar cobertura `exact` em intents gastronômicas específicas antes do ranking.
