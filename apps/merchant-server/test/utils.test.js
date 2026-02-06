import assert from "node:assert/strict";
import test from "node:test";
import { createSeededRandom } from "../src/utils.js";

const sampleSequence = (seed) => {
  const rng = createSeededRandom(seed);
  return [rng(), rng(), rng()];
};

test("createSeededRandom is deterministic", () => {
  const first = sampleSequence("seed-1");
  const second = sampleSequence("seed-1");
  assert.deepEqual(first, second);
});

test("createSeededRandom changes across seeds", () => {
  const first = sampleSequence("seed-1");
  const second = sampleSequence("seed-2");
  assert.notDeepEqual(first, second);
});
