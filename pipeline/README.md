# Automated n8n + Node.js Pipeline for Faceless YouTube Videos (MVP)

Este projeto implementa um pipeline completo, modular e restart-safe para criar vídeos faceless long-form (10–15 min) com n8n como orquestrador e backend Node.js/Express para lógica pesada.

## ✅ O que foi entregue

- Backend Node.js + Express com arquitetura modular:
  - `src/services`
  - `src/routes`
  - `src/utils`
- Persistência por arquivo JSON por `video_id` em:
  - `output/draft/{video_id}/state.json`
  - snapshots históricos em `output/draft/{video_id}/history/`
- Fluxo completo (8 fases) com endpoints REST:
  - `POST /api/videos/ideas/generate`
  - `POST /api/videos/ideas/approve`
  - `POST /api/videos/script/generate`
  - `POST /api/videos/audio/generate`
  - `POST /api/videos/audio/intelligence`
  - `POST /api/videos/captions/generate`
  - `POST /api/videos/assets/search`
  - `POST /api/videos/render`
  - `POST /api/videos/render/validate`
  - `POST /api/videos/render/fix-sync`
  - `POST /api/videos/metadata/generate`
  - `POST /api/videos/final/approve`
  - `POST /api/videos/youtube/upload`
  - `GET /api/videos/:video_id/state`
- Integrações reais (via `.env`) + mock mode:
  - OpenAI
  - ElevenLabs
  - Pexels/Pixabay
  - Telegram
  - YouTube Data API
- Render com FFmpeg (16:9), áudio + legenda burn-in
- Planner narrativo hierárquico + timeline guiada por `audio_intelligence.words`
- Busca de assets por bloco narrativo + negative keywords + fallback cidade->pais->equivalente tematico + análise por janelas temporais + scene_asset_readiness por cena
- QA automático de render com score técnico, score semântico, detecção de black frames e regeneração seletiva, com upload bloqueado quando o render não é publicável
- Overlays opcionais de bloco/cidade e output 1080p por padrão
- Workflows n8n exportados:
  - `n8n/workflow1_weekly_topic_script.json`
  - `n8n/workflow2_audio_captions_assets.json`
  - `n8n/workflow3_render_youtube.json`
- Dockerfile + docker-compose
- Scripts de teste e healthcheck de integrações reais

---

## Estrutura

```bash
pipeline/
├── src/
│   ├── routes/
│   ├── services/
│   ├── utils/
│   ├── app.js
│   └── index.js
├── n8n/
│   ├── workflow1_weekly_topic_script.json
│   ├── workflow2_audio_captions_assets.json
│   └── workflow3_render_youtube.json
├── tests/
│   ├── poc-core-test.js
│   ├── e2e-mock-test.js
│   ├── handoff-test.js
│   ├── real-integration-check.js
│   └── sample-n8n-payloads/
├── output/
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## Arquitetura Semântica Atual

- `narrativeBlockPlanner.js`: cria macroblocos e microblocos por cidade, tema e intenção visual.
- `audioIntelligence.js`: gera `words`, `segments`, `pause_markers` e boundaries sugeridas.
- `assetsService.js`: busca assets por bloco, analisa vídeos por janelas, registra `scene_queries` e persiste `scene_asset_readiness`.
- `assetQueryPlanner.js`: expande queries por visual intent com fallback cidade -> país -> equivalente temático.
- `timelinePlanner.js`: usa texto real do áudio por intervalo para escolher a melhor janela visual.
- `syncValidator.js` + `renderQualityService.js`: validam alinhamento, diversidade, black frames, silêncio e resolução antes da revisão.
- `overlayService.js`: cria overlays simples de capítulo/cidade no início dos blocos.

---

## 1) Configuração local

```bash
cd /app/pipeline
cp .env.example .env
```

Preencha seu `.env` localmente (não compartilhe chaves no chat):

- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `PEXELS_API_KEY`
- `PIXABAY_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`

### OAuth do YouTube

Para validar se o refresh token ainda funciona:

```bash
yarn auth:youtube:check
```

Se o retorno vier com `invalid_grant`, o refresh token foi revogado, expirou ou nao corresponde mais ao client OAuth atual. Nesse caso:

```bash
yarn auth:youtube:url
yarn auth:youtube:exchange <authorization_code>
```

Depois troque o valor de `YOUTUBE_REFRESH_TOKEN` no seu `.env` pelo token novo retornado no segundo comando.

### Modo híbrido (recomendado)

- `MOCK_MODE=true`: gera pipeline completo sem APIs pagas.
- `MOCK_MODE=false`: usa integrações reais quando disponíveis.
- `ALLOW_PLACEHOLDER_ASSETS=false`: em produção, placeholder local não conta como asset publicável e bloqueia render/upload quando faltar asset real.
- Mesmo com `MOCK_MODE=false`, se uma integração falhar, o pipeline pode usar fallback técnico em etapas como TTS, mas não mascara falta de asset visual real com sucesso falso.

### Sincronização semântica de B-roll

- `SEMANTIC_SYNC_MODE=cost-efficient`: janelas visuais e QA mais econômicos.
- `SEMANTIC_SYNC_MODE=high-quality`: janelas mais densas e QA visual com mais amostras quando OpenAI estiver configurado.
- `SEMANTIC_SYNC_MAX_LATENCY_SEC=1`: latência máxima aceita após troca de tópico principal.
- O render usa `concat` quando há hard-boundaries para evitar `xfade` entre cidades/tópicos diferentes.

---

## 2) Rodar com Node local

```bash
yarn install
yarn start
```

API disponível em `http://localhost:8080`.

Healthcheck:

```bash
curl http://localhost:8080/api/health
curl http://localhost:8080/api/health/integrations
```

---

## 3) Rodar com Docker Compose (app + n8n)

```bash
yarn docker:up:build
```

Alternativas:

```bash
yarn docker:up
yarn sync:n8n:dry
```

- App (host): `http://localhost:8081` (configurável via `APP_HOST_PORT`)
- n8n (host): `http://localhost:5679` (configurável via `N8N_HOST_PORT`)

Internamente na rede Docker:

- App: `http://app:8080`
- n8n: `http://n8n:5678`

Sincronize os workflows da pasta `n8n/` com o n8n persistido:

```bash
yarn sync:n8n
```

O comando faz upsert por nome, preservando os IDs ja existentes no n8n quando o workflow ja estiver importado.
Use `yarn sync:n8n:dry` para ver o plano sem importar alteracoes.

---

## 4) Testes

Testes focados novos desta rodada:

- `yarn test:no-placeholder-assets`
- `yarn test:youtube-upload-blocked-by-qa`
- `yarn test:manual-review`
- `yarn test:provider-search-fallback`

### POC Core (fase crítica)

Valida o núcleo: ideia -> aprovação -> script -> áudio -> render -> estado persistido.

```bash
yarn test:poc
```

### Sincronização semântica

Valida hard-boundary Lisboa -> Porto, rejeição do tópico anterior e métricas de lag.

```bash
yarn test:semantic-sync
```

### E2E mock completo

```bash
yarn test:e2e:mock
```

### Handoff entre workflows

Valida payload W1→W2 e W2→W3 (`video_id`, `topic`, `script_text`, `state_path`, etc.).

```bash
yarn test:handoff
```

### Healthcheck de integrações reais

Somente valida integrações que estiverem configuradas no `.env`.

```bash
yarn test:integrations
```

---

## 5) Exemplos de cURL (pipeline completo)

### 1. Gerar ideias

```bash
curl -X POST http://localhost:8080/api/videos/ideas/generate \
  -H "Content-Type: application/json" \
  -d '{"count":5,"mock_mode":true}'
```

### 2. Aprovar ideia

```bash
curl -X POST http://localhost:8080/api/videos/ideas/approve \
  -H "Content-Type: application/json" \
  -d '{"video_id":"<VIDEO_ID>","idea_number":1,"mock_mode":true}'
```

### 3. Gerar script

```bash
curl -X POST http://localhost:8080/api/videos/script/generate \
  -H "Content-Type: application/json" \
  -d '{"video_id":"<VIDEO_ID>","mock_mode":true}'
```

### 4. Gerar áudio

```bash
curl -X POST http://localhost:8080/api/videos/audio/generate \
  -H "Content-Type: application/json" \
  -d '{"video_id":"<VIDEO_ID>","provider":"elevenlabs","mock_mode":true}'
```

### 5. Gerar legendas

```bash
curl -X POST http://localhost:8080/api/videos/captions/generate \
  -H "Content-Type: application/json" \
  -d '{"video_id":"<VIDEO_ID>","mock_mode":true}'
```

### 6. Buscar assets

```bash
curl -X POST http://localhost:8080/api/videos/assets/search \
  -H "Content-Type: application/json" \
  -d '{"video_id":"<VIDEO_ID>","mock_mode":true,"max_assets":8}'
```

Com `MOCK_MODE=false` e `ALLOW_PLACEHOLDER_ASSETS=false`, cenas sem asset real ficam marcadas em `assets_json.scene_asset_readiness` e o render passa a ser bloqueado.

### 7. Renderizar vídeo

```bash
curl -X POST http://localhost:8080/api/videos/render \
  -H "Content-Type: application/json" \
  -d '{"video_id":"<VIDEO_ID>","mock_mode":true}'
```

### 8. Gerar metadados

```bash
curl -X POST http://localhost:8080/api/videos/metadata/generate \
  -H "Content-Type: application/json" \
  -d '{"video_id":"<VIDEO_ID>","mock_mode":true}'
```

### 9. Aprovação final

```bash
curl -X POST http://localhost:8080/api/videos/final/approve \
  -H "Content-Type: application/json" \
  -d '{"video_id":"<VIDEO_ID>","approved":true,"note":"ok","mock_mode":true}'
```

### 10. Upload YouTube (somente se `approved=true` e `render_validation.is_publishable=true`)

```bash
curl -X POST http://localhost:8080/api/videos/youtube/upload \
  -H "Content-Type: application/json" \
  -d '{"video_id":"<VIDEO_ID>","privacy_status":"private","mock_mode":true}'
```

### 11. Consultar estado

```bash
curl http://localhost:8080/api/videos/<VIDEO_ID>/state
```

---

## 6) Como usar com n8n externo (já existente)

Se você já tem n8n rodando fora do docker-compose:

1. Rode apenas o app Node localmente ou em container próprio.
2. No n8n, importe os 3 JSONs da pasta `n8n/`.
3. Configure variável de ambiente no n8n:
   - `BACKEND_BASE_URL=http://SEU_BACKEND:8080`
   - `MOCK_MODE=true|false`
4. Ajuste os nós `Wait` para receber aprovação (webhook de resume).
5. Para aprovação via Telegram:
   - fluxo envia ideias no Telegram
   - você responde/aprova no mecanismo do seu n8n
   - n8n chama `/api/videos/ideas/approve`
6. Final approval idem:
   - n8n chama `/api/videos/final/approve`
   - se aprovado, chama `/api/videos/youtube/upload`

---

## 7) Regras importantes

- Upload nunca ocorre sem `approved=true`.
- Upload também fica bloqueado se `render_validation.is_publishable` não for `true` ou se houver `needs_regeneration` / `needs_manual_review`.
- Placeholder local só pode atravessar o pipeline quando `MOCK_MODE=true` ou `ALLOW_PLACEHOLDER_ASSETS=true`.
- Se o pós-fix do W3 continuar falhando, o fluxo deixa de seguir para metadata normal e marca `needs_manual_review`.
- Estado é salvo continuamente em `state.json` + snapshots históricos.
- Erros são persistidos em `error_message`.
- O backend evita lógica pesada dentro do n8n (n8n fica como orquestrador).

---

## 8) Campos de estado suportados

O estado contém todos os campos solicitados:

- `video_id`
- `idea_id`
- `topic`
- `angle`
- `status`
- `current_step`
- `approved`
- `selected_idea`
- `ideas`
- `research_json`
- `outline_json`
- `script_text`
- `script_path`
- `audio_path`
- `duration_seconds`
- `caption_path_srt`
- `caption_path_vtt`
- `assets_json`
- `render_path`
- `thumbnail_path`
- `youtube_title`
- `youtube_description`
- `youtube_tags`
- `youtube_chapters`
- `youtube_video_id`
- `youtube_url`
- `error_message`
- `created_at`
- `updated_at`

---

## 9) Produção (checklist rápido)

- [ ] `MOCK_MODE=false`
- [ ] `ALLOW_PLACEHOLDER_ASSETS=false`
- [ ] Chaves preenchidas no `.env`
- [ ] `/api/health/integrations` com status OK para providers configurados
- [ ] `yarn test:handoff` OK
- [ ] workflow importado e ativado no n8n
- [ ] aprovação final confirmada antes de upload
- [ ] render validado com `is_publishable=true` antes do upload

---

## 10) Notas de evolução

Este MVP está preparado para melhorias criativas sem alterar a arquitetura central:

- Melhorar qualidade dos prompts e scoring
- Adicionar geração real de thumbnail com modelo de imagem
- Melhorar timeline com transições mais complexas
- Estratégia avançada de fallback por provider
