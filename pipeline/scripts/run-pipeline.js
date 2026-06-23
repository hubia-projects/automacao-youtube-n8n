#!/usr/bin/env node
/**
 * Script de execução do pipeline completo com retry de roteiro e upload YouTube.
 */

const { v4: uuidv4 } = require("uuid");
const { updateState, loadState } = require("../src/services/stateService");
const { generateScript } = require("../src/services/scriptService");
const { generateAudio } = require("../src/services/ttsService");
const { generateAssets } = require("../src/services/assetsService");
const { renderVideo } = require("../src/services/renderService");
const { validateRender } = require("../src/services/syncValidator");
const { uploadToYoutube } = require("../src/services/youtubeService");

const topic = process.env.TOPIC || "Porto em 3 Dias: Roteiro Completo pela Ribeira, Vinho do Porto e Monumentos Históricos";
const angle = process.env.ANGLE || "roteiro narrativo turístico com foco em pontos históricos, gastronomia local e dicas práticas de viagem";
const videoId = process.env.VIDEO_ID || `run_${Date.now()}`;
const MIN_WORDS = 1200;
const MIN_DURATION_SEC = 400;

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const countWords = (text = "") => String(text || "").trim().split(/\s+/).filter(Boolean).length;

const run = async () => {
  log(`🎬 Iniciando pipeline — videoId: ${videoId}`);
  log(`📌 Tópico: ${topic}`);

  // 1. Inicializar estado
  await updateState(
    videoId,
    {
      ideas: [{ topic, angle, idea_id: uuidv4(), scores: {}, notes: "", total_score: 80 }],
      status: "idea_approved",
      current_step: "idea_approved",
      selected_idea: { topic, angle },
      approved: false,
      error_message: "",
      topic,
      angle,
    },
    { status: "idea_approved", currentStep: "idea_approved" }
  );

  // 2. Roteiro com retry até atingir word count mínimo
  let wordCount = 0;
  let attempts = 0;
  const maxAttempts = 3;
  while (wordCount < MIN_WORDS && attempts < maxAttempts) {
    attempts++;
    log(`📝 Gerando roteiro (tentativa ${attempts}/${maxAttempts})...`);
    await generateScript({ videoId, mockMode: false, topic });
    const afterScript = await loadState(videoId);
    wordCount = countWords(afterScript.script_text || "");
    const sceneCount = Array.isArray(afterScript.visual_plan) ? afterScript.visual_plan.length : 0;
    log(`   Roteiro: ${wordCount} palavras, ${sceneCount} cenas`);
    if (wordCount < MIN_WORDS) {
      log(`   ⚠️  Abaixo do mínimo (${MIN_WORDS}). Tentando novamente...`);
    }
  }
  log(`✅ Roteiro aceito: ${wordCount} palavras`);

  // 3. Áudio
  log("🎙️ Gerando áudio (MultiVozes)...");
  const audio = await generateAudio({ videoId, mockMode: false, provider: "multivozes" });
  log(`✅ Áudio: ${audio.provider} — ${Math.round(audio.duration_seconds || 0)}s`);

  if ((audio.duration_seconds || 0) < MIN_DURATION_SEC) {
    throw new Error(`Áudio muito curto: ${Math.round(audio.duration_seconds)}s < ${MIN_DURATION_SEC}s mínimo. Aumente o roteiro.`);
  }

  // 4. Assets
  log("🎬 Buscando e baixando assets...");
  const assets = await generateAssets({ videoId, mockMode: false });
  const items = assets.assets_json?.items || [];
  log(`✅ Assets: ${items.length} total, ${items.filter(i => i.asset_type === "video").length} vídeos`);

  // 5. Render
  log("🎞️ Renderizando vídeo...");
  await renderVideo({ videoId, mockMode: false });
  const afterRender = await loadState(videoId);
  log(`✅ Render: ${afterRender.render_path}`);

  // 6. QA
  log("🔍 Validando sincronização...");
  const validation = await validateRender({ videoId, mockMode: false }).catch(e => ({ ok: false, error: e.message }));
  log(`✅ QA: publishable=${validation.is_publishable} | issues=${(validation.issues || []).length}`);

  // 7. Análise de dedup
  const finalState = await loadState(videoId);
  const clips = finalState.render_timeline?.clips || [];
  if (clips.length) {
    const counts = {};
    clips.forEach(c => {
      const key = (c.asset_window_key || '').split('/').pop()?.split(':')[0] || c.asset_id || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    log(`📊 Clips: ${clips.length} total, ${sorted.length} únicos, max ${sorted[0]?.[1] || 0}×`);
  }

  // 8. Upload YouTube
  if (validation.is_publishable) {
    log("📤 Fazendo upload para o YouTube...");
    await updateState(videoId, { approved: true }, {});
    const upload = await uploadToYoutube({ videoId, mockMode: false });
    log(`✅ YouTube: ${upload.youtube_url || upload.video_url || JSON.stringify(upload)}`);
  } else {
    const issues = (validation.issues || []).map(i => `${i.type}(${i.severity})`).join(', ');
    log(`⚠️  QA bloqueou upload: ${issues}`);
    log(`   Render: ${finalState.render_path}`);
  }

  log(`\n🏁 Pipeline concluído — ${videoId}`);
};

run().catch(err => {
  console.error("❌ Pipeline falhou:", err.stack || err.message);
  process.exit(1);
});
