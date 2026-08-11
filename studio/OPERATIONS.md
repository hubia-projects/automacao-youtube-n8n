# OPERATIONS — Guia de operação do Studio v2 (para humanos e IAs)

**Este é o ficheiro que qualquer IA/pessoa deve ler primeiro para operar o sistema.**
Arquitetura: `docs/ARCHITECTURE.md`. Estado do projeto: `README.md`.
Modo de operação atual: **sem cron — tudo é disparado a pedido pelo chat/CLI.**

## Comandos de START

```bash
cd studio    # sempre a partir de <repo>/studio; uv está em ~/.local/bin

# Vídeo completo COM upload ao YouTube (privado) no fim:
uv run studio run --topic "TEMA AQUI" --duration 12 --upload

# Sem upload (só gera o final.mp4):
uv run studio run --topic "TEMA AQUI" --duration 12

# Sugerir temas (score + cobertura da biblioteca):
uv run studio discover

# Encher a biblioteca (CRÍTICO antes de produção; ~1 noite, custo ~$1-2):
uv run studio ingest seed --count 6
```

Pré-requisito: multivozes UP → `curl -s localhost:5050/v1/models` (se DOWN:
`cd ../multivozes_br_engine && docker compose up -d`, ou o compose do legacy).

## Comandos de MONITORIZAÇÃO

```bash
uv run studio status              # lista todos os runs + custo
uv run studio status <video_id>   # detalhe: stage a stage
uv run studio costs               # ledger de custos por run
uv run studio ingest status       # nº de shots na biblioteca
```

## TEMPORARILY OFF — Telegram approval gates (2026-08-10 → até o Studio estar 100% funcional)

> Os gates do Telegram estão **desactivados** enquanto o Studio não estiver
> 100% funcional. Approvals fazem-se localmente via CLI. Reactivamos quando
> a produção estiver madura.

- **Activado em:** 2026-08-10 (sessão de alinhamento Porto / Livraria Lello).
- **Razão:** testes e melhorias end-to-end sem bloqueios por Telegram.
- **Como reverter:** pôr `STUDIO_AUTO_APPROVE_GATES=false` (ou remover) em
  `studio/.env` ou no `.env` da raiz — e repor a secção antiga deste doc.

### Approvals locais (substitui completamente o Telegram)

```bash
uv run studio approve <video_id> topic approve     # ou: final approve/reject
uv run studio resume <video_id>
```

Ou, no launch em si, passar `STUDIO_AUTO_APPROVE_GATES=true` via env:

```bash
STUDIO_AUTO_APPROVE_GATES=true uv run studio run --topic "..." --duration 5
```

(Se o utilizador clicou no botão do Telegram por inércia, ele é ignorado —
o pipeline auto-aprova via Settings.)

Run falhou a meio? `uv run studio resume <video_id>` retoma exatamente onde
parou sem refazer nada (nem custos repetidos).

## Artefactos de um run

`<repo>/data/runs/<video_id>/` → `run.json` (estado+custos),
`03_script/script.md`, `04_tts/narration.wav`, `09_timeline/timeline.json`,
`10_render_proxy/proxy_480p.mp4`, `11_review/review_r*.json` (nota do revisor),
`12_render_final/final.mp4`, `13_package/` (metadata, thumbnail, srt),
`14_upload/upload_receipt.json`.

## Respostas a dúvidas frequentes do operador

- **Seed já funciona?** SIM — Gemini vision + SigLIP + Pexels/Pixabay testados
  reais. Só falta CORRER (`ingest seed`). Biblioteca atual: ~30 shots; meta ≥2.000.
  É a razão do score 45/100 do revisor — sem seed nenhum vídeo passa dos 90.
- **Música grátis automática?** Não há API livre fiável (YouTube Audio Library
  não tem API). Caminho: descarregar manualmente da YouTube Audio Library →
  meter mp3 em `<repo>/data/music/` → o ducking sidechain ativa sozinho.
- **Vídeos-referência:** solução inteligente pendente (usar discovery p/ achar
  outliers do nicho e propor no Telegram). Por agora: 3-5 URLs à mão em
  `docs/REFERENCE_VIDEOS.md`.
- **Legendas queimadas:** desligadas por defeito (STUDIO_BURN_CAPTIONS=0);
  SRT é sempre gerado e sobe com o upload.

## BACKLOG — estado (atualizado 2026-07-13, fim da sessão)

1. ✅ **`studio watch`** — daemon implementado: `uv run studio watch`
   (poll 20s; `--once` para 1 passagem; `--retry-failed` opcional). Retoma
   runs em waiting_approval após clique no Telegram ou `studio approve`.
   Para automação total, deixar a correr num terminal/tmux.
2. ✅ **Fallback ElevenLabs** — cascata multivozes→ElevenLabs em
   `audio/tts_client.py` (dispara se multivozes DOWN ou falhar a meio).
3. ✅ **Auto-arranque multivozes** — healthcheck + `docker compose up -d`
   automático antes do TTS (`_ensure_multivozes`).
4. ✅ **`studio cleanup`** — `uv run studio cleanup --keep 10
   [--compact-library]`: apaga runs além dos 10 recentes (nunca toca em
   `data/library/`); compacta media >20MB de shots nunca usados para 720p
   crf30 (embeddings/metadados intactos). Correr manualmente ou juntar ao
   fim de cada produção.
5. POR FAZER (aprovado): **fonte de música Freesound** (chaves já no .env:
   FREESOUND_API_KEY/CLIENT_ID; busca CC0 instrumental → data/music/ com
   licença registada); **paralelização do seed** (3-4 workers no processo,
   escrita LanceDB em série — corta seed para ~2h); **fonte Vimeo**:
   IMPLEMENTADA (sources/vimeo.py, credenciais no .env) mas a pesquisa
   pública devolve "restricted in your region" — bloqueio da Vimeo para
   contas free/não-parceiras; código fica pronto para plano Pro/parceria.
   **Veo (geração)**: IMPLEMENTADO como último degrau do matching
   (library/veo.py + gancho no assigner), DESLIGADO por defeito — ativar
   com STUDIO_VEO_ENABLED=1 (cap STUDIO_VEO_MAX_PER_VIDEO=4, ~$2/clip 8s,
   license=owned, prompt força "no people faces"; smoke real pendente —
   testar 1 geração antes de confiar).
6. POR FAZER (menores): threshold de relevância na cobertura do discovery;
   beat grid musical quando houver música em `data/music/`; contact sheets
   na 2ª ronda do revisor (poupa ~$0.10/ronda).
6. **Cutover cancelado pelo utilizador** — `pipeline/` (Node legacy) pode ser
   arquivado quando conveniente.

**Resumo da sessão que construiu tudo: `SESSION-2026-07-13.md`.**
