# ADR-0002 — Base vetorial: LanceDB embutido

**Estado:** Aceite · **Data:** 2026-07-12

## Contexto

A biblioteca precisa de ANN sobre embeddings visuais (SigLIP, f32[768]) **com filtros de metadados ricos na mesma query** (ex.: `food_items != [] AND quality >= 6`). Escala: dezenas de milhares de shots nos próximos anos. Acabámos de eliminar o n8n para reduzir daemons — não vamos adicionar outro.

## Decisão

**LanceDB**, uma tabela `shots`: `shot_id, media_sha, t_in, t_out, siglip_vec, text_vec, meta (struct), license, quality, usage_count, last_used_run`.

## Alternativas rejeitadas

- **qdrant (local):** excelente, mas quer correr como serviço — mais um daemon para gerir, atualizar e monitorizar.
- **sqlite-vec:** embutido, mas filtragem por metadados + scoring híbrido viram exercício manual de joins; vetores e metadados vivem separados.
- **pgvector / Pinecone / Weaviate:** servidor ou cloud; desproporcional para operador solo com dados locais.

## Consequências

- Zero processos extra; a base é um diretório (`data/library/lancedb/`) — backup = cópia.
- ANN filtrado nativo numa query; Python-first; datasets versionados.
- Teto de escala (~milhões de vetores) está a décadas do necessário.
