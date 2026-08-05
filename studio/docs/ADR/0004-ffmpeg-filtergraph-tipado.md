# ADR-0004 — Render: FFmpeg puro via builder de filtergraph tipado

**Estado:** Aceite · **Data:** 2026-07-12

## Contexto

O render precisa de: cortes/xfade com offsets exatos, Ken Burns (zoompan), LUTs, sidechain ducking, loudnorm 2-pass, legendas ASS, cache de segmentos. O sistema antigo já provou a matemática FFmpeg relevante (`renderService.js`: zoompan, offsets de xfade, loudnorm) — o problema era organização, não capacidade.

## Decisão

FFmpeg invocado diretamente, com um **módulo builder de filter_complex tipado** em Python (`render/filtergraph.py`): objetos compõem o grafo, serialização para string acontece num único sítio, testável por unit tests sem correr FFmpeg. Portar a matemática comprovada do `renderService.js`.

## Alternativas rejeitadas

- **moviepy:** lento (frame-a-frame em Python), faminto de memória em vídeos de 15 min, manutenção irregular.
- **Remotion:** React/Node — reintroduz o runtime que estamos a abandonar; força pensamento frame-based para um problema que é de composição de streams.
- **Shotstack/APIs de render cloud:** custo por render, upload de GB de assets, perda de controlo fino de áudio.

## Consequências

- Duas qualidades de render (proxy 480p ultrafast; final 1080p) com o mesmo grafo.
- Cache de segmentos keyed por hash da entrada da timeline → fixes re-renderizam só o alterado.
- Strings de filtergraph nunca concatenadas à mão fora do builder (a lição das 2.036 linhas do renderService antigo).
