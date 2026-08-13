# Contrato de intervenção do operador

O pipeline (`studio run ...`) é uma automação. O operador define os
parâmetros do vídeo e corre `studio run` uma vez; o software decide o
resto (pesquisa, aquisição, matching, render). A lista abaixo é a lista
**completa e definitiva** de circunstâncias que exigem uma decisão humana.
Qualquer outra situação é resolvida automaticamente pelo pipeline.

## 1. Credencial externa inválida ou ausente

**Quando:** a chave Gemini configurada (`GEMINI_API_KEY`) responde
401/403, ou não está configurada.

**Sinal:** `S08Matching` falha imediatamente (`preflight_gemini_credentials`,
antes de qualquer trabalho de biblioteca/matching) com
`GEMINI_CREDENTIALS_INVALID: HTTP <status>` ou `GEMINI_CREDENTIALS_MISSING`
nas notas do stage.

**Acção do operador:** configurar uma `GEMINI_API_KEY` válida no ambiente
(`.env` ou variável de ambiente) e correr `studio resume <video_id>`. O
run retoma do ponto onde ficou — nenhum trabalho anterior é perdido.

**Nunca:** a key nunca é impressa em logs, eventos ou respostas HTTP
(`SecretRedactionFilter`, `logging_setup.py`).

## 2. Aprovação de aquisição de biblioteca

**Quando:** a biblioteca (global + já indexada para este workset) não
cobre todos os requirements do vídeo, e o run NÃO foi iniciado com
`--auto-acquire-library`.

**Sinal:** `S08Matching` devolve `status="waiting_approval"` com uma
mensagem no formato `gate: library (N/M cobertos — <deficits nomeados>)`.

**Acção do operador:**
```bash
studio approve <video_id> library approve   # autoriza a aquisição
studio approve <video_id> library reject    # cancela o run (stop limpo)
studio resume <video_id>                    # retoma após a decisão
```
`approve` nunca significa "continuar com a biblioteca incompleta" — o
pipeline só avança para matching depois da biblioteca ficar
`WORKSET_READY` (via aquisição automática) ou o operador rejeitar.

## 3. Orçamento/custo (se configurado)

**Quando:** o run atinge `budget_usd` configurado em `RunState`.

**Sinal:** `StageResult` com `error="budget_exceeded"` (ver
`orchestrator/runner.py::check_budget`).

**Acção do operador:** ajustar o orçamento do run ou aceitar o custo
incorrido e decidir se continua manualmente.

## 4. Problema fatal de licenciamento/conteúdo

**Quando:** um asset adquirido é rejeitado por licença inválida
(`LicenseError`, `LIBRARY_POLICY.md`) de forma persistente para um
requirement estrito, sem alternativa viável na biblioteca global.

**Sinal:** `S08 G-alignment FAIL` nas notas do stage, com
`alignment_report.json` a listar as violações estritas persistentes.

**Acção do operador:** revisar o roteiro (o tópico pode precisar de
reformulação) ou fornecer footage própria (`studio ingest --path ...`)
para o requirement em causa.

## 5. Aprovação final de upload (se `--upload` estiver activo)

**Quando:** o vídeo final está pronto e o run foi iniciado com
`--upload`.

**Sinal:** gate `"final"` (mesmo mecanismo dos gates acima).

**Acção do operador:** `studio approve <video_id> final approve|reject`.

**Nota:** por defeito (`--upload` omitido) o upload é sempre saltado —
`UPLOAD = OFF` é o comportamento padrão; o pipeline nunca publica no
YouTube sem este flag explícito.

---

## O que NUNCA precisa de intervenção humana

- Decidir o que pesquisar, quando pesquisar, ou quantas waves de aquisição
  correr (`AcquisitionService`/`run_acquisition_for_workset` — item 1.4).
- Calcular cobertura, deficits, ou feasibility de selecção
  (`RequirementIndex`, `is_workset_ready`, `selection_feasible`).
- Confirmar visualmente entidades estritas (`require_entity_confirmation`
  progressivo).
- Decidir quando parar de adquirir (para assim que `WORKSET_READY`, nunca
  por um alvo arbitrário de nº de assets).
- Resumir depois de um crash/reinício de processo (`studio resume`) —
  estado persistido a cada stage, wave de aquisição, e confirmação.
- Continuar automaticamente de matching → timeline → render → package
  depois da biblioteca ficar pronta.
