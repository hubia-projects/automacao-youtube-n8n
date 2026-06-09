const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs-extra");
const { createPlaceholderImage } = require("../src/utils/mediaUtils");
const { buildLocalLibraryIndex, searchLocalLibrary } = require("../src/utils/localLibrary");

const main = async () => {
  const libraryPath = await fs.mkdtemp(path.join(os.tmpdir(), "local-library-gc-"));
  const imagePath = path.join(libraryPath, "clip-01.jpg");
  const tagPath = path.join(libraryPath, "clip-01.tags.txt");

  await createPlaceholderImage({ outputPath: imagePath, width: 1280, height: 720, seed: 7 });
  await fs.writeFile(tagPath, "people,office,technology,laptop,typing\n", "utf8");

  const payload = await buildLocalLibraryIndex(libraryPath);
  assert.ok(payload.indexPath, "deveria retornar indexPath");
  assert.strictEqual(payload.assets.length, 1, "deveria indexar 1 asset de teste");
  assert.ok(await fs.pathExists(payload.indexPath), "deveria salvar index.json");

  const matches = await searchLocalLibrary(["office", "people"], libraryPath);
  assert.strictEqual(matches.length, 1, "deveria encontrar o asset local pelas tags");
  assert.strictEqual(matches[0].score, 2, "deveria somar score por coincidencia de keyword");
  assert.ok(String(matches[0].path || "").endsWith("clip-01.jpg"), "deveria retornar path absoluto do asset");
  assert.deepStrictEqual(matches[0].tags, ["people", "office", "technology", "laptop", "typing"]);

  console.log("test_assets_GC validado com sucesso");
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});