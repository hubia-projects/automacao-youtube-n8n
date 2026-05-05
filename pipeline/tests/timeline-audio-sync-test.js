const assert = require("assert");
const { __test__ } = require("../src/services/timelinePlanner");

const words = [
  { word: "Lisboa", start: 0, end: 0.4 },
  { word: "tem", start: 0.4, end: 0.6 },
  { word: "cafes", start: 0.6, end: 1.0 },
  { word: "historicos", start: 1.0, end: 1.5 },
  { word: "Porto", start: 1.5, end: 2.0 },
  { word: "tem", start: 2.0, end: 2.2 },
  { word: "mercados", start: 2.2, end: 2.6 },
  { word: "e", start: 2.6, end: 2.7 },
  { word: "vinho", start: 2.7, end: 3.1 },
];

const excerpt = __test__.getNarrationTextBetween({
  words,
  startSeconds: 2.1,
  endSeconds: 3.0,
  fallback: "fallback scene text",
});
assert.strictEqual(excerpt, "tem mercados e vinho", "deveria usar o texto real do intervalo de audio");

const fallback = __test__.getNarrationTextBetween({
  words: [],
  startSeconds: 2.1,
  endSeconds: 3.0,
  fallback: "fallback scene text",
});
assert.strictEqual(fallback, "fallback scene text", "deveria cair para fallback sem quebrar");

console.log("timeline audio sync helper validado com sucesso");
