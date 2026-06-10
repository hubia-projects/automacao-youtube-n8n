#!/usr/bin/env node
/**
 * Auto-indexação da biblioteca local com Gemini Flash.
 *
 * Uso:
 *   node src/tools/index-library.js [--force] [--dry-run]
 *
 * --force    Re-analisa arquivos que já têm .meta.json
 * --dry-run  Lista o que seria analisado sem gerar nada
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const { autoIndexLibrary } = require("../services/localLibraryService");
const { hasGemini } = require("../services/geminiService");
const { config } = require("../config/env");

const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");

const formatDuration = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
};

(async () => {
  console.log("\n=== Indexação automática da biblioteca local ===\n");

  if (!config.LOCAL_ASSET_LIBRARY_PATH) {
    console.error("ERRO: LOCAL_ASSET_LIBRARY_PATH não está configurado no .env");
    process.exit(1);
  }

  if (!hasGemini()) {
    console.error("ERRO: GEMINI_API_KEY não está configurado no .env");
    process.exit(1);
  }

  console.log(`Biblioteca: ${config.LOCAL_ASSET_LIBRARY_PATH}`);
  console.log(`Modo: ${dryRun ? "DRY-RUN (sem gravação)" : "REAL"} ${force ? "+ FORCE (re-analisa tudo)" : ""}\n`);

  const started = Date.now();
  let lastPercent = -1;

  const result = await autoIndexLibrary({
    force,
    dryRun,
    onProgress: (current, total, filePath) => {
      const percent = Math.round((current / total) * 100);
      if (percent !== lastPercent) {
        const bar = "█".repeat(Math.floor(percent / 5)) + "░".repeat(20 - Math.floor(percent / 5));
        process.stdout.write(`\r[${bar}] ${percent}% (${current}/${total}) ${path.basename(filePath)}   `);
        lastPercent = percent;
      }
    },
  });

  if (result.error) {
    console.error(`\nERRO: ${result.error}`);
    process.exit(1);
  }

  const elapsed = formatDuration(Date.now() - started);

  if (dryRun) {
    console.log(`\n\nDRY-RUN — arquivos que seriam analisados (${result.wouldAnalyze?.length || 0}):`);
    (result.wouldAnalyze || []).forEach((f) => console.log(`  ${f}`));
    console.log(`\nJá indexados (seriam pulados): ${result.skipped}`);
  } else {
    console.log(`\n\nConcluído em ${elapsed}`);
    console.log(`  ✔ Analisados:  ${result.analyzed}`);
    console.log(`  ⏭ Pulados:     ${result.skipped} (já tinham .meta.json)`);
    console.log(`  ✖ Falhas:      ${result.failed}`);

    if (result.failed > 0) {
      console.log("\nArquivos com falha não geraram .meta.json — verifique os logs acima.");
    }
  }

  console.log();
  process.exit(result.failed > 0 ? 1 : 0);
})();
