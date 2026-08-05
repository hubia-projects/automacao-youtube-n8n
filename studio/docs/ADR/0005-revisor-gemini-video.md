# ADR-0005 — Revisor: Gemini 2.5 Pro com input de vídeo nativo, loop limitado

**Estado:** Aceite · **Data:** 2026-07-12

## Contexto

Nenhum QA do sistema antigo "via" o vídeo montado — só checks determinísticos e vision frame-a-frame opcional. O requisito do produto é um revisor que responda: "o vídeo mostra o que o narrador diz? há repetições? o ritmo funciona?" — e que as correções sejam executáveis mecanicamente.

## Decisão

1. Revisor = **Gemini 2.5 Pro com upload do proxy 480p** (Files API), scene-ID + timecode queimados, + roteiro + `timeline.json`.
2. Output = rubrica estruturada Pydantic: notas por cena + global 0–100 + `fixes[]` de **vocabulário fechado** (`replace_shot|trim|reorder|change_transition|extend_broll`).
3. Loop: score ≥ 90 avança; senão aplica fixes, re-renderiza segmentos afetados, re-revê cenas alteradas via contact sheets (evita re-upload do vídeo inteiro). **Máx 2 iterações** + check de monotonicidade (score desce → reverter e escalar a humano). Gate humano final sempre.

## Alternativas rejeitadas

- **Contact sheets como input principal:** perde movimento, ritmo e sync de áudio — as três coisas que mais queremos avaliar. Custo do vídeo nativo é trivial (~$0.10–0.25/ronda a media resolution baixa).
- **Threshold 95 (pedido original):** rubricas LLM têm variância ±3–5; 95 gera loops a perseguir ruído. 90 + gate humano dá o mesmo resultado estável.
- **Loop sem teto:** a lição do sistema antigo — loops de reparação sem limite tornam-se a arquitetura.
- **Segundo revisor de família diferente (etapa 14 do pedido):** custo/latência ×2 sem evidência de ganho; rebaixado para Could, reavaliar com dados.

## Consequências

- Fixes são patches à timeline, nunca edição direta de media — o EDL mantém-se a única fonte de verdade.
- Todos os artefactos de revisão ficam gravados → iteração de prompt baseada em casos reais.
- Custo de revisão previsível e limitado por construção.
