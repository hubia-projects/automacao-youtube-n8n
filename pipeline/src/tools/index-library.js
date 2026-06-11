#!/usr/bin/env node
/**
 * Auto-indexação da biblioteca local com visão LLM (Gemini Flash / OpenAI).
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
const { config } = require("../config/env");

const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");

(async () => {
  console.log("\n=== Indexação automática da biblioteca local ===\n");

  if (!config.LOCAL_ASSET_LIBRARY_PATH) {
    console.error("ERRO: LOCAL_ASSET_LIBRARY_PATH não está configurado no .env");
    process.exit(1);
  }

  console.log(`Biblioteca: ${config.LOCAL_ASSET_LIBRARY_PATH}`);
  console.log(`Modo: ${dryRun ? "DRY-RUN (sem gravação)" : "REAL"}${force ? " + FORCE (re-analisa tudo)" : ""}\n`);

  const started = Date.now();

  const result = await autoIndexLibrary({
    force,
    dryRun,
    onProgress: (current, total, filePath) => {
      process.stdout.write(`\r(${current}/${total}) ${path.basename(filePath)}                    `);
    },
  });

  if (result.error) {
    console.error(`\nERRO: ${result.error}`);
    process.exit(1);
  }

  const elapsedSeconds = Math.round((Date.now() - started) / 1000);

  if (dryRun) {
    console.log(`\nDRY-RUN — arquivos que seriam analisados (${result.wouldAnalyze?.length || 0}):`);
    (result.wouldAnalyze || []).forEach((f) => console.log(`  ${f}`));
    console.log(`\nJá indexados (seriam pulados): ${result.skipped}`);
  } else {
    console.log(`\n\nConcluído em ${elapsedSeconds}s`);
    console.log(`  Analisados: ${result.analyzed}`);
    console.log(`  Pulados:    ${result.skipped} (já tinham .meta.json)`);
    console.log(`  Falhas:     ${result.failed}`);
  }

  console.log();
  process.exit(result.failed > 0 ? 1 : 0);
})();
