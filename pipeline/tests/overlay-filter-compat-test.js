const assert = require("assert");
const { buildOverlayFilter } = require("../src/services/overlayService");

const filter = buildOverlayFilter({
  overlays: [
    {
      start_seconds: 0,
      end_seconds: 2.5,
      text: "Capitulo 1",
    },
  ],
  videoWidth: 1920,
  videoHeight: 1080,
});

assert(filter.includes("drawbox="), "filter deve conter drawbox");
assert(filter.includes("drawtext="), "filter deve conter drawtext");
assert(!filter.includes("iw*"), "filter nao deve usar iw");
assert(!filter.includes("ih*"), "filter nao deve usar ih");
assert(/x=\d+/.test(filter), "x deve ser coordenada fixa");
assert(/y=\d+/.test(filter), "y deve ser coordenada fixa");

console.log("overlay-filter-compat-test ok");

