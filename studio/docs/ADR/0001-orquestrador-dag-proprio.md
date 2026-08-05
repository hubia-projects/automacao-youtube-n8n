# ADR-0001 — Orquestrador: DAG Python próprio, não LangGraph nem Temporal/Prefect

**Estado:** Aceite · **Data:** 2026-07-12

## Contexto

O pipeline é uma sequência quase-linear de 14 stages com 2–3 loops limitados (critique do roteiro, revisor→fix). Operador solo, 1 máquina, 2 vídeos/semana. A necessidade real é **resumabilidade** (retomar exatamente onde falhou), não escala distribuída. O sistema antigo morreu por acreção e por lutar contra as próprias abstrações — v2 não pode começar com um mismatch de framework.

## Decisão

Runner de DAG próprio (~400 linhas): protocolo `Stage` + runner que executa em ordem, salta stages `done` (outputs existem + manifest valida) e persiste `run.json` após cada stage. Loops limitados são `for` loops dentro de um stage composto.

## Alternativas rejeitadas

- **Temporal / Prefect:** exigem servidor/daemon e workers; compram execução distribuída e visibilidade multi-tenant que não precisamos. O imposto de infra excede 100% do valor entregue. Resumabilidade obtém-se com checkpoints em disco.
- **LangGraph:** brilha em control-flow dinâmico decidido por LLM. Este pipeline é estático; codificá-lo em LangGraph significa lutar contra semântica de merging de estado e um checkpointer desenhado para threads de chat, não artefactos de vídeo de 2 GB.

## Consequências

- Orquestrador legível em 10 minutos; `studio resume <id>` trivial.
- Sem dependência de framework volátil na espinha dorsal.
- **Escape hatch:** se o loop revisor evoluir para negociação multi-agente genuína, esse único nó pode ser embrulhado em LangGraph — o contrato de Stage torna isso uma decisão local.
