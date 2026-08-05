# PRD — Studio v2: Plataforma de Automação de Vídeos para YouTube

**Versão:** 1.0 · **Data:** 2026-07-12 · **Estado:** Em aprovação
**Substitui:** pipeline Node.js (`pipeline/`) — mantido em coexistência até cutover (ver `ROADMAP.md`)

---

## 1. Visão

Uma plataforma onde agentes de IA especializados produzem vídeos de YouTube de qualidade profissional com intervenção humana mínima (2 gates de aprovação). O sistema compreende o que o roteiro pede, compreende o que cada clip realmente mostra, monta com ritmo cinematográfico e **revê o próprio trabalho** antes de qualquer humano ver.

O objetivo não é um editor automático — é um estúdio autónomo.

## 2. Problema

O pipeline atual gera vídeos tecnicamente válidos mas editorialmente fracos:

| Sintoma | Causa raiz (diagnóstico confirmado no código) |
|---|---|
| Narração fala de monumento, vídeo mostra comida | Matching = texto sobre texto (embedding da narração vs descrição LLM do clip); queries geradas por dicionários keyword hardcoded |
| Cenas repetidas, vídeos duplicados | Pool de candidatos faminto: 27 assets para 151 slots, 89% hard-blocked — repetição é estatisticamente inevitável |
| Cortes estranhos, sem ritmo | Sem modelo de pacing; transição única (xfade fixo); duração de cena não relacionada com beat narrativo |
| "Parece gerado por automação" | Sem revisor holístico: ninguém (humano ou IA) vê o vídeo montado antes do upload |
| Impossível de evoluir | ~10.000 linhas de gates/repair a combater sintomas; 3 runners divergentes; fail-open generalizado |

Dezenas de ajustes de prompts e regras não resolveram porque o problema é arquitetural.

## 3. Público e nicho

- **Canal:** viagens, turismo, gastronomia, roteiros, curiosidades, cultura, história, experiências.
- **Idioma:** narração e metadados em PT-BR.
- **Formato v1:** long-form 10–15 minutos, 1080p (4K quando a biblioteca suportar).
- **Cadência:** 2 vídeos/semana no arranque; arquitetura preparada para dezenas/semana.

## 4. Barra de qualidade

"Profissional" definido operacionalmente — um vídeo só publica se:

1. **Coerência narração↔visual:** 100% das cenas mostram o assunto narrado (verificado mecanicamente por metadados + revisor multimodal). Zero tolerância à classe monumento/comida.
2. **Diversidade visual:** nenhum shot repetido no vídeo; ≤3 shots do mesmo ficheiro fonte; cooldown entre vídeos.
3. **Ritmo:** cortes alinhados ao beat da música (±180 ms); duração de shot dentro da banda do beat narrativo; curva de pacing por capítulo.
4. **Áudio:** mix final -14 LUFS ±0.5; ducking dinâmico (sidechain); narração limpa.
5. **Revisor IA ≥ 90/100** na rubrica (coerência, continuidade, pacing, repetição, sync) após no máximo 2 rondas de correção automática.
6. **Aprovação humana final** via Telegram (proxy + relatório do revisor + thumbnail + título).

**Vídeos de referência (barra a atingir):** canais de viagem PT/BR de topo com edição humana — ritmo de corte variado, B-roll sempre relevante à frase narrada, ganchos e open loops, capítulos com payoff. *(Utilizador: adicionar 3–5 URLs concretos de vídeos-referência antes da Fase 3 — usados no prompt de critique do roteiro e na calibração do revisor.)*

## 5. Capacidades (16 etapas do utilizador → fases, prioridade MoSCoW)

| # | Capacidade pedida | Fase | Prioridade | Nota de design |
|---|---|---|---|---|
| 1 | Descoberta automática de temas (trends, YouTube, sazonalidade, concorrência) | 8 | Should | Sinal diferenciador: cobertura da própria biblioteca antes de aprovar tema |
| 2 | Planeamento do vídeo (capítulos, emoção, tempo, ritmo) | 3 | Must | Outline com beats tipados; alimenta pacing na Fase 4 |
| 3 | Roteiro natural, storytelling, retenção | 3 | Must | Multi-pass: research→outline→draft→critique→humanize→lint anti-slop |
| 4 | Áudio multivozes_br + validação + timestamps precisos | 3 | Must | multivozes intocado; faster-whisper local para word timestamps |
| 5 | Divisão em cenas por significado | 3 | Must | Silêncio + frase + tagging LLM de beat |
| 6 | Planeamento visual por cena | 4 | Must | Brief visual estruturado (em inglês, para SigLIP) com must_have/must_not |
| 7 | Busca multimodal multi-fonte (Pexels, Pixabay, CC/domínio público) | 2 | Must | Via biblioteca; yt-dlp só fontes CC verificadas (LIBRARY_POLICY.md) |
| 8 | Biblioteca própria indexada, sem downloads repetidos | 2 | Must | **Inovação central.** Ingestão contínua desacoplada da produção |
| 9 | Análise IA de cada vídeo (objetos, OCR, lugares, comida, movimento) | 2 | Must | Shot-level: PySceneDetect + SigLIP + Gemini Flash vision |
| 10 | Seleção por significado, não keyword | 4 | Must | ANN cross-modal + filtros duros de metadados + rerank |
| 11 | Timeline coerente sem repetição/quebras | 4 | Must | MMR + constraints de uso + fitting a bandas de duração |
| 12 | IA revisora com nota 0–100 e correção automática | 6 | Must | Gemini 2.5 Pro vê o proxy do rough cut; fixes mecânicos; máx 2 iterações. Threshold 90 (não 95 — ver §8) |
| 13 | Pós-produção (Ken Burns, transições, ducking, música, cor) | 5 | Must | FFmpeg filtergraph tipado; sidechain real; LUTs |
| 14 | Revisão final por IA diferente | 6 | Could | Coberto pelo gate humano + rubrica; segunda família de modelo só se métricas mostrarem necessidade |
| 15 | Exportação (thumbnail, título, descrição, capítulos, tags) | 7 | Must | Thumbnail = frame real + template Pillow |
| 16 | Upload YouTube com agendamento/privacidade | 7 | Must | Port do fluxo OAuth comprovado |

## 6. Métricas de sucesso

| Métrica | Alvo | Fonte |
|---|---|---|
| Nota do revisor IA (1ª ronda) | ≥ 85 média; ≥ 90 pós-fixes | `09_review/review_*.json` |
| Cenas com mismatch temático | 0 (verificação mecânica) | teste E2E Fase 4 |
| Custo por vídeo | ≤ $5 (estimado ~$2.50) | cost ledger em `run.json` |
| Tempo humano por vídeo | ≤ 15 min (2 gates) | medição manual |
| Falhas de pipeline recuperáveis por `resume` | 100% | logs de runs |
| Retenção média YouTube (proxy de qualidade, pós-publicação) | tendência crescente vs vídeos do pipeline antigo | YouTube Analytics |

## 7. Non-goals (v1)

- **Shorts / vertical** — só long-form.
- **Multi-idioma / dublagem** — só PT-BR.
- **n8n** — eliminado; orquestração no core.
- **Vídeo generativo (Veo/Sora) como fonte principal** — footage real; generativo só como estudo futuro.
- **Dashboard web** — CLI + Telegram chegam para operador solo; `frontend/` antigo morre.
- **Multi-canal / multi-tenant** — um canal.
- **Edição de faces/pessoas identificáveis em destaque** — evitar por risco de direitos de imagem.

## 8. Decisões que divergem do pedido original (transparência)

1. **Threshold do revisor: 90, não 95.** Rubricas LLM têm variância ±3–5 pontos; exigir 95 gera loops infinitos a perseguir ruído. 90 + gate humano final dá o mesmo resultado sem instabilidade.
2. **"Buscar na Internet/YouTube" restringido a licenças verificáveis.** Download de conteúdo YouTube não-CC viola ToS e direitos de autor. Só fontes com licença registada (ver `LIBRARY_POLICY.md`). Sem exceções no código.
3. **Sem LangGraph/CrewA I como espinha dorsal.** O pipeline é um DAG quase-linear; frameworks de agentes dinâmicos adicionam complexidade sem valor aqui. Agentes de IA existem — mas como stages tipados. (ADR-0001.)
4. **Etapa 14 (segunda IA revisora) rebaixada para Could.** Gate humano + rubrica estruturada cobre; duplicar revisores duplica custo e latência sem evidência de ganho. Reavaliar com dados.

## 9. Restrições

- **Hardware:** GTX 1050 Ti 4 GB VRAM — modelos locais dimensionados (SigLIP-base, whisper large-v3-turbo int8, carga sequencial, fallback CPU).
- **Runtime:** Python 3.12 pinado via uv (sistema tem 3.14, cedo demais para torch/faster-whisper).
- **Orçamento:** $5–15/vídeo; breaker de orçamento por run.
- **Operador:** uma pessoa; tudo tem de ser operável por CLI + Telegram.

## 10. Riscos principais

Ver `ROADMAP.md` §Riscos. Top 3: licenciamento de footage (mitigado por policy fail-closed), cold start da biblioteca (mitigado por seed ≥2.000 shots como critério de saída da Fase 2), instabilidade do loop revisor (mitigado por teto de iterações + vocabulário fechado de fixes + monotonicidade).
