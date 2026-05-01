const { updateState, loadState } = require("../src/services/stateService");
const { generateScript } = require("../src/services/scriptService");
const { generateAudio } = require("../src/services/ttsService");
const { generateAssets } = require("../src/services/assetsService");
const { renderVideo } = require("../src/services/renderService");
const { uploadToYoutube } = require("../src/services/youtubeService");
const { probeMedia } = require("../src/utils/mediaUtils");

const assert = (condition, message) => {
  if (condition) throw new Error(message);
};

// Tema novo: "Segurança na Tecnologia"
const topic = "5 Dicas Essenciais de Segurança Digital em 2026";
const angle = "guia prático com proteção contra hackers, fraudes e vazamento de dados";

const visualPlan = [
  {
    scene_index: 1,
    title: "Ameaças Digitais Modernas",
    narration_excerpt: "O mundo digital está cheio de perigos invisíveis, desde phishing sofisticado até ransomware que pode destruir seus dados em segundos.",
    keywords: ["cybersecurity threat", "hacker attack", "malware virus", "phishing email", "digital crime", "data breach"],
    target_duration_seconds: 8,
  },
  {
    scene_index: 2,
    title: "Senhas Fortes e Autenticação",
    narration_excerpt: "Criar senhas complexas não é suficiente. Use autenticação de dois fatores e gerenciadores de senhas para proteção real.",
    keywords: ["password security", "two factor authentication", "password manager", "digital protection", "login security", "biometric access"],
    target_duration_seconds: 8,
  },
  {
    scene_index: 3,
    title: "Redes Wi-Fi Públicas",
    narration_excerpt: "Redes públicas são campos minados digitais. Use VPN sempre e evite transações bancárias em Wi-Fi desconhecido.",
    keywords: ["public wifi danger", "vpn protection", "network security", "hotspot risk", "encrypted connection", "cyber safety"],
    target_duration_seconds: 8,
  },
  {
    scene_index: 4,
    title: "Proteção de Dispositivos",
    narration_excerpt: "Mantenha tudo atualizado: antivírus, sistemas operacionais e apps. Cada update é uma porta fechada para invasores.",
    keywords: ["antivirus software", "system update", "device security", "malware protection", "cyber defense", "digital shield"],
    target_duration_seconds: 8,
  },
  {
    scene_index: 5,
    title: "Privacidade nas Redes Sociais",
    narration_excerpt: "Configure privacidade máxima, revele o mínimo e pense duas vezes antes de compartilhar informações pessoais online.",
    keywords: ["social media privacy", "data protection", "online safety", "personal information", "digital footprint", "privacy settings"],
    target_duration_seconds: 8,
  },
  {
    scene_index: 6,
    title: "Backup e Recuperação",
    narration_excerpt: "Tenha backup automático na nuvem e físico. Quando o desastre acontecer, você terá seus dados salvos em outro lugar.",
    keywords: ["data backup", "cloud storage", "recovery plan", "data loss prevention", "backup system", "disaster recovery"],
    target_duration_seconds: 8,
  },
  {
    scene_index: 7,
    title: "Futuro da Segurança Digital",
    narration_excerpt: "IA e biometria estão mudando o jogo, mas a educação continua sendo sua melhor defesa contra ameaças digitais.",
    keywords: ["artificial intelligence security", "biometric protection", "future technology", "cyber trends", "digital evolution", "tech security"],
    target_duration_seconds: 7,
  },
];

const scriptText = [
  "O mundo digital evoluiu rapidamente, mas os perigos cresceram na mesma proporção.",
  "Cada clique pode expor seus dados, cada senha pode ser quebrada, cada dispositivo pode ser invadido.",
  "Phishing se tornou sofisticado, hackers usam IA para criar ataques personalizados e ransomware pode parar sua vida.",
  "A primeira linha de defesa começa com senhas fortes: combinações únicas de letras, números e símbolos.",
  "Mas senhas não são suficientes. Autenticação de dois fatores é essencial, transformando uma barreira em duas.",
  "Gerenciadores de senhas criam combinações complexas para cada serviço, eliminando o risco de reutilização.",
  "Redes Wi-Fi públicas são verdadeiros campos minados digitais, onde hackers esperam por dados desprotegidos.",
  "Use VPN sempre, criptografe sua conexão e nunca acesse dados sensíveis em redes desconhecidas.",
  "Mantenha todos os dispositivos atualizados: cada patch de segurança é uma porta fechada para invasores.",
  "Antivírus moderno, firewalls ativos e sistemas operacionais atualizados formam sua muralha digital.",
  "Nas redes sociais, configure privacidade máxima, revele o mínimo necessário e pense antes de postar.",
  "Backup automático é seu seguro contra desastres: nuvem para acesso rápido e físico para emergências.",
  "O futuro trará IA preditiva e biometria avançada, mas a educação continuará sendo sua melhor arma.",
  "Segurança digital não é opção, é necessidade. Proteja hoje para não se arrepender amanhã."
].join(" ");

const run = async () => {
  const videoId = `security_test_${Date.now()}`;

  console.log("🔐 Iniciando teste completo: Segurança Digital 2026");

  // Configurar estado inicial
  await updateState(
    videoId,
    {
      topic,
      angle,
      selected_idea: { topic, angle },
      script_text: scriptText,
      visual_plan: visualPlan,
      youtube_title: "5 Dicas de Segurança Digital Essenciais 2026",
      youtube_description: "Proteja-se contra hackers, fraudes e vazamento de dados com este guia completo de segurança digital.",
      youtube_tags: ["segurança digital", "cibersegurança", "proteção de dados", "hackers", "segurança na internet"],
      approved: false,
      error_message: "",
    },
    {
      currentStep: "script_generated",
      status: "script_generated",
    }
  );

  // Gerar áudio
  console.log("🎙️ Gerando áudio...");
  const audio = await generateAudio({ videoId, mockMode: false, provider: "multivozes" });
  console.log(`✅ Áudio gerado: ${audio.provider} - ${audio.voice}`);

  // Buscar assets
  console.log("🎬 Buscando assets de tecnologia...");
  const assets = await generateAssets({ 
    videoId, 
    mockMode: false, 
    maxAssets: 5,
    minVideoDuration: 8
  });
  
  const externalAssets = (assets.assets_json?.items || []).filter((item) => ["pexels", "pixabay"].includes(item.provider));
  const externalVideoAssets = externalAssets.filter((item) => item.asset_type === "video");
  
  console.log(`📊 Assets disponíveis: ${externalAssets.length} totais, ${externalVideoAssets.length} vídeos`);

  // Renderizar vídeo
  console.log("🎥 Renderizando vídeo com algoritmo aprimorado...");
  await renderVideo({ videoId, mockMode: false });
  
  const stateAfterRender = await loadState(videoId);
  const renderInfo = await probeMedia(stateAfterRender.render_path);
  
  console.log(`✅ Render concluído: ${renderInfo.duration}s @ ${renderInfo.width}x${renderInfo.height}`);

  // Aprovar para upload
  await updateState(
    videoId,
    {
      approved: true,
      error_message: "",
    },
    {
      currentStep: "final_approved",
      status: "final_approved",
    }
  );

  // Upload para YouTube
  console.log("📤 Fazendo upload para YouTube...");
  const upload = await uploadToYoutube({
    videoId,
    mockMode: false,
    privacyStatus: "private",
  });

  const finalState = await loadState(videoId);

  console.log("🎉 FLUXO COMPLETO FINALIZADO!");
  console.log("📊 Estatísticas Finais:");
  console.log(JSON.stringify({
    video_id: videoId,
    youtube_url: upload.youtube_url,
    youtube_video_id: upload.youtube_video_id,
    audio_provider: audio.provider,
    audio_voice: audio.voice,
    external_assets: externalAssets.length,
    external_video_assets: externalVideoAssets.length,
    total_clips: finalState.render_timeline?.total_clips,
    unique_asset_count: finalState.render_timeline?.unique_asset_count,
    output_resolution: finalState.render_timeline?.output_resolution,
    output_duration_seconds: finalState.render_timeline?.output_duration_seconds,
    semantic_alignment_score_average: finalState.render_timeline?.semantic_alignment_score_average,
    low_confidence_clip_count: finalState.render_timeline?.low_confidence_clip_count,
    variety_score: ((finalState.render_timeline?.unique_asset_count || 0) / (finalState.render_timeline?.total_clips || 1) * 100).toFixed(1) + "%",
  }, null, 2));

  console.log("\n🔍 Análise Final:");
  console.log(`- Sync Score: ${finalState.render_timeline?.semantic_alignment_score_average || 'N/A'}`);
  console.log(`- Clips Low Confidence: ${finalState.render_timeline?.low_confidence_clip_count || 0}`);
  console.log(`- Variedade de Assets: ${finalState.render_timeline?.unique_asset_count || 0}/${finalState.render_timeline?.total_clips || 0}`);
  console.log(`- Duração: ${finalState.render_timeline?.output_duration_seconds || 0}s`);
  console.log(`- YouTube: ${upload.youtube_url}`);
};

run().catch((error) => {
  console.error("❌ Falha no teste completo:", error.message);
  console.error(error.stack);
  process.exit(1);
});
