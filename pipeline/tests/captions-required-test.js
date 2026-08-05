#!/usr/bin/env node
/**
 * PARTE 7 — Teste: Captions e Overlays — devem falhar se não aplicarem
 *
 * Regras testadas:
 * - buildBlockOverlays gera overlays para hard_boundaries
 * - buildBlockOverlays não gera overlay para blocos sem overlay_title
 * - buildBlockOverlays suprime overlay se clip for de cidade diferente
 * - overlays incluem chapter_card_clip para boundaries
 * - overlays não geram tipo errado para blocos sem hard_boundary
 */

const { buildBlockOverlays } = require("../src/services/overlayService");
const assert = require("assert");

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}: ${error.message}`);
    failed++;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// buildBlockOverlays
// ═══════════════════════════════════════════════════════════════════════════

test("buildBlockOverlays: gera overlay para capítulo com hard_boundary", () => {
  const overlays = buildBlockOverlays({
    narrativeBlocks: [
      {
        id: "block_intro",
        block_id: "intro",
        topic: "Portugal gastronómico",
        overlay_title: "Portugal Gastronómico",
        start_sec: 0,
        role: "intro",
      },
      {
        id: "block_lisboa",
        block_id: "lisboa",
        topic: "Lisboa",
        overlay_title: "Lisboa",
        start_sec: 120,
        hard_boundary: true,
        expected_location: "Lisboa",
        role: "body",
      },
    ],
    clips: [
      { timeline_start_sec: 0, macro_block_id: "intro", location: { city: "" }, detected_location: {} },
      { timeline_start_sec: 120, macro_block_id: "lisboa", location: { city: "Lisboa" }, detected_location: { city: "Lisboa" } },
    ],
    enabled: true,
    requireChapterOverlay: true,
  });

  assert(overlays.length >= 1, `Deve gerar overlays: ${overlays.length}`);
  const chapterOverlay = overlays.find((o) => o.type === "chapter_card_clip");
  assert(chapterOverlay, "Deve ter chapter_card_clip");
  assert(chapterOverlay.text === "Lisboa",
    `Texto do overlay: "${chapterOverlay.text}"`);
});

test("buildBlockOverlays: bloco sem overlay_title não gera overlay", () => {
  const overlays = buildBlockOverlays({
    narrativeBlocks: [
      {
        id: "block_1",
        block_id: "body_1",
        topic: "Comida",
        overlay_title: "",
        start_sec: 60,
        hard_boundary: true,
        role: "body",
      },
    ],
    clips: [
      { timeline_start_sec: 60, macro_block_id: "body_1", location: { city: "" }, detected_location: {} },
    ],
    enabled: true,
    requireChapterOverlay: false,
  });

  // Sem overlay_title, não deve gerar overlay
  assert(overlays.length === 0, `Não deve gerar overlays sem título: ${overlays.length}`);
});

test("buildBlockOverlays: overlays desligados → array vazio", () => {
  const overlays = buildBlockOverlays({
    narrativeBlocks: [
      {
        id: "block_1",
        block_id: "body_1",
        topic: "Lisboa",
        overlay_title: "Lisboa",
        start_sec: 0,
        hard_boundary: true,
      },
    ],
    clips: [],
    enabled: false,
  });

  assert(Array.isArray(overlays), "Deve retornar array");
  assert(overlays.length === 0, "Overlays desligados devem retornar vazio");
});

test("buildBlockOverlays: suprime overlay se clip de cidade diferente", () => {
  const overlays = buildBlockOverlays({
    narrativeBlocks: [
      {
        id: "block_porto",
        block_id: "porto",
        topic: "Porto",
        overlay_title: "Porto",
        start_sec: 180,
        hard_boundary: true,
        expected_location: "Porto",
        role: "body",
      },
    ],
    clips: [
      {
        timeline_start_sec: 180,
        macro_block_id: "porto",
        location: { city: "Lisboa" },
        detected_location: { city: "Lisboa" },
      },
    ],
    enabled: true,
    requireChapterOverlay: true,
  });

  // Clip de Lisboa não deve ter overlay "Porto"
  const portoOverlays = overlays.filter((o) => o.text === "Porto");
  assert(portoOverlays.length === 0,
    `Overlay "Porto" deve ser suprimido sobre clip de Lisboa: ${portoOverlays.length}`);
});

test("buildBlockOverlays: primeiro bloco com título gera block_title", () => {
  const overlays = buildBlockOverlays({
    narrativeBlocks: [
      {
        id: "block_intro",
        block_id: "intro",
        topic: "Portugal gastronómico",
        overlay_title: "Portugal Gastronómico",
        start_sec: 0,
        role: "intro",
      },
    ],
    clips: [
      { timeline_start_sec: 0, macro_block_id: "intro", location: {}, detected_location: {} },
    ],
    enabled: true,
    requireChapterOverlay: false,
  });

  assert(overlays.length >= 1, "Primeiro bloco com título deve gerar overlay");
  assert(overlays[0].type === "block_title" || overlays[0].type === "chapter_card_clip",
    `Tipo: "${overlays[0].type}"`);
});

test("buildBlockOverlays: overlays têm start_seconds e end_seconds", () => {
  const overlays = buildBlockOverlays({
    narrativeBlocks: [
      {
        id: "block_1",
        block_id: "lisboa",
        topic: "Lisboa",
        overlay_title: "Lisboa",
        start_sec: 90,
        hard_boundary: true,
        expected_location: "Lisboa",
        role: "body",
      },
    ],
    clips: [
      { timeline_start_sec: 90, macro_block_id: "lisboa", location: { city: "Lisboa" }, detected_location: {} },
    ],
    enabled: true,
    requireChapterOverlay: true,
  });

  assert(overlays.length >= 1, "Deve gerar overlay");
  const overlay = overlays[0];
  assert(typeof overlay.start_seconds === "number", "start_seconds deve ser número");
  assert(typeof overlay.end_seconds === "number", "end_seconds deve ser número");
  assert(overlay.end_seconds > overlay.start_seconds,
    `end_seconds (${overlay.end_seconds}) > start_seconds (${overlay.start_seconds})`);
});

// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n=== Resultado: ${passed} passaram, ${failed} falharam ===`);
process.exit(failed > 0 ? 1 : 0);
