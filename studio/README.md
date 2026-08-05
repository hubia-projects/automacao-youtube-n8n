# Studio v2

Plataforma de automação de vídeos YouTube — reescrita greenfield (Python 3.12, uv).
Documentação completa em [docs/](docs/) (PRD, ARCHITECTURE, ADRs, ROADMAP, LIBRARY_POLICY).

## Estado

**Fase 1 completa** — orquestrador DAG com checkpoints/resume, estado + cost ledger,
budget breaker, gates Telegram (com modo mock), CLI.
**Fase 2 completa (código)** — biblioteca: ingestão fail-closed com licenças,
shot detection (PySceneDetect), embeddings SigLIP (GPU: torch 2.5.1+cu121, única
linha com suporte Pascal/1050 Ti — não fazer upgrade de torch sem verificar),
metadados Gemini Flash vision, LanceDB, busca híbrida com filtros duros.
Falta: seed ≥2.000 shots (`seed/queries_travel_pt.txt`).
**Fase 3 completa (verificada com run real)** — roteiro multi-pass
(research grounded → outline → draft → critique → humanize GPT-4o → lint
anti-slop com passe corretivo), TTS multivozes, word timestamps
faster-whisper large-v3-turbo local, segmentação de cenas com beats.
Pipeline `produce` (s01-s06): `uv run studio run --topic "..." --duration 12`.
Gates Telegram não-bloqueantes (run pára em waiting_approval; decisão via
botão ou `studio approve`). 38 testes verdes. Run real: 2 min de vídeo →
$0.095 de APIs. Modelos: aliases `gemini-pro-latest`/`gemini-flash-latest`
(2.5-pro deu 404 a novos utilizadores).
**Fase 4 completa (verificada com run real)** — briefs visuais Flash (EN,
must_have/must_not), matching com filtros duros + constraints (shot ≤1×/vídeo,
ficheiro ≤3×, cooldown), escada de relaxamento nomeada (must_not nunca cede;
último degrau = reutilização controlada, registada em `relaxations`),
top-up JIT (Pexels→ingestão→re-busca), `timeline.json` (EDL) com transições
disciplinadas e Ken Burns dirigido por metadados. Pipeline s01-s09.
Beat grid musical (librosa) adiado para a Fase 5 (render).
**Fase 5 completa (verificada com render real)** — renderer FFmpeg: segmentos
cacheados por hash (RENDER_VERSION invalida), montagem sync-exata com a
narração como master (gaps de pausa cobertos com freeze tpad; xfade só com
headroom real na origem; concat re-encode — `-c copy` gerava PTS que partiam
o xfade), zoompan com `s=` explícito (default 1280x720 partia o concat),
legendas ASS, loudnorm 2-pass -14 LUFS (±1.0 por teto de true-peak em voz),
sidechain ducking pronto (ativa quando houver música em data/music),
proxy 480p com timecode queimado (input do revisor). Real: final.mp4 1080p
114.0s vs narração 114.1s.
**Fase 6 completa (verificada real)** — loop revisor: Gemini Pro vê o proxy
(Files API), rubrica estruturada, fixes de vocabulário fechado
(replace_shot re-corre matching da cena com exclusão dura + rebuild timeline
+ re-render só do alterado via cache), máx 2 rondas, monotonicidade, gate
final Telegram SEMPRE com o relatório. E2E sabotagem passa (monumento em
cena de comida → detetado → corrigido → ≥90). Revisor real deu 45/100 ao
smoke com biblioteca de ~60 shots ("blueberry tart instead of pastel de
belém") — honesto; qualidade sobe com o seed da biblioteca. Custo total do
run real completo (s01→s12 com revisor): $0.23.
**Fase 7 completa (código + package verificados reais)** — s13 package:
metadata Flash (título/descrição/tags/capítulos com timestamps das cenas,
atribuições CC agregadas na descrição), SRT, thumbnail (frame real do payoff
+ Pillow); s14 upload: OAuth por refresh token (mesmas credenciais do
legacy), videos.insert + captions.insert + thumbnails.set via httpx,
privado por defeito, saltado sem `--upload`. Upload real ao canal ainda NÃO
executado (1 comando, ver abaixo).
**Fase 8 completa (v1)** — `studio discover [--telegram]`: shortlist de temas
(brainstorm Flash + calendário sazonal `seed/seasonal_pt.yaml` + **cobertura
da biblioteca** pesando 40% do score); `studio costs` (ledgers);
`studio ingest seed` (corre a lista inteira de queries nos 2 providers).
Adiado: YouTube Data API/pytrends como sinais de demanda (frágeis; cobertura
é o sinal que muda decisões). Cobertura v1 = contagem top-30 do ANN, sem
threshold de relevância — afinar com a biblioteca grande.

**Cron sugerido** (`crontab -e`):
```
0 3 * * *  cd <repo>/studio && ~/.local/bin/uv run studio ingest seed --count 4 >> ~/studio-ingest.log 2>&1
0 9 * * 1  cd <repo>/studio && ~/.local/bin/uv run studio discover --telegram >> ~/studio-discover.log 2>&1
```

**Cutover do pipeline legacy (pendente, critérios no ROADMAP):** 3 vídeos
consecutivos com revisor ≥90 + preferência humana 3/3 + custo ≤$5 + resume
demonstrado + upload verificado. Só depois `pipeline/` → `legacy/`.

**Publicar um run existente:** injeta `"upload": true` em
`data/runs/<id>/run.json` → `params`, apaga o stage `14_upload` de `stages`,
e corre `uv run studio resume <id>`. Ou novo vídeo: `uv run studio run
--topic "..." --upload`.

## Setup

```bash
cd studio
uv sync          # cria .venv com Python 3.12 e instala deps
uv run pytest    # suite completa
```

Credenciais: lê o `.env` da raiz do repositório (partilhado com o pipeline legacy).
Override com `STUDIO_ENV_FILE=/caminho/.env`.

## Uso

```bash
uv run studio run --topic "Lisboa gastronomia" --pipeline dummy   # run novo
uv run studio resume <video_id>                                   # retomar onde falhou
uv run studio status [<video_id>]                                 # estado / lista
uv run studio approve <video_id> <gate> approve|reject            # decisão manual de gate
```

Variáveis úteis: `STUDIO_MOCK=1` (sem serviços externos, gates auto-aprovam),
`STUDIO_DATA_ROOT=...` (artefactos; default `<repo>/data`), `STUDIO_BUDGET_USD=...`.

## Regras de arquitetura (resumo)

- **Fail-closed:** stage sem outputs válidos = run parado. Degradação só por política nomeada.
- **Só o runner grava `run.json`.** Stages mutam `ctx.state`, nunca gravam.
- **Comunicação entre stages só por ficheiros** (diretório por stage + manifest).
- **Prompts em ficheiros versionados** (`prompts/`), nunca inline.
- **IDs de modelo em config** (`STUDIO_MODEL_*`), nunca em código.
