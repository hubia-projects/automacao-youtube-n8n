# ADR-0003 — Embeddings visuais: SigLIP-base + briefs sempre em inglês

**Estado:** Aceite · **Data:** 2026-07-12

## Contexto

O defeito central do sistema antigo: matching texto-sobre-texto (embedding da narração PT-BR vs descrição LLM do clip) — lossy nos dois lados. Precisamos de similaridade **cross-modal direta** (texto→imagem). Restrição de hardware: GTX 1050 Ti, 4 GB VRAM. Narração é PT-BR, mas os text towers CLIP-family são English-centric.

## Decisão

1. **SigLIP-base (patch16-384)** para embeddings de keyframes (3 por shot, mean-pooled). Cabe folgado em 4 GB; melhor que CLIP ViT-B em retrieval benchmarks.
2. **Briefs visuais gerados sempre em inglês** pelo LLM (a partir da narração PT-BR) — a query ANN nunca recebe PT-BR.
3. Semântica PT-BR entra pelo **rerank**: multilingual-e5 sobre o resumo textual dos metadados do shot vs narração.
4. Eval set de 30 pares query→shot rotulados à mão corre em CI para detetar regressão de retrieval.

## Alternativas rejeitadas

- **CLIP ViT-L / SigLIP-large:** não cabem confortavelmente em 4 GB com o resto do stack; ganho marginal para o nicho.
- **Embeddings multimodais via API (cloud):** custo por shot recorrente e latência de ingestão; embeddings locais são gratuitos e a biblioteca cresce continuamente.
- **Query em PT-BR direto no SigLIP:** degradação silenciosa de retrieval — exatamente o tipo de falha invisível que matou o sistema antigo.

## Consequências

- Custo de embedding $0; ingestão limitada só por GPU/tempo.
- Dependência estrutural: o prompt do brief TEM de produzir inglês (lint no output).
- Modelos carregados sequencialmente (nunca co-residentes com whisper) por causa dos 4 GB.
