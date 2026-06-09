const os = require("os");
const path = require("path");

const ensureHostWritableRuntimePaths = () => {
  const baseDir = path.join(os.tmpdir(), "youtube-pipeline-render-strict-runtime-policy-test");
  const fallbackPaths = {
    OUTPUT_ROOT: path.join(baseDir, "output"),
    TEST_REPORTS_ROOT: path.join(baseDir, "reports"),
    CLIP_LIBRARY_DB_PATH: path.join(baseDir, "clip-library.json"),
    SCENE_INDEX_DB_PATH: path.join(baseDir, "scene-index.json"),
    CLIP_LIBRARY_ROOT_DIR: path.join(baseDir, "clip-library"),
    CLIP_LIBRARY_SHADOW_REPORT_DIR: path.join(baseDir, "clip-library-shadow"),
  };

  Object.entries(fallbackPaths).forEach(([envName, fallbackPath]) => {
    process.env[envName] = fallbackPath;
  });
};

ensureHostWritableRuntimePaths();

process.env.QA_RUNTIME_PROFILE_PROD = "prod_strict";
process.env.ALLOW_PLACEHOLDER_ASSETS = "true";
process.env.RUNTIME_DEGRADE_ON_MISSING_ASSETS = "true";

const assert = require("assert");
const { __test__: renderTest } = require("../src/services/renderService");

const strictPolicy = renderTest.resolveRenderRuntimeFallbackPolicy({ mockMode: false });
assert.strictEqual(strictPolicy.strictRenderMode, true, "prod_strict deve ser tratado como render estrito");
assert.strictEqual(strictPolicy.allowRuntimeFallback, false, "render estrito nao deve religar runtime fallback por configuracao global");
assert.strictEqual(strictPolicy.allowPlaceholderAssets, false, "render estrito nao deve aceitar placeholder assets");
assert.strictEqual(strictPolicy.runtimeDegradationEnabled, false, "render estrito nao deve habilitar runtime degradation");

const previewPolicy = renderTest.resolveRenderRuntimeFallbackPolicy({ mockMode: true });
assert.strictEqual(previewPolicy.strictRenderMode, false, "mock mode nao deve ser tratado como publish estrito");
assert.strictEqual(previewPolicy.allowRuntimeFallback, true, "preview/mock pode manter runtime fallback habilitado");

console.log("render-strict-runtime-policy-test ok");