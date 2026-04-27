# plan.md — n8n + Node pipeline for faceless long-form YouTube (Travel)

## 1. Objectives
- Deliver an **8-phase automated pipeline** where only manual steps are **weekly idea selection (Telegram)** and **final publish approval (Telegram)**.
- Use **n8n as orchestration only**; move heavy logic into a **Node.js + Express API** with **restart-safe file-based state** per `video_id`.
- Support **hybrid mode**: real integrations where keys exist + deterministic **mock mode** for full e2e tests.
- Provide **Docker + Docker Compose** (app + n8n + ffmpeg) and also **external-n8n** setup instructions.
- Ship complete repo structure, endpoints, state schema, n8n workflow exports, tests, and runbook.

## 2. Implementation Steps

### Phase 1 — Core POC (reliability first; do not proceed until green)
**Goal:** prove state persistence + W1→W2→W3 handoffs + mock media outputs + FFmpeg render path integrity.

User stories:
1. As a user, I want each step to be restart-safe so a container restart never loses progress.
2. As a user, I want the same `video_id` to flow across workflows so I can trace a run end-to-end.
3. As a user, I want mock mode to generate all artifacts so I can validate the pipeline without API keys.
4. As a user, I want FFmpeg to reliably produce a playable MP4 from placeholder assets.
5. As a user, I want errors persisted to state so I can resume or re-run the failed step.

Steps:
- Websearch: best practices for **idempotent workflow orchestration**, **file-locking/atomic writes**, and **FFmpeg concat/overlay** patterns.
- Scaffold Node app + folder structure + `state.json` manager:
  - `createVideo(video_id)` (UUID)
  - `loadState()`, `updateState(patch)` with atomic write + keep previous snapshot
  - strict state schema w/ `current_step`, `status`, `error_message`, timestamps
- Implement minimal endpoints (mock-first):
  - `POST /api/videos/ideas/generate` (mock ideas)
  - `POST /api/videos/ideas/approve` (persist selected idea)
  - `POST /api/videos/script/generate` (mock script.md + state)
  - `POST /api/videos/audio/generate` (mock narration.mp3 placeholder + duration)
  - `POST /api/videos/render` (FFmpeg render with placeholder image + audio; burn-in dummy subtitles)
  - `GET /api/videos/:video_id/state`
- Create 3 minimal n8n workflows (POC versions) to validate handoffs:
  - W1: manual trigger → ideas.generate → Telegram “approve idea” message with callback payload → ideas.approve → script.generate → HTTP call W2 webhook.
  - W2: webhook → audio.generate → HTTP call W3 webhook.
  - W3: webhook → render → Telegram “draft ready” message.
- POC test scripts:
  - `npm run test:poc` to run sequential curl calls in mock mode.
  - validate: files exist under `/output/draft/{video_id}/` and state fields updated correctly.
- Fix until passing: concurrency bugs, state overwrite, path issues, FFmpeg command reliability.

### Phase 2 — V1 App Development (complete endpoints + services + workflows)
**Goal:** implement full 8 phases with hybrid mock/real integrations and robust orchestration.

User stories:
1. As a user, I want weekly travel ideas ranked with AI scoring so selection is fast.
2. As a user, I want a full Portuguese script package generated and saved to disk.
3. As a user, I want audio generated via ElevenLabs with automatic OpenAI fallback.
4. As a user, I want captions (SRT/VTT) generated automatically and attached to the render.
5. As a user, I want the pipeline to stop before upload unless I explicitly approve.

Steps:
- Complete Express API (all required endpoints) + modular services:
  - `/src/services/ideasService`, `researchService`, `scriptService`, `ttsService`, `captionsService`, `assetsService`, `renderService`, `metadataService`, `youtubeService`, `telegramService`.
  - `/src/utils` for ffmpeg helpers, prompt templates, validators, logger.
- Implement each phase (real+mock):
  - (1) Ideas: OpenAI scoring + Telegram approval; persist `selected_idea`.
  - (2) Research+PT script: generate deliverables; save `state.json` + `script.md`.
  - (3) TTS: ElevenLabs primary; fallback to OpenAI TTS; write `narration.mp3`, update `duration_seconds`.
  - (4) Captions: Whisper/OpenAI transcription; local fallback stub; output `.srt` + `.vtt`.
  - (5) Assets: Pexels/Pixabay/Unsplash search with quotas/errors; fallback to “visual plan only”; download assets + `assets_json`.
  - (6) Render: FFmpeg 16:9 mp4; narration + asset sequencing + burnt-in subs; optional music bed.
  - (7) Thumbnail+metadata: generate thumbnail image + title/desc/tags/chapters; Telegram review message with artifact links.
  - (8) Final approve + upload: gate `POST /youtube/upload` behind `approved=true`; else `needs_revision`.
- Implement n8n “real” workflows (no massive code nodes):
  - W1 weekly cron → ideas.generate → Telegram approve → ideas.approve → script.generate → call W2.
  - W2 webhook → audio.generate → captions.generate → assets.search → call W3.
  - W3 webhook → render → metadata.generate → Telegram final review → wait for approval webhook → final.approve → youtube.upload.
- Repo deliverables:
  - `.env.example`, `Dockerfile`, `docker-compose.yml`, `README.md`, `n8n/workflows/*.json`.
  - output layout: `/output/draft/{video_id}/` with all artifacts.

### Phase 3 — Testing, hardening, and runbooks
User stories:
1. As a user, I want an end-to-end mock run to finish without external keys.
2. As a user, I want hybrid mode to skip only missing integrations and still complete a draft.
3. As a user, I want clear curl examples so I can debug steps individually.
4. As a user, I want W1→W2→W3 handoffs verified so automation doesn’t stall.
5. As a user, I want failure states to be explicit so I know what to re-run.

Steps:
- Add automated tests:
  - `test:e2e:mock` (full pipeline), `test:handoff` (W1→W2→W3 payload integrity), `test:state` (atomic writes, resume).
- Validation checklist:
  - state schema completeness, artifact existence, MP4 playable, subtitles visible, Telegram messages correct.
- Documentation:
  - Docker Compose run + external-n8n setup, environment key placement, Telegram bot setup, YouTube OAuth refresh token guide.
- Optional: lightweight React control panel (view state, rerun step, download artifacts) **only after** core tests are stable.

## 3. Next Actions
1. Implement Phase 1 POC scaffold (Node app + atomic state manager + minimal endpoints + mock artifacts).
2. Create POC n8n W1/W2/W3 JSON exports + Telegram approve/review messages.
3. Run `test:poc` until passing consistently (including after container restart).
4. After POC green: expand to Phase 2 full services/endpoints and replace mocks with real integrations where keys provided.

## 4. Success Criteria
- POC: deterministic mock run produces `script.md`, `narration.mp3`, and a playable `final.mp4` and persists correct state across restarts.
- V1: all required endpoints exist, update `state.json` safely, and can run end-to-end via n8n with minimal code nodes.
- Hybrid mode works: missing API keys degrade gracefully (fallback/mocks) without breaking state.
- Upload is **never executed** unless `approved=true` is explicitly set via final approval endpoint; otherwise status becomes `needs_revision`.
- Repo includes Docker setup, README runbook, workflow JSON exports, and test scripts verifying W1→W2→W3 handoffs.