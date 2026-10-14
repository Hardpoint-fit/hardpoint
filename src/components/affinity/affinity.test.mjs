import assert from "node:assert/strict";
import test from "node:test";
import { readProgression } from "./affinity.ts";

const base = { affinityType: "Weapon", affinityXp: 10, allocatedPoints: [1, 2, 3], thresholdSelections: [0] };
const read = (patch) => readProgression({ progression: { ...base, ...patch } });

test("a well-formed progression reads as stored", () => {
  assert.deepEqual(read({}), base);
});

test("malformed stored values read as no progression", () => {
  assert.equal(read({ allocatedPoints: ["1", 2] }), null);
  assert.equal(read({ allocatedPoints: [{ n: 1 }] }), null);
  assert.equal(read({ allocatedPoints: "12" }), null);
  assert.equal(read({ thresholdSelections: [[1]] }), null);
  assert.equal(read({ affinityXp: "500" }), null, "string XP");
  assert.equal(read({ affinityXp: Number.NaN }), null);
  assert.equal(read({ affinityType: 3 }), null);
  assert.equal(readProgression(null), null);
});

test("arrays longer than the layout are cut to its size before anything sums them", () => {
  const huge = Array.from({ length: 5000 }, () => 1);
  const p = read({ allocatedPoints: huge, thresholdSelections: huge });
  assert.ok(p.allocatedPoints.length === 44);
  assert.ok(p.thresholdSelections.length === 88);
  // Only the first slots count; a bad value past the layout does not void the rest.
  const padded = [...Array.from({ length: 44 }, () => 1), "junk"];
  assert.equal(read({ allocatedPoints: padded }).allocatedPoints.length, 44);
});
