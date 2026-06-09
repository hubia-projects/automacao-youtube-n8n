const assert = require("assert");
const { __test__ } = require("../src/services/assetsService");

const main = async () => {
  const finalists = Array.from({ length: 5 }, (_, index) => ({
    source_url: `https://example.com/asset-${index + 1}.mp4`,
    slot_scene_index_hint: 1,
    slot_id: `slot_${index + 1}`,
    slot_type: "proof_exact",
    content_need: "proof_exact",
  }));

  let activeDownloads = 0;
  let maxConcurrentDownloads = 0;

  const downloaded = await __test__.downloadCandidatesInBatches({
    finalists,
    activeScenes: [{ scene_index: 1 }],
    representativeScene: { scene_index: 1 },
    seenUrls: new Set(),
    perSceneSequence: new Map(),
    paths: {},
    videoId: "unit-test",
    blockPackage: { block_id: "intro", package_id: "pkg-intro" },
    batchSize: 3,
    downloader: async ({ candidate, sequence }) => {
      activeDownloads += 1;
      maxConcurrentDownloads = Math.max(maxConcurrentDownloads, activeDownloads);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeDownloads -= 1;
      return {
        source_url: candidate.source_url,
        sequence,
      };
    },
  });

  assert.strictEqual(downloaded.length, 5, "deveria processar todos os finalists no helper batchado");
  assert.ok(maxConcurrentDownloads <= 3, "nao deveria exceder 3 downloads simultaneos");
  assert.deepStrictEqual(
    downloaded.map((item) => item.sequence),
    [1, 2, 3, 4, 5],
    "deveria preservar a sequencia atribuida por cena"
  );

  console.log("test_assets_GB validado com sucesso");
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});