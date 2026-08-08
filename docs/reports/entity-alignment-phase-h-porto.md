# Phase H — Porto: ENTITY ALIGNMENT antes/depois

Validação estrutural do problema fundamental do prompt:

> "Se a narração diz Francesinha, naquele intervalo devem
> aparecer imagens CONFIRMADAS de Francesinha."

Cenário: cena strict `s001` (primary_entity=Francesinha,
primary_entity_type=food); shot pré-classificado como
`food_csv="Bacalhau"`.

## ANTES (Fase G ausente): match silencioso errado

| métrica                                | valor |
|----------------------------------------|-------|
| shot atribuído                         | Bacalhau |
| food_csv do shot                       | `'Bacalhau'` |
| detection pelo pipeline               | ❌ silenciosa |
| validator emite `wrong_food_entity`    | ❌ não |
| render proxy iniciado                  | ✅ (com mismatch) |
| strict_violations                      | 1 (DESPREZADO) |

## DEPOIS (Fase G): validator + repair loop

| métrica                                | valor |
|----------------------------------------|-------|
| shot excluído pelo repair loop         | Bacalhau → Francesinha (após repair) |
| food_csv do shot final                 | `'Francesinha'` |
| detection pelo pipeline               | ✅ `wrong_food_entity` (sev=strict) |
| validator emite `wrong_food_entity`    | ✅ SIM |
| strict_violations pré  repair          | 1 |
| strict_violations pós repair           | 0 |
| render proxy iniciado                  | ✅ SOMENTE se alinhamento for resolvido |
| status final sem reparação possível    | `failed` (fail-closed) |

## Conclusão

O validator (Fase G) detecta `wrong_food_entity` para cenas
strict cujo segmento tem `food_csv` diferente da entity exigida
pela cena — exactamente o caso do prompt original. O repair loop
do S08Matching exclui o shot mismatch e re-tenta assign_shots;
se nenhuma entity confirmed surge, S08 termina status=`failed`
(fail-closed) com artefactos auditáveis.

## Limitações conhecidas

1. `_mock_metadata` apenas distingue 'food'/'monument'
   genericamente → fixture Porto usa POST-INGEST UPDATE.
2. FakeEmbedder (tests/conftest.py) não tem semântica real;
   validação do validator via `validate_alignment()` directo.
3. `_maybe_targeted_topup` ↔ `_targeted_topup_for_entity`
   mantém ~80 linhas duplicadas (sinalizado em code-reviews
   anteriores; consolidação agendada para pós-Fase H).
