const assert = require("assert");
const { __test__: syncValidatorTest } = require("../src/services/syncValidator");
const { __test__: renderQualityTest } = require("../src/services/renderQualityService");

const threshold = {
  maxWrongTopicExposureSec: 2,
  maxP95LagSec: 1,
  minSemanticAlignmentScore: 0.78,
};

const generalBoundaryMetrics = syncValidatorTest.computeQaMetrics({
  samples: [
    {
      timestamp_sec: 38.5,
      expected_topic: "Mercados e Sabores",
      expected_topic_type: "general",
      detected: { location: { city: "Porto" }, neutral: false },
      match: true,
      alignment_score: 0.82,
      reason: "general_topic",
    },
  ],
  hardBoundaries: [
    {
      timestamp_sec: 38,
      expected_topic: "Mercados e Sabores",
      expected_topic_type: "general",
      previous_topic: "Porto",
      previous_topic_type: "city",
    },
  ],
  sampleIntervalSec: 2,
  maxLatencySec: 1,
});

assert.strictEqual(generalBoundaryMetrics.p95_topic_lag_sec, 0, "bloco geral nao deveria gerar lag semantico de troca de cidade");

const generalTopicFailures = syncValidatorTest.detectFailedRanges({
  samples: [
    {
      timestamp_sec: 40,
      expected_topic: "Mercados e Sabores",
      expected_topic_type: "general",
      detected: { location: { city: "Lisboa" }, neutral: false },
      match: true,
      alignment_score: 0.82,
      reason: "general_topic",
      clip_index: 11,
      scene_index: 4,
    },
  ],
  metrics: generalBoundaryMetrics,
  threshold,
});

assert.strictEqual(generalTopicFailures.length, 0, "bloco geral valido nao deveria entrar em regeneration plan");

const noReplacementPlan = syncValidatorTest.identifyClipsForReplacement({
  timeline: {
    clips: [
      {
        clip_index: 11,
        scene_index: 4,
        clip_script_source: "scene_fallback",
        timeline_score: -0.5,
      },
    ],
  },
  visualResult: { failed_ranges: [] },
  issues: [],
});

assert.deepStrictEqual(
  noReplacementPlan,
  { clip_indexes_to_replace: [], scene_indexes_to_refresh: [] },
  "sem issues e sem failed ranges o plano de regeneracao deve ficar vazio"
);

const metadataFallbackIssues = syncValidatorTest.collectTimelineIssues({
  timeline: {
    clips: [
      { clip_index: 1, asset_analysis_provider: "metadata_fallback", clip_script_source: "selected" },
      { clip_index: 2, asset_analysis_provider: "metadata_fallback", clip_script_source: "selected" },
      { clip_index: 3, asset_analysis_provider: "metadata_fallback", clip_script_source: "selected" },
      { clip_index: 4, asset_analysis_provider: "openai_vision", clip_script_source: "selected" },
      { clip_index: 5, asset_analysis_provider: "openai_vision", clip_script_source: "selected" },
    ],
  },
  technical: { issues: [] },
  visual: { metrics: {} },
  diversityScore: 0.8,
});

assert(
  metadataFallbackIssues.some((issue) => issue.type === "metadata_fallback_overuse" && issue.severity === "high"),
  "overuse de metadata_fallback deveria virar issue de QA"
);

const cityMismatchFailures = syncValidatorTest.detectFailedRanges({
  samples: [
    {
      timestamp_sec: 18,
      expected_topic: "Lisboa",
      expected_topic_type: "city",
      detected: { location: { city: "Porto" }, neutral: false },
      match: false,
      alignment_score: 0,
      reason: "wrong_topic",
      clip_index: 5,
      scene_index: 2,
    },
  ],
  metrics: {
    p95_topic_lag_sec: 2,
    wrong_topic_exposure_sec: 2,
  },
  threshold,
});

assert.strictEqual(cityMismatchFailures.length, 1, "troca de cidade errada deve continuar falhando");

assert.strictEqual(
  renderQualityTest.hasUnexpectedSilence([
    { start: 9.248, end: 10.027, duration: 0.779 },
    { start: 18.606, end: 19.371, duration: 0.765 },
  ]),
  false,
  "pausas naturais abaixo de 1s nao deveriam reprovar o render"
);

assert.strictEqual(
  renderQualityTest.hasUnexpectedSilence([
    { start: 12.4, end: 13.6, duration: 1.2 },
  ]),
  true,
  "silencio longo ainda deve ser detectado"
);

const hardBoundaryFail = syncValidatorTest.evaluateHardBoundaryDeterministic({
  clips: [
    {
      clip_index: 7,
      timeline_start_sec: 12,
      timeline_end_sec: 14,
      detected_location: { city: "" },
      neutral_fallback: true,
    },
  ],
  hardBoundaries: [
    {
      boundary_id: "hb_002_porto",
      timestamp_sec: 12,
      expected_topic: "Porto",
      expected_topic_type: "city",
      chapter_card_required: true,
    },
  ],
  overlays: [],
  maxLagSec: 0.5,
  requireLocation: true,
  forbidNeutralFirstClip: true,
  requireChapterOverlay: true,
});

assert.strictEqual(hardBoundaryFail.status, "fail", "hard boundary com clip neutro deveria falhar");
assert(
  hardBoundaryFail.violations.some((item) => item.violations.includes("neutral_first_clip_forbidden")),
  "falha deveria marcar neutral_first_clip_forbidden"
);

const hardBoundaryPass = syncValidatorTest.evaluateHardBoundaryDeterministic({
  clips: [
    {
      clip_index: 8,
      timeline_start_sec: 12,
      timeline_end_sec: 14,
      detected_location: { city: "Porto" },
      neutral_fallback: false,
    },
  ],
  hardBoundaries: [
    {
      boundary_id: "hb_002_porto",
      timestamp_sec: 12,
      expected_topic: "Porto",
      expected_topic_type: "city",
      chapter_card_required: true,
    },
  ],
  overlays: [
    {
      type: "chapter_card_clip",
      start_seconds: 12,
    },
  ],
  maxLagSec: 0.5,
  requireLocation: true,
  forbidNeutralFirstClip: true,
  requireChapterOverlay: true,
});

assert.strictEqual(hardBoundaryPass.status, "pass", "hard boundary válido deveria passar");

console.log("sync validator para blocos gerais validado com sucesso");